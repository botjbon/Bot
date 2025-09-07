import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { filterTokensByStrategy } from './bot/strategy';
import { createClient } from 'redis';
import { normalizeStrategy } from './utils/strategyNormalizer';
import { registerBuyWithTarget } from './bot/strategy';
import { extractTradeMeta } from './utils/tradeMeta';
import { unifiedBuy } from './tradeSources';
import { fetchDexScreenerTokens, fetchSolanaFromCoinGecko, normalizeMintCandidate } from './utils/tokenUtils';
// Small set of addresses we should never treat as token mints when scanning quick sources
const KNOWN_NON_MINT_ADDRESSES = new Set<string>([
  '11111111111111111111111111111111', // system program
  'So11111111111111111111111111111111111111112', // wrapped SOL sentinel often shown in dexscreener samples
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token program
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo program
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s' // Metaplex metadata program
]);
// RULES and DENY set copied from terminal scripts to apply strict per-program filtering
export const SCRIPTS_RULES: Record<string, { allow: string[] }> = {
  // More aggressive strictness: default NO 'swap' allowed.
  default: { allow: ['initialize','pool_creation'] },
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': { allow: ['initialize'] },
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': { allow: [] },
  // Only JUP is allowed to report swaps (router aggregator).
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': { allow: ['pool_creation','swap'] },
  // AMM programs: allow pool creation and swaps (trusted)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': { allow: ['pool_creation','swap'] },
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': { allow: ['pool_creation','swap'] },
  // Treat others as quiet / no allowed events unless initialize/pool
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': { allow: ['swap'] },
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': { allow: ['swap'] },
  '11111111111111111111111111111111': { allow: ['swap'] },
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin': { allow: ['pool_creation','initialize'] },
  '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp': { allow: [] },
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu': { allow: ['swap'] }
};

export const SCRIPTS_DENY: Set<string> = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
]);
import { JUPITER_QUOTE_API, HELIUS_RPC_URL, SOLSCAN_API_URL, HELIUS_PARSE_HISTORY_URL, HELIUS_API_KEY, getHeliusApiKey, getSolscanApiKey } from './config';
import { getCoinData as getPumpData } from './pump/api';
import { withTimeout, createLimiter, makeSourceMeta, SourceMeta, getHostLimiter, retryWithBackoff, TTLCache } from './utils/enrichHelpers';
import { compareSourcesForCache, printEquivalenceReport } from './utils/sourceEquivalence';
import { existsSync, mkdirSync } from 'fs';
import fs from 'fs';
const fsp = fs.promises;
import { saveUsers, writeJsonFile } from './bot/helpers';
import path from 'path';

type UsersMap = Record<string, any>;

// Redis-based dedupe for short-lived processing (optional, requires REDIS_URL)
let __redisClient: any = null;
async function getRedisClient() {
  if (__redisClient) return __redisClient;
  try {
  const url = process.env.REDIS_URL || process.env.REDIS_URI || undefined;
  // If no explicit Redis URL is provided, avoid attempting to connect to localhost
  // (createClient() with no url will try localhost and may block if Redis is not available).
  if (!url) return null;
  const client = createClient({ url });
  client.on('error', (e: any) => {});
  await client.connect();
  __redisClient = client;
  return __redisClient;
  } catch (e) {
    __redisClient = null;
    return null;
  }
}

async function isProcessedGlobal(key: string) {
  try {
    const c = await getRedisClient();
    if (!c) return false;
    const v = await c.get(`mint:processed:${key}`);
    return !!v;
  } catch (e) { return false; }
}

async function markProcessedGlobal(key: string, ttlSec = 60) {
  try {
    const c = await getRedisClient();
    if (!c) return false;
    await c.setEx(`mint:processed:${key}`, Math.max(1, Math.floor(ttlSec)), '1');
    return true;
  } catch (e) { return false; }
}

const DEXBOOSTS = process.env.DEXSCREENER_API_ENDPOINT || 'https://api.dexscreener.com/token-boosts/latest/v1';

export function hashTokenAddress(addr: string) {
  return String(addr || '').toLowerCase().trim();
}

// Enforce listener-only safe mode: when true, avoid making outbound HTTP calls
// (DexScreener / CoinGecko boosts) and avoid disk-based fallbacks for sent_tokens.
// Controlled via env LISTENER_ONLY_MODE or LISTENER_ONLY. Default to true.
const LISTENER_ONLY_MODE = String(process.env.LISTENER_ONLY_MODE ?? process.env.LISTENER_ONLY ?? 'true').toLowerCase() === 'true';

async function ensureSentDir() {
  const sent = path.join(process.cwd(), 'sent_tokens');
  try {
    await fsp.mkdir(sent, { recursive: true });
  } catch {}
  return sent;
}

export async function readSentHashes(userId: string): Promise<Set<string>> {
  try {
    // Prefer Redis set when available for cross-process dedupe and performance
    try {
      const rc = await getRedisClient();
      if (rc) {
        const key = `sent_tokens:${userId}`;
        const members = await rc.sMembers(key).catch(() => []);
        return new Set((members || []).map((m: any) => String(m)));
      }
    } catch (e) {
      // fall through to file-based fallback
    }
    // In listener-only mode we must not read disk-based central caches. Use in-memory fallback instead.
    if (LISTENER_ONLY_MODE) {
      try {
        if (!(global as any).__inMemorySentTokens) (global as any).__inMemorySentTokens = new Map<string, Set<string>>();
        const store: Map<string, Set<string>> = (global as any).__inMemorySentTokens;
        return new Set(Array.from(store.get(userId) || []));
      } catch (e) { return new Set(); }
    }
    const sentDir = await ensureSentDir();
    const file = path.join(sentDir, `${userId}.json`);
    const stat = await fsp.stat(file).catch(() => false);
    if (!stat) return new Set();
    const data = JSON.parse(await fsp.readFile(file, 'utf8')) as any[];
    return new Set((data || []).map(d => d.hash).filter(Boolean));
  } catch (e) {
    return new Set();
  }
}

export async function appendSentHash(userId: string, hash: string) {
  try {
    // Prefer Redis-backed set when available
    try {
      const rc = await getRedisClient();
      if (rc) {
        const key = `sent_tokens:${userId}`;
        try {
          await rc.sAdd(key, String(hash));
          // set TTL if configured (default 30 days)
          const ttl = Number(process.env.SENT_TOKENS_TTL_SEC || 60 * 60 * 24 * 30);
          if (ttl > 0) await rc.expire(key, Math.max(1, Math.floor(ttl)) ).catch(() => {});
        } catch (e) {}
        return;
      }
    } catch (e) {
      // fall through to file-based fallback
    }
    // In listener-only mode avoid writing disk-based sent_tokens. Use in-memory Map fallback.
    if (LISTENER_ONLY_MODE) {
      try {
        if (!(global as any).__inMemorySentTokens) (global as any).__inMemorySentTokens = new Map<string, Set<string>>();
        const store: Map<string, Set<string>> = (global as any).__inMemorySentTokens;
        if (!store.has(userId)) store.set(userId, new Set<string>());
        store.get(userId)!.add(String(hash));
        return;
      } catch (e) { return; }
    }
    const sentDir = await ensureSentDir();
    const file = path.join(sentDir, `${userId}.json`);
    let arr: any[] = [];
    try {
      const stat = await fsp.stat(file).catch(() => false);
      if (stat) {
        arr = JSON.parse(await fsp.readFile(file, 'utf8')) || [];
      }
    } catch {}
    arr.push({ hash, time: Date.now() });
    // write atomically via helper queue
    await writeJsonFile(file, arr.slice(-500)).catch(() => {});
  } catch (e) {}
}

/**
 * Start fast polling of DexScreener boosts endpoint and prioritize users flagged in their strategy.
 * Prioritized users: user.strategy.priority === true or user.strategy.priorityRank > 0
 */
export function startFastTokenFetcher(users: UsersMap, telegram: any, options?: { intervalMs?: number }) {
  const intervalMs = options?.intervalMs || 1000;
  const perUserLimit = (options as any)?.perUserLimit || 1; // max messages per interval
  const batchLimit = (options as any)?.batchLimit || 20; // tokens per user per interval
  let running = true;

  const lastSent: Map<string, number> = new Map();

  async function loop() {
    while (running) {
      try {
        // Fetch & filter tokens for all users using shared cache
        const perUserTokens = await fetchAndFilterTokensForUsers(users, { limit: 200, force: false });

        // Build prioritized list ordered by priorityRank desc then priority boolean
        const priorityUsers = Object.keys(users)
          .filter(uid => {
            const u = users[uid];
            return u && u.strategy && (u.strategy.priority === true || (u.strategy.priorityRank && u.strategy.priorityRank > 0));
          })
          .sort((a, b) => ( (users[b].strategy?.priorityRank || 0) - (users[a].strategy?.priorityRank || 0) ));

        // First process priority users, then regular users
        const processOrder = [...priorityUsers, ...Object.keys(users).filter(u => !priorityUsers.includes(u))];

        for (const uid of processOrder) {
          try {
            const u = users[uid];
            if (!u || !u.strategy || u.strategy.enabled === false) continue;
            const matches = perUserTokens[uid] || [];
            if (!matches.length) continue;

            // rate limiting: allow perUserLimit messages per interval
            const last = lastSent.get(uid) || 0;
            if (Date.now() - last < intervalMs * (perUserLimit)) {
              // skip this user this iteration
              continue;
            }

            // limit tokens per user per interval
            const tokensToSend = matches.slice(0, batchLimit);

            // Filter out tokens already sent (sent hashes)
            const sent = await readSentHashes(uid);
            const filtered = tokensToSend.filter(t => {
              const addr = t.tokenAddress || t.address || t.mint || t.pairAddress || '';
              const h = hashTokenAddress(addr);
              return addr && !sent.has(h);
            });
            if (!filtered.length) continue;

            // Send notifications in a batch (one message with multiple tokens or multiple messages)
            for (const token of filtered) {
              const addr = token.tokenAddress || token.address || token.mint || token.pairAddress || '';
              const h = hashTokenAddress(addr);
              try {
                const msg = `🚀 Token matched: ${token.description || token.name || addr}\nAddress: ${addr}`;
                await telegram.sendMessage(uid, msg);
                await appendSentHash(uid, h);
              } catch (e) {
                // ignore send errors per token
              }
            }

            // Optionally auto-buy for users with autoBuy enabled
            if (u.strategy.autoBuy !== false && Number(u.strategy.buyAmount) > 0) {
                    for (const token of filtered) {
                const addr = token.tokenAddress || token.address || token.mint || token.pairAddress || '';
                try {
                  const finalStrategy = normalizeStrategy(u.strategy);
                  const finalOk = await (require('./bot/strategy').filterTokensByStrategy([token], finalStrategy, { preserveSources: true }));
                  if (!finalOk || finalOk.length === 0) continue;
                  const amount = Number(u.strategy.buyAmount);
                  const result = await unifiedBuy(addr, amount, u.secret);
                  if (result && ((result as any).tx || (result as any).success)) {
                    try { await registerBuyWithTarget(u, { address: addr, price: token.price || token.priceUsd }, result, u.strategy.targetPercent || 10); } catch {}
                    const { fee, slippage } = extractTradeMeta(result, 'buy');
                    u.history = u.history || [];
                    const resTx = (result as any)?.tx ?? '';
                    u.history.push(`AutoBuy: ${addr} | ${amount} SOL | Tx: ${resTx} | Fee: ${fee ?? 'N/A'} | Slippage: ${slippage ?? 'N/A'}`);
                    try { saveUsers(users); } catch {}
                    // notify user about executed buy
                    try { await telegram.sendMessage(uid, `✅ AutoBuy executed for ${addr}\nTx: ${resTx}`); } catch {}
                    }
                } catch (e) {
                  // ignore per-token buy errors
                }
              }
            }

            lastSent.set(uid, Date.now());
          } catch (e) {
            // per-user loop error: continue
            continue;
          }
        }

      } catch (err) {
        // ignore fetch loop errors
      }
      await sleep(intervalMs);
    }
  }

  loop();

  return {
    stop: () => { running = false; }
  };
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

// Defensive helpers
function safeStringSnippet(v: any, n = 200) {
  try {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.slice(0, n);
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s.slice(0, n) : String(s).slice(0, n);
  } catch (e) { try { return String(v).slice(0, n); } catch { return ''; } }
}
function safeArraySlice<T>(arr: any, start?: number, end?: number): T[] {
  try {
    if (!arr) return [];
    if (!Array.isArray(arr)) return [];
    if (start === undefined && end === undefined) return arr.slice();
    if (end === undefined) return arr.slice(start);
    return arr.slice(start, end);
  } catch (e) { return [] as T[]; }
}

// =========================
// New: fetch and filter tokens per-user
// =========================
let __global_fetch_cache: any[] = [];
let __global_fetch_ts = 0;
const __GLOBAL_FETCH_TTL = 1000 * 60 * 1; // 1 minute default

// Helper: canonicalize and merge array of token-like objects into a deduped array keyed by normalized mint/address
export function mergeAndCanonicalizeCache(arr: any[]): any[] {
  try {
    const tu = require('./utils/tokenUtils');
    const map: Record<string, any> = {};
    const fieldsToCoerce = ['marketCap', 'liquidity', 'volume', 'priceUsd', 'ageMinutes', 'ageSeconds'];
  for (const raw of arr || []) {
      try {
        const addrRaw = raw && (raw.tokenAddress || raw.address || raw.mint || raw.pairAddress || (raw.token && raw.token.address) || null);
        const addr = tu.normalizeMintCandidate(addrRaw);
        if (!addr) continue;
        const existing = map[addr] || { tokenAddress: addr, address: addr, mint: addr, sourceTags: [] };
        // merge conservative: prefer existing non-empty values, for numeric fields take max when both present
        const preferList = ['name','symbol','url','imageUrl','logoURI','pairAddress'];
        for (const k of preferList) {
          if (!existing[k] && raw[k]) existing[k] = raw[k];
          else if (!existing[k] && raw.token && raw.token[k]) existing[k] = raw.token[k];
        }
        // numeric fields: coerce and prefer max
        for (const k of fieldsToCoerce) {
          const v1 = existing[k];
          let v2 = raw[k] !== undefined ? raw[k] : (raw.token && raw.token[k] !== undefined ? raw.token[k] : undefined);
          if (typeof v2 === 'string' && !isNaN(Number(v2))) v2 = Number(v2);
          if (typeof v1 === 'number' && typeof v2 === 'number') existing[k] = Math.max(v1, v2);
          else if ((v1 === undefined || v1 === null) && (v2 !== undefined && v2 !== null)) existing[k] = v2;
        }
        // merge arbitrary remaining keys conservatively
        for (const k of Object.keys(raw)) {
          if (k === 'token' || k === 'pair') continue;
          if (existing[k] === undefined || existing[k] === null || existing[k] === '') existing[k] = raw[k];
        }
        if (raw.token && typeof raw.token === 'object') {
          for (const k of Object.keys(raw.token)) {
            if (existing[k] === undefined || existing[k] === null || existing[k] === '') existing[k] = raw.token[k];
          }
        }
        // unify sourceTags
        existing.sourceTags = Array.isArray(existing.sourceTags) ? existing.sourceTags : (existing.sourceTags ? [existing.sourceTags] : []);
        if (raw.sourceTags) {
          const incoming = Array.isArray(raw.sourceTags) ? raw.sourceTags : [raw.sourceTags];
          for (const s of incoming) if (s && !existing.sourceTags.includes(s)) existing.sourceTags.push(s);
        }
        // preserve structured per-source raw objects (if present) under __sources for provenance
        existing.__sources = Array.isArray(existing.__sources) ? existing.__sources : (existing.__sources ? [existing.__sources] : []);
        if (raw.__sources) {
          const incoming = Array.isArray(raw.__sources) ? raw.__sources : [raw.__sources];
          for (const src of incoming) {
            try {
              // avoid duplicates by shallow comparing source name+host+type if available
              const id = (src && (src.name || src.source || src.host || src.type)) || JSON.stringify(src || {});
              const dup = existing.__sources.find((s: any) => { try { return (s && (s.name || s.source || s.host || s.type)) === (src && (src.name || src.source || src.host || src.type)); } catch (e) { return false; } });
              if (!dup) existing.__sources.push(src);
            } catch (e) {}
          }
        }
        // try to set poolOpenTimeMs/ageSeconds from known aliases
        if (!existing.poolOpenTimeMs) existing.poolOpenTimeMs = raw.poolOpenTimeMs || raw.poolOpenTime || (raw.token && raw.token.poolOpenTime) || null;
        if (!existing.ageSeconds) existing.ageSeconds = raw.ageSeconds || (existing.ageMinutes ? existing.ageMinutes * 60 : null) || null;

        map[addr] = existing;
      } catch (e) { continue; }
    }
    const out = Object.values(map);
    // compute a canonical age field for downstream filters
    const now = Date.now();
    for (const e of out) {
      try {
        // prefer explicit poolOpenTimeMs / firstBlockTime / ageSeconds / ageMinutes
        let secs: number | undefined = undefined;
        if (e.poolOpenTimeMs && typeof e.poolOpenTimeMs === 'number' && !isNaN(e.poolOpenTimeMs)) {
          // if value in seconds or ms
          let v = Number(e.poolOpenTimeMs);
          if (v > 1e12) v = Math.floor(v / 1000);
          else if (v > 1e9) v = Math.floor(v);
          else {
            // treat as minutes
            secs = v * 60;
          }
          if (secs === undefined) secs = Math.floor((Date.now() / 1000) - v);
        }
        if ((secs === undefined || isNaN(secs)) && typeof e.firstBlockTime === 'number') {
          const fb = Number(e.firstBlockTime);
          secs = Math.floor((Date.now() / 1000) - (fb > 1e12 ? Math.floor(fb / 1000) : fb));
        }
        if ((secs === undefined || isNaN(secs)) && typeof e.ageSeconds === 'number') secs = Number(e.ageSeconds);
        if ((secs === undefined || isNaN(secs)) && typeof e.ageMinutes === 'number') secs = Math.floor(Number(e.ageMinutes) * 60);
        // fallback: check common aliases
        if ((secs === undefined || isNaN(secs)) && (e.poolOpenTime || e.firstSeenAtMs || e.firstSeenAt)) {
          const candidate = e.poolOpenTime || e.firstSeenAtMs || e.firstSeenAt;
          let v = Number(candidate);
          if (!isNaN(v)) {
            if (v > 1e12) v = Math.floor(v / 1000);
            if (v > 1e9) secs = Math.floor((Date.now() / 1000) - v);
            else secs = Math.floor(v * 60);
          }
        }
        if (secs === undefined || isNaN(secs)) secs = null as any;
        e._canonicalAgeSeconds = secs;
      } catch (e) {}
    }
    return out;
  } catch (e) {
    return arr || [];
  }
}

// Aggregate quick candidate sources into a unified list of { mint }
export async function getUnifiedCandidates(limit: number) {
  const candidates: any[] = [];
  const seen: Set<string> = new Set();
  try {
    // 1) Helius WS buffer + recent events
    try {
      const { getRecentHeliusEvents } = require('./heliusWsListener');
      const evs = getRecentHeliusEvents();
      if (Array.isArray(evs)) {
        const now = Math.floor(Date.now()/1000);
        for (const e of evs) {
          // prefer analyzer-provided mint field when available
          const raw = e && (e.mint || (e.parsed && e.parsed.info && e.parsed.info.mint) || e.address || null);
          const m = raw ? normalizeMintCandidate(raw) : null;
          // Skip obviously non-mint addresses and very-old events to reduce noise
          if (!m) continue;
          if (KNOWN_NON_MINT_ADDRESSES.has(m)) continue;
          const evtAge = e && (e.detectedAtSec || e.detectedAt || e.firstSlot) ? (e.detectedAtSec ? Number(e.detectedAtSec) : null) : null;
          // if we have a detectedAtSec and it's older than 24h, skip here (too noisy)
          if (evtAge && now - Number(evtAge) > (24 * 3600)) continue;
          if (m && !seen.has(m)) {
            // attach structured provenance so Helius contributes to __sources in canonical cache
            try {
              const meta = makeSourceMeta('helius-ws', true, { raw: e });
              candidates.push({ mint: m, __sources: [meta], sourceTags: ['helius-ws'] });
            } catch (ee) {
              candidates.push(m);
            }
            seen.add(m);
          }
          if (candidates.length >= limit) break;
        }
      }
    } catch (e) {}

    // 2) DexScreener boosts
    try {
      const raw = await fetchDexBoostsRaw(2000);
      let data: any[] = [];
      const dexMeta = raw && (raw as any).__meta ? (raw as any).__meta as SourceMeta : null;
      if (raw) data = Array.isArray(raw) ? raw as any[] : (raw.data || raw.pairs || raw.items || []);
      for (const it of data) {
        const rawMint = extractMintFromItemLocal(it);
        const m = rawMint ? normalizeMintCandidate(rawMint) : null;
        if (m && !seen.has(m)) {
          const obj: any = { mint: m };
          if (dexMeta) obj.__sources = [dexMeta];
          candidates.push(obj.mint ? obj : m);
          seen.add(m);
        }
        if (candidates.length >= limit) break;
      }
  } catch (e) {}

    // 3) fetchLatest5FromAllSources for extra corroboration
    try {
      const subs = await fetchLatest5FromAllSources(Math.max(5, limit));
      for (const arr of [subs.heliusEvents || [], subs.dexTop || [], subs.heliusHistory || []]) {
        for (const raw of arr) {
          const m = raw ? normalizeMintCandidate(raw) : null;
          if (m && !seen.has(m)) { candidates.push(m); seen.add(m); }
          if (candidates.length >= limit) break;
        }
        if (candidates.length >= limit) break;
      }
    } catch (e) {}

  } catch (e) {}

  const uniq = candidates.slice(0, limit || 200);
  // candidates may contain strings or objects { mint, __sources }
  return uniq.map((m: any) => {
    if (!m) return { mint: null };
    if (typeof m === 'string') return { mint: m };
    if (typeof m === 'object' && m.mint) return { mint: m.mint, __sources: m.__sources || null, sourceTags: m.sourceTags || null };
    return { mint: String(m) };
  });
}

// Return a list of candidates with source tags for diagnostics
export async function fetchLatestWithSources(limit = 50) {
  const out: Array<{ mint: string; source: string }> = [];
  try {
    const { getRecentHeliusEvents } = require('./heliusWsListener');
    const evs = getRecentHeliusEvents() || [];
    for (const e of evs) {
      const raw = e && (e.mint || (e.parsed && e.parsed.info && e.parsed.info.mint) || e.address || null);
      const m = normalizeMintCandidate(raw);
  if (m) out.push({ mint: m, source: 'helius-ws' });
      if (out.length >= limit) break;
    }
  } catch (e) {}

  try {
    const raw = await fetchDexBoostsRaw(2000);
    let data: any[] = [];
    const dexMeta = raw && (raw as any).__meta ? (raw as any).__meta as SourceMeta : null;
    if (raw) data = Array.isArray(raw) ? raw as any[] : (raw.data || raw.pairs || raw.items || []);
    for (const it of data) {
      const m = normalizeMintCandidate(extractMintFromItemLocal(it));
      if (m) {
        const entry: any = { mint: m, source: 'dexscreener' };
        if (dexMeta) entry.__meta = dexMeta;
        out.push(entry);
      }
      if (out.length >= limit) break;
    }
  } catch (e) {}

  try {
    const subs = await fetchLatest5FromAllSources(Math.max(5, limit));
    for (const m of subs.heliusEvents || []) if (m) out.push({ mint: m, source: 'helius-history' });
    for (const m of subs.dexTop || []) if (m) out.push({ mint: m, source: 'dex-top' });
  } catch (e) {}

  // dedupe preserve order
  const seen = new Set<string>();
  const final: Array<{ mint: string; source: string }> = [];
  for (const it of out) {
    if (!it || !it.mint) continue;
    if (seen.has(it.mint)) continue;
    seen.add(it.mint);
    final.push(it);
    if (final.length >= limit) break;
  }
  return final;
}

/**
 * Fetch tokens from common sources (DexScreener, CoinGecko fallback) once,
 * then filter tokens per user based on their normalized strategy.
 * Returns a map: { [userId]: tokens[] }
 */
export async function fetchAndFilterTokensForUsers(users: UsersMap, opts?: { limit?: number, force?: boolean, detail?: boolean, warmupHeliusMs?: number }): Promise<Record<string, any[]>> {
  const now = Date.now();
  if (!opts?.force && __global_fetch_cache.length && (now - __global_fetch_ts) < __GLOBAL_FETCH_TTL) {
    // cache is fresh; skip refetch but continue to per-user filtering using the existing __global_fetch_cache
  } else {
    // Cold-start warm-up: if global cache is empty (cold) and this is not a forced full-refresh,
    // perform a small seeded fetch first to warm TTL caches and rate-limiters to avoid request storms.
    try {
      // Optional warm-up: allow callers to request a Helius WS capture to populate events
      if (opts?.warmupHeliusMs && Number(opts.warmupHeliusMs) > 0) {
        try {
          const ms = Number(opts.warmupHeliusMs);
          console.log('[fetchAndFilterTokensForUsers] running helius warm-up for', ms, 'ms');
          await captureHeliusAndVerify(ms).catch(() => {});
        } catch (e) {}
      }
      const coldSeed = Number(process.env.COLD_START_SEED || 20);
      const coldEnabled = (coldSeed > 0 && !opts?.force && (!__global_fetch_cache || __global_fetch_cache.length === 0));
      if (coldEnabled) {
        try {
          const seedLimit = Math.max(5, Math.min(200, coldSeed));
          // fetch a small set and attempt light validation to populate in-memory TTL caches
          const seedCandidates = await getUnifiedCandidates(seedLimit).catch(() => []);
          if (Array.isArray(seedCandidates) && seedCandidates.length) {
            // light validate: call getAccountInfo for each seed but limit concurrency conservatively
            const lim = Number(process.env.COLD_START_VALIDATE_CONCURRENCY || 3);
            const runner = createLimiter(Math.max(1, lim));
            await Promise.all(seedCandidates.slice(0, seedLimit).map((c: any) => runner(async () => {
              try { if (typeof (globalThis as any).__fastTokenFetcher_getAccountInfo === 'function') return await (globalThis as any).__fastTokenFetcher_getAccountInfo(c.mint || c);
                // fallback to local exported getAccountInfo if available
                if (typeof (require('./src/fastTokenFetcher').getAccountInfo) === 'function') return await require('./src/fastTokenFetcher').getAccountInfo(c.mint || c);
              } catch (e) {}
            })));
          }
        } catch (e) {}
      }
    } catch (e) {}
    try {
  const limit = opts?.limit || 200;
  // fetch unified candidates from multiple sources (DexScreener + Helius events/history + parse + RPC)
  __global_fetch_cache = await getUnifiedCandidates(limit).catch(async (e: any) => {
    try {
      const { fetchUnifiedTokens } = require('./utils/tokenUtils');
      return await fetchUnifiedTokens('solana', { limit: String(limit) } as any);
    } catch (ee) { return []; }
  });
      __global_fetch_ts = Date.now();
  // Ensure cached items have canonical address fields for downstream filtering
      try {
        const tu = require('./utils/tokenUtils');
        __global_fetch_cache = (__global_fetch_cache || []).map((t: any) => {
          try {
            const addr = t.tokenAddress || t.address || t.mint || t.pairAddress || t.token?.address || null;
            const norm = addr ? tu.normalizeMintCandidate(addr) : null;
            if (norm) { t.tokenAddress = norm; t.address = norm; t.mint = norm; }
            // if candidate was an object with provenance, preserve it
            if (t && typeof t === 'object' && t.__sources) {
              t.__sources = Array.isArray(t.__sources) ? t.__sources : [t.__sources];
            }
            if (t && typeof t === 'object' && t.sourceTags) {
              t.sourceTags = Array.isArray(t.sourceTags) ? t.sourceTags : [t.sourceTags];
            }
          } catch (e) {}
          return t;
        });
      } catch (e) {}
      // Canonicalize & merge the cache to reduce conflicting fields and attach sourceTags
      try {
        __global_fetch_cache = mergeAndCanonicalizeCache(__global_fetch_cache || []);
      } catch (e) {}
      // Proactively merge DexScreener token/pair data into the global cache so
      // that downstream filtering has better chance of seeing marketCap/liquidity/volume/age
      try {
        const tu = require('./utils/tokenUtils');
        try {
          const ds = await fetchDexScreenerTokens('solana', { limit: String(limit) });
          if (Array.isArray(ds) && ds.length) {
            // Build map by normalized address from cache (ensure canonical keys)
            const cacheMap: Record<string, any> = {};
            for (const it of __global_fetch_cache || []) {
              try {
                const rawA = it.tokenAddress || it.address || it.mint || it.pairAddress || null;
                const normA = rawA ? tu.normalizeMintCandidate(rawA) : null;
                if (!normA) continue;
                // ensure token has canonical address fields
                it.tokenAddress = it.tokenAddress || normA;
                it.address = it.address || normA;
                it.mint = it.mint || normA;
                it.sourceTags = Array.isArray(it.sourceTags) ? it.sourceTags : (it.sourceTags ? [it.sourceTags] : []);
                cacheMap[String(normA)] = it;
              } catch (e) { continue; }
            }
            for (const d of ds) {
                try {
                const addrRaw = d.address || d.tokenAddress || d.pairAddress || d.token?.address || d.token?.tokenAddress || null;
                const addr = tu.normalizeMintCandidate(addrRaw);
                if (!addr) continue;
                // prepare canonical ds token object fields
                const dsToken = d || {};
                // If token exists in cache, merge missing fields conservatively and merge source tags
                const existing = cacheMap[addr];
                if (existing) {
                  // list of fields to merge only if missing
                  const fields = ['marketCap','liquidity','volume','priceUsd','name','symbol','pairAddress','poolOpenTime','poolOpenTimeMs','ageMinutes','ageSeconds','url','imageUrl','logoURI'];
                  for (const f of fields) {
                    try {
                      const val = dsToken[f] !== undefined ? dsToken[f] : (dsToken.token && dsToken.token[f] !== undefined ? dsToken.token[f] : undefined);
                      if ((existing[f] === undefined || existing[f] === null || existing[f] === '' ) && (val !== undefined && val !== null && val !== '')) {
                        // coerce numeric-looking values to numbers
                        if (typeof val === 'string' && !isNaN(Number(val))) existing[f] = Number(val);
                        else existing[f] = val;
                      }
                    } catch (e) {}
                  }
                  // merge source tags
                  existing.sourceTags = Array.isArray(existing.sourceTags) ? existing.sourceTags : (existing.sourceTags ? [existing.sourceTags] : []);
                  if (!existing.sourceTags.includes('dexscreener')) existing.sourceTags.push('dexscreener');
                  // attach structured source meta if present
                  try {
                    const meta = (d && (d.__meta || d.meta)) ? (d.__meta || d.meta) : null;
                    existing.__sources = Array.isArray(existing.__sources) ? existing.__sources : (existing.__sources ? [existing.__sources] : []);
                    if (meta) existing.__sources.push(meta);
                  } catch (e) {}
                  // ensure canonical address fields are present
                  existing.tokenAddress = existing.tokenAddress || addr;
                  existing.address = existing.address || addr;
                  existing.mint = existing.mint || addr;
                } else {
                  // not in cache: add a lightweight normalized entry so filters can consider it
                  const newEntry: any = {};
                  newEntry.tokenAddress = addr;
                  newEntry.address = addr;
                  newEntry.mint = addr;
                  // copy useful fields with safe coercion
                  newEntry.name = d.name || d.tokenName || '';
                  newEntry.symbol = d.symbol || d.ticker || '';
                  newEntry.marketCap = d.marketCap ?? d.fdv ?? null;
                  newEntry.liquidity = d.liquidity ?? d.liquidityUsd ?? null;
                  newEntry.volume = d.volume ?? d.h24 ?? null;
                  newEntry.priceUsd = d.priceUsd ?? d.price ?? null;
                  newEntry.pairAddress = d.pairAddress || addr;
                  newEntry.url = d.url || d.pairUrl || d.dexUrl || '';
                  newEntry.imageUrl = d.imageUrl || d.logoURI || '';
                  newEntry.sourceTags = ['dexscreener'];
                  try { if (d && d.__meta) newEntry.__sources = [d.__meta]; } catch (e) {}
                  newEntry.poolOpenTimeMs = d.poolOpenTimeMs || d.poolOpenTime || null;
                  if (newEntry.poolOpenTimeMs && typeof newEntry.poolOpenTimeMs === 'number' && newEntry.poolOpenTimeMs < 1e12 && newEntry.poolOpenTimeMs > 1e9) newEntry.poolOpenTimeMs *= 1000;
                  if (newEntry.poolOpenTimeMs) {
                    newEntry.ageSeconds = Math.floor((Date.now() - newEntry.poolOpenTimeMs) / 1000);
                    newEntry.ageMinutes = Math.floor(newEntry.ageSeconds / 60);
                  }
                  __global_fetch_cache.push(newEntry);
                  cacheMap[addr] = newEntry;
                }
              } catch (e) { continue; }
            }
          }
        } catch (e) {
          // DexScreener call failed; continue silently
        }
        // After merging dexscreener data, run a quick equivalence report to detect discrepancies
        try {
          try { const eq = compareSourcesForCache(__global_fetch_cache || []); printEquivalenceReport(eq); } catch (e) {}
          // Populate canonical on-chain ages (best-effort, bounded concurrency)
          try { await ensureCanonicalOnchainAges(__global_fetch_cache || [], { timeoutMs: Number(process.env.ONCHAIN_FRESHNESS_TIMEOUT_MS || 3000), concurrency: Number(process.env.ONCHAIN_FILL_CONCURRENCY || 3) }); } catch (e) {}
        } catch (e) {}
      } catch (e) {}
    } catch (e) {
      // fallback: try coinGecko single fetch
      try {
        const host = 'coingecko';
        const limiter = getHostLimiter(host, Number(process.env.COINGECKO_CONCURRENCY || 1));
        const startCg = Date.now();
        try {
          const cg = await limiter(async () => await retryWithBackoff(() => fetchSolanaFromCoinGecko(), { retries: Number(process.env.COINGECKO_RETRIES || 1), baseMs: 200 }));
          if (cg) {
            // attach meta for source tracing
            const meta = makeSourceMeta('coingecko', true, { latencyMs: Date.now() - startCg, raw: cg });
            if (cg && typeof cg === 'object') cg.__sources = Array.isArray(cg.__sources) ? cg.__sources.concat(meta) : [meta];
            __global_fetch_cache = cg ? [cg] : [];
            __global_fetch_ts = Date.now();
          } else {
            __global_fetch_cache = [];
          }
        } catch (ee) {
          __global_fetch_cache = [];
        }
      } catch (e) {
        __global_fetch_cache = [];
      }
    }
  }

  const result: Record<string, any[]> = {};
  const normalizedMap: Record<string, any> = {};
  // pre-normalize strategies
  for (const uid of Object.keys(users)) {
    const u = users[uid];
    if (!u || !u.strategy) continue;
    try {
      normalizedMap[uid] = normalizeStrategy(u.strategy);
    } catch {
      normalizedMap[uid] = u.strategy;
    }
  }

  // For each user, filter tokens using filterTokensByStrategy (robust)
  for (const uid of Object.keys(normalizedMap)) {
    const strat = normalizedMap[uid];
    if (!strat || strat.enabled === false) {
      result[uid] = [];
      continue;
    }
  try {
      // Official enrichment: for safety, check a small sample using Solana RPC + Jupiter.
      // We do this when user has autoBuy enabled or buyAmount > 0 to avoid unnecessary calls.
      const needOfficial = (typeof strat.buyAmount === 'number' && strat.buyAmount > 0) || strat.autoBuy !== false;
      let workCache = __global_fetch_cache;
      if (needOfficial && Array.isArray(workCache) && workCache.length > 0) {
  const sampleSize = Number(process.env.FASTFETCH_SAMPLE_SIZE || 40);
  const sample = workCache.slice(0, sampleSize);
  const { officialEnrich, checkOnChainActivity } = require('./utils/tokenUtils');
  const concurrency = Number(process.env.FASTFETCH_ENRICH_CONCURRENCY || 1);
        let idx = 0;
        async function worker() {
          while (idx < sample.length) {
            const i = idx++;
            const t = sample[i];
              try {
                // Gate expensive officialEnrich calls by a lightweight on-chain activity check
                const addr = t.tokenAddress || t.address || t.mint || t.pairAddress;
                if (!addr) continue;
                try {
                  const oc = await checkOnChainActivity(addr);
                  if (!oc || !oc.found) {
                    // skip heavy enrichment when no on-chain activity found
                    continue;
                  }
                } catch (e) {
                  continue;
                }

                // run officialEnrich under limiter + timeout and attach __meta
                const host = 'officialEnrich';
                const limiter = getHostLimiter(host, Number(process.env.FASTFETCH_ENRICH_CONCURRENCY || 1));
                const startE = Date.now();
                try {
                  await limiter(async () => {
                    const wrap = await withTimeout(officialEnrich(t, { amountUsd: Number(strat.buyAmount) || 50, timeoutMs: 4000 }), 4500);
                    if (!wrap.ok) throw new Error(String((wrap as any).error || 'timeout'));
                  });
                  t.__sources = Array.isArray(t.__sources) ? t.__sources : (t.__sources ? [t.__sources] : []);
                  t.__sources.push(makeSourceMeta('officialEnrich', true, { latencyMs: Date.now() - startE }));
                } catch (ee: any) {
                  t.__sources = Array.isArray(t.__sources) ? t.__sources : (t.__sources ? [t.__sources] : []);
                  t.__sources.push(makeSourceMeta('officialEnrich', false, { error: (ee && ee.message) || String(ee), latencyMs: Date.now() - startE }));
                }
              } catch (e) {}
          }
        }
        const workers = Array.from({ length: Math.min(concurrency, sample.length) }, () => worker());
  const globalTimeoutMs = Number(process.env.FASTFETCH_GLOBAL_TIMEOUT_MS || 4000);
        await Promise.race([ Promise.all(workers), new Promise(res => setTimeout(res, globalTimeoutMs)) ]);
        workCache = [...sample, ...workCache.slice(sampleSize)];
      }
  // Ensure workCache is canonicalized before filtering
  try { workCache = mergeAndCanonicalizeCache(workCache || []); } catch (e) {}
  const matches = await (require('./bot/strategy').filterTokensByStrategy(workCache, strat, { preserveSources: true }));
  if (!Array.isArray(matches)) {
    result[uid] = [];
  } else if (opts && opts.detail) {
    // return enriched detailed objects including provenance and canonical age
    try {
      const cache = getGlobalFetchCache() || [];
      const tmap: Record<string, any> = {};
      for (const c of cache) {
        try {
          const key = String(c.tokenAddress || c.address || c.mint || '').toLowerCase();
          if (key) tmap[key] = c;
        } catch (e) {}
      }
      const detailed: any[] = [];
      for (const m of matches) {
        try {
          const key = String(m.tokenAddress || m.address || m.mint || m.pairAddress || '').toLowerCase();
          const canon = key ? tmap[key] : null;
          const merged = Object.assign({}, m);
          if (canon && canon.__sources) merged.__sources = Array.isArray(canon.__sources) ? canon.__sources : [canon.__sources];
          if (canon && canon._canonicalAgeSeconds !== undefined) merged._canonicalAgeSeconds = canon._canonicalAgeSeconds;
          detailed.push(merged);
        } catch (e) { detailed.push(m); }
      }
      result[uid] = detailed;
    } catch (e) { result[uid] = matches; }
  } else {
    result[uid] = matches;
  }
    } catch (e) {
      result[uid] = [];
    }
  }

  return result;
}

// Expose internal global fetch cache for diagnostics and external reporters
export function getGlobalFetchCache() {
  return __global_fetch_cache || [];
}

// Ensure canonical on-chain ages are populated for cache entries that lack a canonical age.
// This function queries the unified getFirstOnchainTimestamp helper with bounded concurrency
// and annotates entries with firstBlockTime/poolOpenTimeMs and _canonicalAgeSeconds.
export async function ensureCanonicalOnchainAges(cache: any[], opts?: { timeoutMs?: number; concurrency?: number }) {
  if (!Array.isArray(cache) || cache.length === 0) return;
  try {
    const tu = require('./utils/tokenUtils');
    const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts!.timeoutMs : Number(process.env.ONCHAIN_FRESHNESS_TIMEOUT_MS || 3000);
    const concurrency = typeof opts?.concurrency === 'number' ? opts!.concurrency : Number(process.env.ONCHAIN_FILL_CONCURRENCY || 3);
    const limiter = createLimiter(Math.max(1, concurrency));
    let idx = 0;
    const work = Array.from({ length: Math.min(cache.length, Math.max(3, concurrency)) }).map(() => (async () => {
      while (true) {
        const i = idx++;
        if (i >= cache.length) break;
        const e = cache[i];
        try {
          if (!e) continue;
          // skip if canonical age already present (including explicit null)
          if (e._canonicalAgeSeconds !== undefined && e._canonicalAgeSeconds !== null) continue;
          const addr = e.tokenAddress || e.address || e.mint || e.pairAddress;
          if (!addr) { e._canonicalAgeSeconds = e._canonicalAgeSeconds === undefined ? null : e._canonicalAgeSeconds; continue; }
          // Bound the external call by limiter + timeout
          await limiter(async () => {
            try {
              const wrapped = await withTimeout(tu.getFirstOnchainTimestamp(addr, { timeoutMs }), timeoutMs + 200);
              if (!wrapped.ok) {
                // mark as missing so we don't retry aggressively
                e._canonicalAgeSeconds = null as any;
                return;
              }
              const res = wrapped.result as any;
              const ts = res && res.ts ? res.ts : null;
              if (ts) {
                // store ms timestamps consistently
                e.firstBlockTime = ts;
                if (!e.poolOpenTimeMs) e.poolOpenTimeMs = ts;
                e._canonicalAgeSeconds = Math.floor((Date.now() - ts) / 1000);
                try {
                  e.__sources = Array.isArray(e.__sources) ? e.__sources : (e.__sources ? [e.__sources] : []);
                  e.__sources.push(makeSourceMeta('first-onchain', true, { raw: { source: res && res.source ? res.source : 'onchain', cached: !!res?.cached } }));
                } catch (ignored) {}
              } else {
                // explicitly mark as missing to avoid repeated attempts in short-lived flows
                e._canonicalAgeSeconds = null as any;
              }
            } catch (err) {
              // continue on per-item failure
            }
          });
        } catch (err) {}
      }
    })());
    await Promise.all(work);
  } catch (e) {}
}

// Diagnostic: analyze which sources are present in the global fetch cache
export function analyzeFetchSources() {
  const cache = getGlobalFetchCache() || [];
  const perTokenCounts: Array<{ addr: string; sourceCount: number; sources: any[] }> = [];
  const globalSourceSet = new Set<string>();
  for (const it of cache) {
    try {
      const addr = it.tokenAddress || it.address || it.mint || it.pairAddress || '';
      const srcs = Array.isArray(it.__sources) ? it.__sources : (it.__sources ? [it.__sources] : []);
      // also include sourceTags as string markers
      const tags = Array.isArray(it.sourceTags) ? it.sourceTags : (it.sourceTags ? [it.sourceTags] : []);
      const normalized: any[] = [];
      for (const s of srcs) {
        try {
          const name = s && (s.name || s.source || s.host || s.type) || JSON.stringify(s || {});
          normalized.push(name);
          globalSourceSet.add(name);
        } catch (e) {}
      }
      for (const t of tags) {
        try { normalized.push(String(t)); globalSourceSet.add(String(t)); } catch (e) {}
      }
      perTokenCounts.push({ addr: String(addr), sourceCount: normalized.length, sources: normalized });
    } catch (e) {}
  }
  return { totalTokens: cache.length, distinctSources: Array.from(globalSourceSet), perTokenCounts };
}

// --- Utilities merged from temporary helper scripts ---
// Populate cache (force) and inspect newest entries; perform on-chain checks for tokens <= windowMin minutes
export async function runDeepCacheCheck(opts?: { windowMin?: number; limit?: number }) {
  const windowMin = opts?.windowMin ?? 5;
  const limit = opts?.limit ?? 200;
  try {
    // populate cache
    await fetchAndFilterTokensForUsers({}, { limit, force: true }).catch(() => {});
    const now = Date.now();
    const global = getGlobalFetchCache() || [];
    const mapped = (global || []).map((g: any) => ({ addr: g.tokenAddress || g.address || g.mint || '(no-addr)', poolOpenTimeMs: g.poolOpenTimeMs || g.firstSeenAtMs || null })).filter((x: any) => x.poolOpenTimeMs).map((x: any) => ({ ...x, ageMin: (now - Number(x.poolOpenTimeMs)) / 60000 })).sort((a: any, b: any) => a.poolOpenTimeMs - b.poolOpenTimeMs);
    console.log('global cache size:', (global || []).length);
    if (!mapped.length) { console.log('no entries with poolOpenTimeMs/firstSeenAtMs found in cache'); return; }
    const newest = safeArraySlice(mapped, Math.max(0, (mapped || []).length - 40)).reverse();
    console.log('Newest entries (up to 40):');
  for (const it of safeArraySlice<any>(newest, 0, 40)) console.log(`- ${it.addr}  poolOpenTimeMs=${it.poolOpenTimeMs}  ageMin=${(it.ageMin || 0).toFixed(2)}`);
    const recent = safeArraySlice(newest.filter((x: any) => (x && typeof x.ageMin === 'number' ? x.ageMin : -1) >= 0 && (x && typeof x.ageMin === 'number' ? x.ageMin : -1) <= windowMin), 0, 5);
    console.log('\nentries with age <=', windowMin, 'minutes:', recent.length);
    if (!recent.length) { console.log(`No tokens <=${windowMin}min found; increase window or capture live events.`); return; }
    for (const it of recent) {
      const item: any = it as any;
      console.log('\n---\nChecking', item.addr, 'ageMin=', (item.ageMin || 0).toFixed(2));
      try { const acct = await getAccountInfo(item.addr); console.log('getAccountInfo ok:', !!(acct && acct.value)); } catch (e) { console.log('getAccountInfo err', String(e)); }
          try { const sigs = await heliusGetSignaturesFast(item.addr, process.env.HELIUS_FAST_RPC_URL || HELIUS_RPC_URL || '', 4000, Number(process.env.HELIUS_RETRIES || 0)); console.log('signatures:', Array.isArray(sigs) ? `count=${sigs.length}` : safeStringSnippet(sigs, 200)); } catch (e) { console.log('sigs err', String(e)); }
    }
  } catch (e) { console.error('runDeepCacheCheck error', e && e.message ? e.message : e); }
}

// Start Helius WS listener for durationMs milliseconds, then run getAccountInfo/helius signatures for captured events
export async function captureHeliusAndVerify(durationMs = 60000) {
  try {
    const wsMod = require('./heliusWsListener');
    console.log('Starting Helius WS listener for', durationMs, 'ms...');
    const inst = await (wsMod.startHeliusWebsocketListener ? wsMod.startHeliusWebsocketListener({ onOpen: () => console.log('WS open'), onMessage: () => {}, onClose: () => console.log('WS closed'), onError: (e: any) => console.warn('WS error', e && e.message) }) : null);
    await new Promise((r) => setTimeout(r, durationMs));
    const ev = wsMod.getRecentHeliusEvents ? wsMod.getRecentHeliusEvents() : [];
    console.log('captured events count:', Array.isArray(ev) ? ev.length : 0);
    const limit = Math.min(20, Array.isArray(ev) ? ev.length : 0);
    for (let i = 0; i < limit; i++) {
      const e = ev[i];
      const mint = e && (e.mint || e.address || (e.parsed && e.parsed.info && e.parsed.info.mint));
      if (!mint) continue;
      console.log('\n---\nEvent', i, 'mint=', mint, 'eventType=', e && e.eventType || 'unknown');
      try { const acct = await getAccountInfo(mint); console.log('getAccountInfo.ok=', !!(acct && acct.value)); } catch (err) { console.log('getAccountInfo.err', String(err)); }
  try { const sigs = await heliusGetSignaturesFast(mint, process.env.HELIUS_FAST_RPC_URL || HELIUS_RPC_URL || '', 4000, Number(process.env.HELIUS_RETRIES || 1)); if (!sigs) console.log('signatures: null'); else if (Array.isArray(sigs)) console.log('signatures count:', sigs.length, 'sample0:', safeStringSnippet(sigs[0], 200)); else if (sigs.result && Array.isArray(sigs.result)) console.log('signatures count:', sigs.result.length, 'sample0:', safeStringSnippet(sigs.result[0], 200)); else console.log('signatures:', safeStringSnippet(sigs, 200)); } catch (err) { console.log('sigs.err', String(err)); }
    }
    try { if (inst && inst.stop) await inst.stop(); } catch (e) {}
    console.log('WS capture done');
  } catch (e) { console.error('captureHeliusAndVerify err', e && e.message ? e.message : e); }
}

// =========================
// Quick CLI: fast discovery + Helius_FAST enrichment
// =========================

async function fetchDexBoostsRaw(timeout = 3000) {
  // If running in listener-only mode, avoid external DexScreener calls.
  if (LISTENER_ONLY_MODE) {
    return { __meta: makeSourceMeta('dexscreener', false, { error: 'listener-only' }), data: [] } as any;
  }
  const url = DEXBOOSTS;
  const start = Date.now();
  try {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    const limiter = getHostLimiter(host, Number(process.env.DEXSCREENER_CONCURRENCY || 2));
    const res = await limiter(async () => {
      return await retryWithBackoff(async () => {
        // double-check listener-only before making network call
        if (LISTENER_ONLY_MODE) throw Object.assign(new Error('listener-only'), { __metaErr: 'listener-only' });
        const p = axios.get(url, { timeout });
        const wrap = await withTimeout(p, timeout + 200);
        if (!wrap.ok) throw Object.assign(new Error(String((wrap as any).error || 'timeout')), { __metaErr: (wrap as any).error });
        return (wrap.result as any);
      }, { retries: Number(process.env.DEXSCREENER_RETRIES || 2), baseMs: 200 });
    });
    return { __meta: makeSourceMeta('dexscreener', true, { latencyMs: Date.now() - start, raw: res.data }), data: res.data } as any;
  } catch (e: any) {
    const errMsg = e && (e.__metaErr || e.message || String(e)) || 'error';
    return { __meta: makeSourceMeta('dexscreener', false, { error: errMsg, latencyMs: Date.now() - start }) } as any;
  }
}

function extractMintFromItemLocal(it: any): string | null {
  if (!it) return null;
  if (it.token && typeof it.token === 'object') {
    const t = it.token;
    return normalizeMintCandidate(t.address || t.mint || null);
  }
  if (it.pair && typeof it.pair === 'object') {
    const p = it.pair;
    if (p.token && typeof p.token === 'object') return normalizeMintCandidate(p.token.mint || p.token.address || null);
    if (p.baseToken && typeof p.baseToken === 'object') return normalizeMintCandidate(p.baseToken.mint || p.baseToken.address || null);
    if (p.base && typeof p.base === 'object') return normalizeMintCandidate(p.base.mint || p.base.address || null);
  }
  return normalizeMintCandidate(it.tokenAddress || it.mint || it.address || null);
}

// Normalize candidate mint strings: trim, remove common noise suffixes/prefixes, and validate base58 via PublicKey
// normalizeMintCandidate is provided by ./utils/tokenUtils

export async function heliusGetSignaturesFast(mint: string, heliusUrl: string, timeout = 2500, retries = 0) {
  // simple in-memory cache to avoid repeated signature queries within a short window
  try {
    (globalThis as any).__heliusSigCache = (globalThis as any).__heliusSigCache || new TTLCache<string, any>(Number(process.env.HELIUS_SIG_CACHE_MS || 30_000));
    const sigCache: TTLCache<string, any> = (globalThis as any).__heliusSigCache;
    const cacheKey = `${heliusUrl}::${mint}`;
    const cached = sigCache.get(cacheKey);
    if (cached) return cached;
  } catch (e) {}
  const payload = { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [mint, { limit: 3 }] };
  let attempt = 0;
  while (attempt <= retries) {
    try {
  // RPC_STATS instrumentation
  try { (globalThis as any).__RPC_STATS = (globalThis as any).__RPC_STATS || { calls: 0, errors: 0, rateLimit429: 0, totalLatencyMs: 0 }; } catch (e) {}
  const _stats: any = (globalThis as any).__RPC_STATS || null;
      const host = (() => { try { return new URL(heliusUrl).host; } catch { return heliusUrl; } })();
      const limiter = getHostLimiter(host, Number(process.env.HELIUS_CONCURRENCY || 2));
  const start = Date.now();
  if (_stats) _stats.calls = (_stats.calls || 0) + 1;
  const res = await limiter(async () => {
        return await retryWithBackoff(async () => {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          try { const _hk = getHeliusApiKey(); if (_hk) headers['x-api-key'] = _hk; } catch (e) {}
          const p = axios.post(heliusUrl, payload, { headers, timeout });
          const wrap = await withTimeout(p, timeout + 200);
          if (!wrap.ok) throw Object.assign(new Error(String((wrap as any).error || 'timeout')), { __metaErr: (wrap as any).error });
          return (wrap.result as any);
        }, { retries: Math.max(0, retries || Number(process.env.HELIUS_RETRIES || 1)), baseMs: 200 });
      });
  const latency = Date.now() - start;
  try { if (_stats) _stats.totalLatencyMs = (_stats.totalLatencyMs || 0) + latency; } catch (e) {}
  const resData = res as any;
      if (!resData.data || !resData.data.result) throw new Error('Invalid response');
      return resData.data;
    } catch (e: any) {
      const status = e.response?.status;
  try { const _stats: any = (globalThis as any).__RPC_STATS || null; if (_stats) { _stats.errors = (_stats.errors || 0) + 1; if (status === 429) _stats.rateLimit429 = (_stats.rateLimit429 || 0) + 1; } } catch (ee) {}
      // If 429 or 5xx, consider retrying
  if (status && (status === 429 || (status >= 500 && status < 600)) && attempt < retries) {
        const backoff = 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, backoff));
        attempt++;
        continue;
      }
      return { __error: status ? `http-${status}` : (e.message || 'error') };
    }
  }
  return { __error: 'unknown' };
}

// Handle a new mint event: attempt quick enrichment (first signature => blockTime) and log
// --- Helpers: lightweight helius/json-rpc wrapper and verification helpers
async function heliusRpc(method: string, params: any[] = [], timeout = 4000, retries = 0): Promise<any> {
  const heliusUrl = HELIUS_RPC_URL || process.env.HELIUS_FAST_RPC_URL;
  if (!heliusUrl) return { __error: 'no-helius-url' };
  // host cooldown guard (global)
  const hostStateKey = (() => { try { return new URL(heliusUrl).host; } catch { return heliusUrl; } })();
  if ((globalThis as any).__hostCooldowns && (globalThis as any).__hostCooldowns[hostStateKey] && Date.now() < (globalThis as any).__hostCooldowns[hostStateKey].cooldownUntil) {
    return { __error: 'host-cooldown' };
  }
  const payload = { jsonrpc: '2.0', id: 1, method, params };
  let attempt = 0;
  while (attempt <= retries) {
    try {
  // RPC_STATS instrumentation
  try { (globalThis as any).__RPC_STATS = (globalThis as any).__RPC_STATS || { calls: 0, errors: 0, rateLimit429: 0, totalLatencyMs: 0 }; } catch (e) {}
  const _stats: any = (globalThis as any).__RPC_STATS || null;
  const start = Date.now(); if (_stats) _stats.calls = (_stats.calls || 0) + 1;
      const host = (() => { try { return new URL(heliusUrl).host; } catch { return heliusUrl; } })();
      const limiter = getHostLimiter(host, Number(process.env.HELIUS_CONCURRENCY || 2));
      const resp = await limiter(async () => {
        return await retryWithBackoff(async () => {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          try { const _hk = getHeliusApiKey(); if (_hk) headers['x-api-key'] = _hk; } catch (e) {}
          const p = axios.post(heliusUrl, payload, { headers, timeout });
          const wrap = await withTimeout(p, timeout + 200);
          if (!wrap.ok) throw Object.assign(new Error(String((wrap as any).error || 'timeout')), { __metaErr: (wrap as any).error });
          return (wrap.result as any);
        }, { retries: Math.max(0, retries || Number(process.env.HELIUS_RETRIES || 1)), baseMs: 200 });
      });
  const latency = Date.now() - start; try { if (_stats) _stats.totalLatencyMs = (_stats.totalLatencyMs || 0) + latency; } catch (e) {}
  const res = resp as any;
  return res.data?.result ?? res.data;
    } catch (e: any) {
      const status = e.response?.status;
  try { const _stats: any = (globalThis as any).__RPC_STATS || null; if (_stats) { _stats.errors = (_stats.errors || 0) + 1; if (status === 429) _stats.rateLimit429 = (_stats.rateLimit429 || 0) + 1; } } catch (ee) {}
      // handle 429/5xx with cooldown/backoff
      if (status && (status === 429 || (status >= 500 && status < 600))) {
        // record in global host cooldowns
        try {
          const host = hostStateKey;
          (globalThis as any).__hostCooldowns = (globalThis as any).__hostCooldowns || {};
          const st = (globalThis as any).__hostCooldowns[host] = (globalThis as any).__hostCooldowns[host] || { recent429: 0, cooldownUntil: 0 };
          st.recent429 = (st.recent429 || 0) + 1;
          const base = 1000;
          const backoffMs = Math.min(60_000, base * Math.pow(2, Math.min(6, st.recent429)) + Math.floor(Math.random() * 500));
          st.cooldownUntil = Date.now() + backoffMs;
        } catch (ee) {}
      }
      if (status && (status === 429 || (status >= 500 && status < 600)) && attempt < retries) {
        const backoff = 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, backoff));
        attempt++;
        continue;
      }
      return { __error: status ? `http-${status}` : (e.message || 'error') };
    }
  }
  return { __error: 'unknown' };
}

// Helper: check whether a mint has been seen previously according to Helius signature history
export async function mintPreviouslySeen(mint: string, txBlockTime: number | null, currentSig?: string): Promise<boolean | null> {
  try {
    if (!mint) return null;
    const heliusUrl = process.env.HELIUS_FAST_RPC_URL || HELIUS_RPC_URL;
    if (!heliusUrl) return null;
    // Check Redis-first for a short-lived seen flag to avoid repeated heavy signature queries
    try {
      const rc = await getRedisClient().catch(() => null);
      if (rc) {
        const key = `mint_seen:${String(mint).toLowerCase()}`;
        try {
          const v = await rc.get(key).catch(() => null);
          if (v) return true;
        } catch (e) {}
      }
    } catch (e) {}

    const lookback = Number(process.env.HELIUS_MINT_PREV_LOOKBACK || 20);
    const res = await heliusGetSignaturesFast(mint, heliusUrl, 4000, 0).catch(() => null);
    if (!res) return null;
    const arr = Array.isArray(res) ? res : (res?.result ?? res) || [];
    if (!Array.isArray(arr) || arr.length === 0) return false;

    // Build a small window of entries to inspect (objects with possible blockTime)
    const window = arr.slice(0, lookback);
    if (!window.length) return null;

    // If no currentSig provided: more than one signature -> previously seen
    if (!currentSig) return window.length > 1;

    // Normalize txBlockTime to seconds for comparison
    let txSec: number | null = null;
    try {
      const n = Number(txBlockTime as any);
      if (!Number.isNaN(n)) {
        txSec = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
      }
    } catch (e) { txSec = null; }

    // Inspect entries for any signature other than currentSig and compare block times
    for (const entry of window) {
      try {
        const sig = entry?.signature || entry?.txHash || entry?.tx_hash || null;
        if (!sig) continue;
        if (sig === currentSig) continue;
        // candidate previous signature found
        const btRaw = entry?.blockTime ?? entry?.block_time ?? entry?.blocktime ?? entry?.timestamp ?? null;
        let btSec: number | null = null;
        try {
          const n = Number(btRaw as any);
          if (!Number.isNaN(n)) btSec = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
        } catch (e) { btSec = null; }

        if (btSec && txSec) {
          if (btSec < txSec) {
            console.error(`DIAG_PREV_SEEN mint=${mint} sig=${sig} btSec=${btSec} txSec=${txSec} currentSig=${currentSig} -> PREVIOUS`);
            return true;
          } else {
            console.error(`DIAG_PREV_NOT_PREVIOUS mint=${mint} sig=${sig} btSec=${btSec} txSec=${txSec} currentSig=${currentSig}`);
            // continue searching other entries
          }
        } else {
          // We found another signature but cannot compare times; treat as previously seen (conservative)
          console.error(`DIAG_PREV_UNKNOWN mint=${mint} sig=${sig} btRaw=${String(btRaw)} txBlockTime=${String(txBlockTime)} currentSig=${currentSig} -> CONSERVATIVE_PREVIOUS`);
          return true;
        }
      } catch (e) { continue; }
    }

    // No previous signature with earlier blockTime found
    return false;
  } catch (e) {
    return null;
  }
}

// Helper: inspect parsed instructions and check whether they reference the mint string
function instructionReferencesMint(instrs: any[], mint: string): boolean {
  try {
    if (!instrs || !Array.isArray(instrs) || !mint) return false;
    const norm = String(mint).toLowerCase();
    for (const ins of instrs) {
      try {
        // check common parsed fields
        if (ins && ins.parsed && ins.parsed.info) {
          // many parsed infos include 'mint' or 'mintAddress' or tokenAccount fields
          const infos = JSON.stringify(ins.parsed.info || {}) || '';
          if (infos.toLowerCase().includes(norm)) return true;
        }
        // check account keys / program accounts
        if (ins && ins.accounts && Array.isArray(ins.accounts)) {
          for (const a of ins.accounts) if (String(a || '').toLowerCase().includes(norm)) return true;
        }
        // raw instruction data may include base58 or mint references in 'programId' or 'data'
        if (ins && ins.programId && String(ins.programId).toLowerCase().includes(norm)) return true;
        if (ins && ins.data && String(ins.data).toLowerCase().includes(norm)) return true;
        // innerInstructions wrapper (older parsed shapes)
        if (ins && ins.inner && Array.isArray(ins.inner)) {
          if (instructionReferencesMint(ins.inner, mint)) return true;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return false;
}

async function getParsedTransaction(signature: string) {
  // try Helius RPC wrapper first
  let heliusRes: any = null;
  try {
    heliusRes = await heliusRpc('getTransaction', [signature, { encoding: 'jsonParsed' }], 5000, 1);
    if (heliusRes && !(heliusRes as any).__error) {
      // If heliusRes contains result structure, return it
      const candidate = heliusRes.result ?? heliusRes;
      if (candidate) return candidate;
    }
  } catch (e) {}

  // fallback: if Helius is unavailable or returned error, try MAINNET_RPC (Solana JSON-RPC)
  try {
    // prefer an explicit MAINNET RPC endpoint (do not reuse Helius RPC endpoint)
    const rpc = process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com';
    if (!rpc) return { __error: 'no-rpc' };
    const payload = { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed' }] };
    const headers: Record<string,string> = { 'Content-Type': 'application/json' };
    const r = await axios.post(rpc, payload, { headers, timeout: 6000 });
    if (r && r.data) return r.data.result ?? r.data;
    // fallthrough to connection attempt
    // return { __error: 'no-response' };
  } catch (e: any) {
    const status = e?.response?.status;
    // try connection fallback below
  }

  // final attempt via web3 Connection
  try {
    const connRes = await getParsedTransactionViaConnection(signature);
    if (connRes && !(connRes as any).__error) return connRes;
    return { __error: 'all-failed' };
  } catch (e) {
    return { __error: 'all-failed' };
  }
}

// If HTTP RPCs fail, try using the existing web3 Connection as a last resort
async function getParsedTransactionViaConnection(signature: string) {
  try {
    const cfg = require('./config');
    const conn = cfg && cfg.connection;
    if (!conn || typeof conn.getParsedTransaction !== 'function') return { __error: 'no-connection' };
    const res = await conn.getParsedTransaction(signature, 'confirmed');
    return res ?? { __error: 'no-result' };
  } catch (e: any) {
    return { __error: (e && e.message) || 'error' };
  }
}

// Try to resolve blockTime for a slot with Redis caching to avoid repeated RPC calls
async function getBlockTimeForSlotCached(slot: number): Promise<number | null> {
  try {
    const key = `slot_blocktime:${slot}`;
    const rc = await getRedisClient().catch(() => null);
    if (rc) {
      try {
        const v = await rc.get(key).catch(() => null);
        if (v || v === '0') return Number(v);
      } catch (e) {}
    }

    // try web3 Connection.getBlockTime if available
    try {
      const cfg = require('./config');
      const conn = cfg && cfg.connection;
      if (conn && typeof conn.getBlockTime === 'function') {
        const bt = await conn.getBlockTime(Number(slot));
        if (bt || bt === 0) {
          try { if (rc) await rc.setEx(key, Math.max(1, Math.floor(Number(process.env.SLOT_BLOCKTIME_TTL_SEC || 60 * 60 * 24 * 7))), String(bt)).catch(() => {}); } catch (e) {}
          return Number(bt);
        }
      }
    } catch (e) {}

    // fallback to MAINNET_RPC JSON-RPC getBlockTime
    try {
      const mainRpc = process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com';
      if (mainRpc) {
        const payload = { jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [Number(slot)] };
        const r = await axios.post(mainRpc, payload, { timeout: 4000 });
        const val = r && r.data ? (r.data.result ?? r.data) : null;
        if (val || val === 0) {
          const num = Number(val);
          try { if (rc) await rc.setEx(key, Math.max(1, Math.floor(Number(process.env.SLOT_BLOCKTIME_TTL_SEC || 60 * 60 * 24 * 7))), String(num)).catch(() => {}); } catch (e) {}
          return num;
        }
      }
    } catch (e) {}

    return null;
  } catch (e) {
    return null;
  }
}

// Cache-only lookup: attempt to read slot->blockTime from Redis only.
// This is useful for very-low-latency checks where we must not perform
// web3 or HTTP RPC calls on the hot path.
async function getCachedBlockTimeForSlot(slot: number): Promise<number | null> {
  try {
    const rc = await getRedisClient().catch(() => null);
    if (!rc) return null;
    const key = `slot_blocktime:${slot}`;
    const v = await rc.get(key).catch(() => null);
    if (v || v === '0') {
      const num = Number(v);
      if (Number.isNaN(num)) return null;
      return num;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// -----------------------------
// Per-mint snapshot helpers (cache-only + background updater)
// -----------------------------
/**
 * Read a cached per-mint snapshot (cache-only). Returns null when no cache present.
 * snapshot fields: { lastSeenTs, ageSeconds, volume_60s, volume_3600s, approxLiquidity, eventCount }
 */
export async function getMintSnapshotCached(mint: string): Promise<Record<string, any> | null> {
  try {
    if (!mint) return null;
    const rc = await getRedisClient().catch(() => null);
    // If Redis available, read from it. Otherwise fallback to in-memory store below.
    if (rc) {
      const key = `mint_stats:${mint}`;
      const h = await rc.hGetAll(key).catch(() => ({}));
      if (!h || Object.keys(h).length === 0) return null;
      const out: any = {};
      if (h.lastSeenTs) out.lastSeenTs = Number(h.lastSeenTs);
      if (out.lastSeenTs) out.ageSeconds = Math.max(0, Math.floor(Date.now()/1000) - Number(out.lastSeenTs));
      if (h.volume_60s) out.volume_60s = Number(h.volume_60s);
      if (h.volume_3600s) out.volume_3600s = Number(h.volume_3600s);
      if (h.approxLiquidity) out.approxLiquidity = Number(h.approxLiquidity);
      if (h.eventCount) out.eventCount = Number(h.eventCount);
      return out;
    }
    // In-memory fallback
    try {
      // lazy-initialize in-memory store
      if (!(global as any).__inMemoryMintStats) (global as any).__inMemoryMintStats = new Map();
      const store: Map<string, any> = (global as any).__inMemoryMintStats;
      const rec = store.get(mint) || null;
      if (!rec) return null;
      const now = Math.floor(Date.now()/1000);
      if (rec.expiry && rec.expiry < now) {
        try { store.delete(mint); } catch (e) {}
        return null;
      }
      const h = rec.data || {};
      const out2: any = {};
      if (h.lastSeenTs) out2.lastSeenTs = Number(h.lastSeenTs);
      if (out2.lastSeenTs) out2.ageSeconds = Math.max(0, Math.floor(Date.now()/1000) - Number(out2.lastSeenTs));
      if (h.volume_60s) out2.volume_60s = Number(h.volume_60s);
      if (h.volume_3600s) out2.volume_3600s = Number(h.volume_3600s);
      if (h.approxLiquidity) out2.approxLiquidity = Number(h.approxLiquidity);
      if (h.eventCount) out2.eventCount = Number(h.eventCount);
      return out2;
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  }
}

/**
 * Update mint stats from an observed event. Best-effort background updater.
 * amount can be 0 when unknown. Non-blocking callers should call but not await.
 */
export async function updateMintStatsFromEvent(mint: string, amount = 0, slot?: number, tsSec?: number) {
  try {
    if (!mint) return false;
    const rc = await getRedisClient().catch(() => null);
    const ttl = Math.max(1, Math.floor(Number(process.env.MINT_STATS_TTL_SEC || 60 * 60 * 24 * 7)));
    const nowSec = tsSec || Math.floor(Date.now()/1000);
    if (rc) {
      const key = `mint_stats:${mint}`;
      const pipeline = rc.multi();
      try {
        // set lastSeenTs
        pipeline.hSet(key, 'lastSeenTs', String(nowSec));
        // increment counters
        pipeline.hIncrBy(key, 'eventCount', 1).catch(() => {});
        if (amount && !isNaN(Number(amount)) && Number(amount) > 0) {
          pipeline.hIncrByFloat(key, 'volume_60s', Number(amount)).catch(() => {});
          pipeline.hIncrByFloat(key, 'volume_3600s', Number(amount)).catch(() => {});
        }
        // best-effort: attach approxLiquidity from global fetch cache if not already set
        try {
          const existing = await rc.hGet(key, 'approxLiquidity').catch(() => null);
          if (!existing) {
            try {
              const cache = getGlobalFetchCache();
              if (Array.isArray(cache) && cache.length) {
                const norm = String(mint).toLowerCase();
                const found = cache.find((c: any) => {
                  try { return String(c.tokenAddress || c.address || c.mint || '').toLowerCase() === norm; } catch { return false; }
                });
                if (found) {
                  const liq = Number(found.liquidity ?? found.liquidityUsd ?? found.marketCap ?? found.liq ?? found.approxLiquidity ?? found.volume ?? 0) || 0;
                  if (liq && !isNaN(liq) && Number(liq) > 0) pipeline.hSet(key, 'approxLiquidity', String(Number(liq)));
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
        // set ttl
        pipeline.expire(key, ttl);
        await pipeline.exec().catch(() => {});
      } catch (e) {
        try { await rc.hSet(key, 'lastSeenTs', String(nowSec)).catch(() => {}); await rc.expire(key, ttl).catch(() => {}); } catch {}
      }
      return true;
    } else {
      // fallback: no Redis configured -> use in-memory Map with expiry
      try {
        if (!(global as any).__inMemoryMintStats) (global as any).__inMemoryMintStats = new Map();
        const store: Map<string, any> = (global as any).__inMemoryMintStats;
        const existing = store.get(mint) || { data: {}, expiry: 0 };
        const data = existing.data || {};
        data.lastSeenTs = String(nowSec);
        data.eventCount = Number(data.eventCount || 0) + 1;
        if (amount && !isNaN(Number(amount)) && Number(amount) > 0) {
          data.volume_60s = Number(data.volume_60s || 0) + Number(amount);
          data.volume_3600s = Number(data.volume_3600s || 0) + Number(amount);
        }
        // best-effort: fill approxLiquidity from global fetch cache if missing
        try {
          if (!data.approxLiquidity) {
            const cache = getGlobalFetchCache();
            if (Array.isArray(cache) && cache.length) {
              const norm = String(mint).toLowerCase();
              const found = cache.find((c: any) => {
                try { return String(c.tokenAddress || c.address || c.mint || '').toLowerCase() === norm; } catch { return false; }
              });
              if (found) {
                const liq = Number(found.liquidity ?? found.liquidityUsd ?? found.marketCap ?? found.liq ?? found.approxLiquidity ?? found.volume ?? 0) || 0;
                if (liq && !isNaN(liq) && Number(liq) > 0) data.approxLiquidity = Number(liq);
              }
            }
          }
        } catch (e) {}
        const expiry = Math.floor(Date.now()/1000) + ttl;
        store.set(mint, { data, expiry });
        return true;
      } catch (e) {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
}

// export for external quick lookups (heliusWsListener uses this)
export { getBlockTimeForSlotCached, getCachedBlockTimeForSlot };

export async function getAccountInfo(pubkey: string) {
  try {
    (globalThis as any).__heliusAccountCache = (globalThis as any).__heliusAccountCache || new TTLCache<string, any>(Number(process.env.HELIUS_ACCOUNT_CACHE_MS || 30_000));
    const cache: TTLCache<string, any> = (globalThis as any).__heliusAccountCache;
    const key = String(pubkey);
    const hit = cache.get(key);
    if (hit) return hit;
    const res = await heliusRpc('getAccountInfo', [pubkey, { encoding: 'base64' }], 4000, 1);
    try { cache.set(key, res, Number(process.env.HELIUS_ACCOUNT_CACHE_MS || 30_000)); } catch (e) {}
    return res;
  } catch (e) {
    return heliusRpc('getAccountInfo', [pubkey, { encoding: 'base64' }], 4000, 1);
  }
}

async function getTokenSupply(pubkey: string) {
  return heliusRpc('getTokenSupply', [pubkey], 4000, 1);
}

function metadataPdaForMint(mint: string) {
  try {
    const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    const mintPk = new PublicKey(mint);
    const seeds = [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()];
    return PublicKey.findProgramAddress(seeds, METADATA_PROGRAM).then(([p]) => p.toBase58());
  } catch (e) {
    return Promise.resolve(null);
  }
}

// Enhanced: handleNewMintEvent now performs deterministic verification and can optionally route to users
export async function handleNewMintEvent(mintOrObj: any, users?: UsersMap, telegram?: any) {
  const mint = typeof mintOrObj === 'string' ? mintOrObj : (mintOrObj?.mint || null);
  if (!mint) return null;
  try {
    const heliusUrl = process.env.HELIUS_FAST_RPC_URL || HELIUS_RPC_URL;
    if (!heliusUrl) { console.log('handleNewMintEvent: no helius url'); return null; }

    // Prefer slot->getBlockTime when Helius WS provided a firstSlot (cheaper and more reliable for timestamps)
    let earliestBlockTime: number | null = null;
    let firstSignature: string | null = null;
    try {
      const candidateSlot = (mintOrObj && (mintOrObj.firstSlot || (mintOrObj.raw && (mintOrObj.raw.params?.result?.context?.slot || mintOrObj.raw.result?.context?.slot)))) || null;
      if (candidateSlot && Number(candidateSlot) > 0) {
        try {
          const bt = await getBlockTimeForSlotCached(Number(candidateSlot));
          if (bt && typeof bt === 'number') earliestBlockTime = Number(bt);
        } catch (e) {}
      }
    } catch (e) {}

  // If slot->getBlockTime resolved timestamp, skip heavy signature/parsed tx calls
    if (!earliestBlockTime) {
      const r = await heliusGetSignaturesFast(mint, heliusUrl, 4000, 0);
      if (!r || (r as any).__error) { if ((r as any)?.__error) console.log(`Enrich ${mint} error: ${(r as any).__error}`); return null; }
      const arr = Array.isArray(r) ? r : ((r as any).result ?? r);
      if (!arr || !Array.isArray(arr) || arr.length === 0) return null;

      // compute earliest blockTime across signatures (Helius returns newest-first)
      // compute earliest blockTime across signatures (Helius returns newest-first)
      // Prefer transactions that look like mint/metadata creation (initializeMint, mintTo, create_metadata) by parsing
      // a limited set of the oldest signatures to avoid picking a later swap as the 'first' activity.
      try {
        // first attempt: look for parsed txs among the oldest N signatures
        const oldestToCheck = 20; // keep small to bound RPC
        const arrOldest = Array.isArray(arr) ? arr.slice(-oldestToCheck) : [];
        let found = false;
    for (let i = 0; i < arrOldest.length; i++) {
          const entry = arrOldest[i];
          const sig = entry?.signature || (entry as any)?.txHash || (entry as any)?.tx_hash || null;
          if (!sig) continue;
          try {
            const parsed = await getParsedTransaction(sig);
            const p = parsed && (parsed.result || parsed) ? (parsed.result || parsed) : parsed;
            const pbt = p?.blockTime ?? p?.block_time ?? p?.blocktime ?? null;
            // Inspect instructions for mint/metadata creation hints
      const instrs = (p?.transaction?.message?.instructions) || (p?.meta?.innerInstructions && Array.isArray(p.meta.innerInstructions) ? p.meta.innerInstructions.flatMap((x:any)=>x.instructions) : null) || [];
      const rawInstrs = JSON.stringify(instrs || '');
      const isMintish = /initializeMint|mintTo|CreateMetadataAccount|create_metadata_accounts|create_metadata_accounts_v2|create_metadata_account/i.test(rawInstrs);
      // ensure parsed instructions actually reference the mint address to avoid later-swap false positives
      const refsMint = instructionReferencesMint(instrs || [], mint);
      if (isMintish && refsMint && pbt) {
              const pnum = Number(pbt > 1e12 ? Math.floor(pbt / 1000) : pbt);
              earliestBlockTime = pnum;
              firstSignature = sig;
              found = true;
              break;
            }
          } catch (e) {
            // ignore per-sig parse errors
          }
        }
  if (!found) {
          // fallback to taking minimal blockTime present in signature list
          for (const entry of arr) {
            const sig = entry?.signature || (entry as any)?.txHash || (entry as any)?.tx_hash || null;
            let btv: any = entry?.blockTime ?? entry?.block_time ?? entry?.blocktime ?? entry?.timestamp ?? null;
            if (btv && btv > 1e12) btv = Math.floor(Number(btv) / 1000);
            if (btv) {
              const num = Number(btv);
              if (!earliestBlockTime || num < earliestBlockTime) {
                earliestBlockTime = num;
                firstSignature = sig;
              }
            }
          }
          // fallback: if still missing, try parsed tx for the last (earliest) signature
          if (!earliestBlockTime) {
            const sigTry = arr[arr.length - 1]?.signature || (arr[arr.length - 1] as any)?.txHash || (arr[arr.length - 1] as any)?.tx_hash || null;
            if (sigTry) {
              try {
                const parsed = await getParsedTransaction(sigTry);
                const pbt = (parsed as any)?.blockTime ?? (parsed as any)?.result?.blockTime ?? (parsed as any)?.result?.block_time ?? (parsed as any)?.result?.blocktime ?? null;
                if (pbt) earliestBlockTime = Number(pbt > 1e12 ? Math.floor(pbt / 1000) : pbt);
                firstSignature = sigTry;
              } catch (e) {}
            }
          }
        }
      } catch (e) {
        // ignore and continue; we'll use available blockTimes
      }
    }



  // slot fallback already attempted via getBlockTimeForSlotCached earlier; no-op here

  if (!earliestBlockTime) return null;
  // normalize earliestBlockTime (which may be seconds or ms) to ms
  const earliestBlockTimeMs = Number(earliestBlockTime) > 1e12 ? Number(earliestBlockTime) : Math.floor(Number(earliestBlockTime) * 1000);
  const ageSeconds = Math.floor((Date.now() - earliestBlockTimeMs) / 1000);

    // If token looks very young, do a deeper signature parse scan to avoid picking a later swap as the 'first'
    try {
      const deepScanThreshold = Number(process.env.DEEP_SCAN_THRESHOLD_SEC || 600); // 10 minutes
      if (ageSeconds <= deepScanThreshold) {
        const deepLimit = Number(process.env.DEEP_SCAN_LIMIT || 400);
        const oldestToCheckDeep = Number(process.env.DEEP_OLDEST_TO_CHECK || 200);
        try {
          const deepRes = await heliusRpc('getSignaturesForAddress', [mint, { limit: deepLimit }], 8000, 0);
          const deepArr = Array.isArray(deepRes) ? deepRes : (deepRes?.result ?? deepRes) || [];
          if (Array.isArray(deepArr) && deepArr.length) {
            const arrOldestDeep = deepArr.slice(-Math.min(oldestToCheckDeep, deepArr.length));
      for (let i = 0; i < arrOldestDeep.length; i++) {
              const entry = arrOldestDeep[i];
              const sig = entry?.signature || entry?.txHash || entry?.tx_hash || null;
              if (!sig) continue;
              try {
                const parsed = await getParsedTransaction(sig);
                const p = parsed && (parsed.result || parsed) ? (parsed.result || parsed) : parsed;
                const pbt = p?.blockTime ?? p?.block_time ?? p?.blocktime ?? null;
                const instrs = (p?.transaction?.message?.instructions) || (p?.meta?.innerInstructions && Array.isArray(p.meta.innerInstructions) ? p.meta.innerInstructions.flatMap((x:any)=>x.instructions) : null) || [];
        const rawInstrs = JSON.stringify(instrs || '');
        const isMintish = /initializeMint|mintTo|CreateMetadataAccount|create_metadata_accounts|create_metadata_accounts_v2|create_metadata_account/i.test(rawInstrs);
        const refsMint = instructionReferencesMint(instrs || [], mint);
        if (isMintish && refsMint && pbt) {
                  const pnum = Number(pbt > 1e12 ? Math.floor(pbt / 1000) : pbt);
                  if (!earliestBlockTime || pnum < earliestBlockTime) {
                    earliestBlockTime = pnum;
                    firstSignature = sig;
                    // recompute ageSeconds
                    // not reassigning nowSec
                  }
                  break;
                }
              } catch (e) {
                // ignore per-sig parse errors
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    // We'll attempt to use metadata PDA creation time if available (prefer it when earlier)
    let metadataTimestampUsed = false;
    const metadataPda = await metadataPdaForMint(mint);
    let metadataExists = false;
    if (metadataPda) {
      const acct = await getAccountInfo(metadataPda);
      if (acct && acct.value) metadataExists = true;
    }
    // If metadata PDA exists, try to determine its earliest signature and blockTime and prefer it
    if (metadataExists && metadataPda) {
      try {
        const metaSigsRes = await heliusGetSignaturesFast(metadataPda, heliusUrl, 4000, 0);
        if (metaSigsRes && !(metaSigsRes as any).__error) {
          const metaArr = Array.isArray(metaSigsRes) ? metaSigsRes : ((metaSigsRes as any).result ?? metaSigsRes);
          if (Array.isArray(metaArr) && metaArr.length) {
            const metaSigEntry = metaArr[metaArr.length - 1];
            const metaSig = metaSigEntry?.signature || metaSigEntry?.txHash || metaSigEntry?.tx_hash || null;
            if (metaSig) {
              try {
                const parsedMeta = await getParsedTransaction(metaSig);
                const pbt = (parsedMeta as any)?.blockTime ?? (parsedMeta as any)?.result?.blockTime ?? (parsedMeta as any)?.result?.block_time ?? null;
                if (pbt) {
                  const pnum = Number(pbt > 1e12 ? Math.floor(pbt / 1000) : pbt);
                  if (!earliestBlockTime || pnum < earliestBlockTime) {
                    earliestBlockTime = pnum;
                    firstSignature = metaSig;
                    metadataTimestampUsed = true;
                  }
                }
              } catch (e) {
                // ignore parse errors for metadata signature
              }
            }
          }
        }
      } catch (e) {}
    }

    // Debug: record which signature/time was selected and why (human) and emit structured JSON for tooling
    try {
      const chosenReason = metadataTimestampUsed ? 'metadata-pda' : (earliestBlockTime && firstSignature ? 'parsed-mint-or-metadata' : (earliestBlockTime && !firstSignature ? 'min-signature-blocktime' : 'slot-derived'));
      console.log(`[handleNewMintEvent] mint=${mint} selectedReason=${chosenReason} firstSignature=${firstSignature} earliestBlockTime=${earliestBlockTime} ageSeconds=${ageSeconds}`);
      // Structured log (single-line JSON) to help automated analysis
      try {
        const signatureSummary: any[] = [];
        try {
          const arr = (await heliusGetSignaturesFast(mint, heliusUrl, 2000, 0)) || [];
          const list = Array.isArray(arr) ? arr : ((arr as any).result ?? arr);
          if (Array.isArray(list)) {
            for (const e of list.slice(-10)) {
              signatureSummary.push({ sig: e?.signature || e?.txHash || null, blockTime: e?.blockTime ?? e?.block_time ?? e?.timestamp ?? null });
            }
          }
        } catch (e) {}
        const sel = {
          mint,
          chosenReason,
          metadataTimestampUsed: !!metadataTimestampUsed,
          firstSignature: firstSignature || null,
          earliestBlockTime: earliestBlockTime || null,
          ageSeconds: ageSeconds || null,
          signatureSummary
        };
        console.log(JSON.stringify({ handleNewMintEventSelection: sel }));
      } catch (e) {}
    } catch (e) {}
    let supply: number | null = null;
    try {
      const sup = await getTokenSupply(mint);
      if (sup && sup.value && (sup.value.amount !== undefined)) supply = Number(sup.value.amount);
    } catch (e) {}

    const validated = metadataExists || (supply !== null && supply > 0);
    const detectedAtSec = (mintOrObj as any)?.detectedAtSec ?? Math.floor(Date.now() / 1000);
  const detection = { mint, firstBlockTime: earliestBlockTimeMs, ageSeconds, metadataExists, supply, firstSignature, detectedAtSec };

    // If this mint appears previously in history, skip notifying users to avoid duplicates
    try {
      const prev = await mintPreviouslySeen(mint, earliestBlockTime, firstSignature).catch(() => null);
      if (prev === true) {
        console.log(`[handleNewMintEvent] skipping ${mint} because previously seen`);
        // still return detection info but do not notify
        if (validated) console.log(`ValidatedNewMint (skipped-notify): ${mint} firstBlockTime=${earliestBlockTime} ageSeconds=${ageSeconds} metadata=${metadataExists} supply=${supply}`);
        return detection;
      }
    } catch (e) {}

    if (validated && users && telegram) {
      for (const uid of Object.keys(users)) {
        try {
          const u = users[uid];
          if (!u || !u.strategy || u.strategy.enabled === false) continue;
          const strat = normalizeStrategy(u.strategy);
          const tokenObj = { mint, address: mint, metadataExists, supply, firstBlockTime: detection.firstBlockTime, ageSeconds: detection.ageSeconds, _canonicalAgeSeconds: detection.ageSeconds };
          const matches = await filterTokensByStrategy([tokenObj], strat, { preserveSources: true });
          if (Array.isArray(matches) && matches.length) {
            try {
              const h = hashTokenAddress(mint);
              const msg = `🚀 New token for you: ${mint}\nAge(s): ${detection.ageSeconds ?? 'N/A'}\nMetadata: ${metadataExists}`;
              await telegram.sendMessage(uid, msg);
              await appendSentHash(uid, h);
            } catch (e) {}

            if (u.strategy.autoBuy !== false && Number(u.strategy.buyAmount) > 0) {
              try {
                const amount = Number(u.strategy.buyAmount);
                const result = await unifiedBuy(mint, amount, u.secret);
                if (result && ((result as any).tx || (result as any).success)) {
                  try { await registerBuyWithTarget(u, { address: mint, price: (tokenObj as any).price || 0 }, result, u.strategy.targetPercent || 10); } catch {}
                  const { fee, slippage } = extractTradeMeta(result, 'buy');
                  u.history = u.history || [];
                  const resTx = (result as any)?.tx ?? '';
                  u.history.push(`AutoBuy: ${mint} | ${amount} SOL | Tx: ${resTx} | Fee: ${fee ?? 'N/A'} | Slippage: ${slippage ?? 'N/A'}`);
                  try { saveUsers(users); } catch {}
                  try { await telegram.sendMessage(uid, `✅ AutoBuy executed for ${mint}\nTx: ${resTx}`); } catch {}
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    }

    // log and return detection
    if (validated) console.log(`ValidatedNewMint: ${mint} firstBlockTime=${earliestBlockTime} ageSeconds=${ageSeconds} metadata=${metadataExists} supply=${supply}`);
    else console.log(`CandidateMint (unvalidated): ${mint} firstBlockTime=${earliestBlockTime} ageSeconds=${ageSeconds} metadata=${metadataExists} supply=${supply}`);
    // mark Redis seen flag for short-term dedupe to avoid re-notifying rapidly
    try {
      const rc = await getRedisClient().catch(() => null);
      if (rc) {
        const key = `mint_seen:${String(mint).toLowerCase()}`;
        const ttl = Math.max(5, Math.floor(Number(process.env.MINT_SEEN_TTL_SEC || 60)));
        try { await rc.setEx(key, ttl, '1').catch(() => {}); } catch (e) {}
      }
    } catch (e) {}
    return detection;
  } catch (e) {
    return null;
  }
}

// Cached wrapper around handleNewMintEvent to reduce repeated heavy calls.
// Prefer TTLCache for automatic expiry; fall back to Map when TTLCache isn't available.
const _hh_handle_cache_ttl_ms = Number(process.env.HELIUS_HANDLE_CACHE_TTL_MS || (process.env.HELIUS_HANDLE_CACHE_TTL_S ? Number(process.env.HELIUS_HANDLE_CACHE_TTL_S) * 1000 : 60_000));
let _hh_cache: any;
try {
  _hh_cache = new TTLCache<string, { ts: number; res: any }>(_hh_handle_cache_ttl_ms);
} catch (e) {
  _hh_cache = new Map<string, { ts: number; res: any }>();
}
const _hh_inflight: Map<string, Promise<any>> = new Map();
let _hh_active = 0;
const _hh_queue: Array<() => void> = [];
const _hh_max = Number(process.env.HELIUS_HANDLE_CONCURRENCY ?? 3);

function _hh_enqueue(fn: () => void) {
  _hh_queue.push(fn);
}

function _hh_dequeue() {
  if (_hh_queue.length === 0) return;
  if (_hh_active >= _hh_max) return;
  const fn = _hh_queue.shift();
  try { if (fn) fn(); } catch (e) {}
}

export async function handleNewMintEventCached(mintOrObj: any, ttlSec?: number) {
  try {
    const mint = typeof mintOrObj === 'string' ? mintOrObj : (mintOrObj?.mint || null);
    if (!mint) return null;
    const key = String(mint).toLowerCase();
  const ttl = Number(ttlSec ?? process.env.HELIUS_HANDLE_CACHE_TTL_S ?? 60);
  const now = Math.floor(Date.now() / 1000);
  // Read from TTL-backed cache (support Map fallback)
  let cached: any = null;
  try { cached = (typeof _hh_cache.get === 'function') ? _hh_cache.get(key) : _hh_cache.get(key); } catch (e) { cached = null; }
  if (cached && (now - (cached.ts || 0) <= ttl)) return cached.res;

    // If there's an in-flight request, reuse it
    const inflight = _hh_inflight.get(key);
    if (inflight) return inflight;

    // Create a Promise that will run under concurrency control
    const promise = new Promise<any>((resolve) => {
      const run = () => {
        (async () => {
          _hh_active++;
          try {
            const res = await handleNewMintEvent(mintOrObj).catch(() => null);
            try {
              const entry = { ts: Math.floor(Date.now() / 1000), res };
              // TTLCache.set may accept (key, value, ttlMs) or just (key, value)
              if (typeof _hh_cache.set === 'function') {
                try { _hh_cache.set(key, entry, ttl * 1000); } catch (e) { try { _hh_cache.set(key, entry); } catch (ee) {} }
              } else if (typeof (_hh_cache as Map<any, any>).set === 'function') {
                try { (_hh_cache as Map<any, any>).set(key, entry); } catch (e) {}
              }
            } catch (e) {}
            resolve(res);
          } catch (e) {
            resolve(null);
          } finally {
            _hh_active = Math.max(0, _hh_active - 1);
            try { _hh_inflight.delete(key); } catch (e) {}
            // schedule next queued
            try { _hh_dequeue(); } catch (e) {}
          }
        })();
      };

      if (_hh_active < _hh_max) {
        run();
      } else {
        _hh_enqueue(run);
      }
    });

    try { _hh_inflight.set(key, promise); } catch (e) {}
    return promise;
  } catch (e) { return null; }
}

export async function runFastDiscoveryCli(opts?: { topN?: number; timeoutMs?: number; concurrency?: number }) {
  const topN = opts?.topN ?? 10;
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const concurrency = opts?.concurrency ?? 3;
  const heliusUrl = process.env.HELIUS_FAST_RPC_URL || HELIUS_RPC_URL;

  console.log(`Running fast discovery: topN=${topN} timeoutMs=${timeoutMs} concurrency=${concurrency}`);
  const raw = await fetchDexBoostsRaw(timeoutMs);
  if (!raw) {
    console.error('Failed to fetch DexScreener boosts (empty/timeout)');
    return;
  }
  let data: any[] = [];
  if (Array.isArray(raw)) data = raw as any[];
  else data = raw.data || raw.pairs || [];
  if (!Array.isArray(data) || data.length === 0) {
    console.error('DexScreener returned no items');
    return;
  }

  const map = new Map<string, number>();
  for (const it of data) {
    const mint = extractMintFromItemLocal(it);
    if (!mint) continue;
    const liq = Number(it.liquidityUSD ?? it.liquidity ?? 0) || 0;
    if (!map.has(mint)) map.set(mint, liq);
    else map.set(mint, Math.max(map.get(mint)!, liq));
    if (map.size >= topN * 3) break;
  }

  const list = Array.from(map.entries()).map(([mint, liq]) => ({ mint, liq }));
  list.sort((a, b) => b.liq - a.liq);
  // restrict to Solana chain tokens only: many items include chainId
  const solTop = list.filter((x: any) => {
    // tokenAddress on Solana typically base58 and not 0x-prefixed
    const addr = String(x.mint || '').trim();
    if (!addr) return false;
    return !addr.startsWith('0x') && addr.length >= 32 && addr.length <= 44; // heuristic
  }).slice(0, topN);
  const top = solTop;
  console.log('Top candidates:');
  top.forEach((t, i) => console.log(`${i + 1}. ${t.mint} liquidity=${t.liq}`));

  const results: Array<any> = [];
  const batches: any[] = [];
  for (let i = 0; i < top.length; i += concurrency) batches.push(top.slice(i, i + concurrency));

  // Simple circuit-breaker per-host
  const hostState: Record<string, { recent429: number; cooldownUntil: number }> = {};

  function hostKey(u: string) {
    try { return new URL(u).host; } catch { return u; }
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // Helper: page getSignaturesForAddress via heliusRpc to collect up to max signatures (for deep verification)
  async function collectSignaturesFull(address: string, maxCollect = 2000) {
    const out: any[] = [];
    let before: string | null = null;
    const limit = 1000;
    for (let i = 0; i < 5 && out.length < maxCollect; i++) {
      try {
        const params: any[] = [address, { limit }];
        if (before) params[1].before = before;
        const res = await heliusRpc('getSignaturesForAddress', params, 5000, 0);
        const arr = Array.isArray(res) ? res : (res?.result ?? res);
        if (!Array.isArray(arr) || arr.length === 0) break;
        out.push(...arr);
        if (arr.length < limit) break;
  before = arr[arr.length - 1].signature || (arr[arr.length - 1] as any).txHash || (arr[arr.length - 1] as any).tx_hash || null;
      } catch (e) { break; }
    }
    return out.slice(0, maxCollect);
  }
  for (const batch of batches) {
    await Promise.all(batch.map(async (t: any) => {
      try {
        if (!heliusUrl) { results.push({ mint: t.mint, error: 'no-helius-url' }); return; }
        const hk = hostKey(heliusUrl);
        const state = hostState[hk] || { recent429: 0, cooldownUntil: 0 };
        if (Date.now() < (state.cooldownUntil || 0)) {
          results.push({ mint: t.mint, error: 'host-cooldown' });
          hostState[hk] = state;
          return;
        }

        // Prefer a full paged signatures collection for accuracy (may be slower)
        let r: any = null;
        try {
          const full = await collectSignaturesFull(t.mint, 2000);
          if (Array.isArray(full) && full.length) r = full;
          else r = await heliusGetSignaturesFast(t.mint, heliusUrl, timeoutMs, 0);
        } catch (e) {
          r = await heliusGetSignaturesFast(t.mint, heliusUrl, timeoutMs, 0);
        }

        if (r && r.__error) {
          // handle HTTP 429 counting
          if (String(r.__error).includes('http-429')) {
            state.recent429 = (state.recent429 || 0) + 1;
            if (state.recent429 >= 3) {
              state.cooldownUntil = Date.now() + 10_000;
              state.recent429 = 0;
            }
          }

          // try alternate helius rpc if available
          const alt = HELIUS_RPC_URL;
          if (alt && alt !== heliusUrl) {
            const r2 = await heliusGetSignaturesFast(t.mint, alt, timeoutMs, 0);
            if (r2 && r2.__error) {
              // try direct rpc via heliusRpc
              try {
                const r3 = await heliusRpc('getSignaturesForAddress', [t.mint, { limit: 3 }], timeoutMs, 0);
                const arr3 = Array.isArray(r3) ? r3 : (r3?.result ?? r3);
                const f3 = Array.isArray(arr3) && arr3[0] ? arr3[0] : null;
                const bt3 = f3?.blockTime ?? f3?.block_time ?? f3?.blocktime ?? null;
                if (bt3) {
                    {
                      const btNum = Number(bt3);
                      const btMs = btNum > 1e12 ? btNum : Math.floor(btNum * 1000);
                      results.push({ mint: t.mint, firstBlockTime: btMs, ageSeconds: Math.max(0, Math.floor((Date.now() - btMs) / 1000)), source: 'helius-rpc', earliestSignature: (f3 && (f3.signature || (f3 as any).txHash || (f3 as any).tx_hash)) || null });
                    }
                  hostState[hk] = state;
                  return;
                }
              } catch (e) {
                // ignore
              }

              // final fallback to solscan if configured
              try {
                // Avoid Solscan network fallback when in listener-only mode
                if (LISTENER_ONLY_MODE) {
                  // Skip Solscan call to honor listener-only constraint
                } else {
                  const solscanUrl = `${SOLSCAN_API_URL}/token/${t.mint}/transactions`;
                  const headers: any = {};
                  const sk = getSolscanApiKey(true);
                  if (sk) { headers['x-api-key'] = sk; try { const { maskKey } = await import('./config'); console.log(`[FastFetcher->Solscan] using key=${maskKey(sk)}`); } catch (e) {} }
                  const sresWrap = await withTimeout(axios.get(solscanUrl, { timeout: timeoutMs, headers }), timeoutMs + 200);
                  if (!sresWrap.ok) {
                    // mark as solscan failure
                  } else {
                    const sres = sresWrap.result as any;
                    const arr = sres.data ?? [];
                    const first = Array.isArray(arr) ? arr[0] : null;
                    const bt = first?.blockTime || first?.time || first?.timestamp || null;
                    if (bt) {
                      const meta = makeSourceMeta('solscan', true, { latencyMs: Date.now() - nowSec * 1000, raw: first });
                      {
                        const btNum = Number(bt);
                        const btMs = btNum > 1e12 ? btNum : Math.floor(btNum * 1000);
                        results.push({ mint: t.mint, firstBlockTime: btMs, ageSeconds: Math.max(0, Math.floor((Date.now() - btMs) / 1000)), source: 'solscan', earliestSignature: (first && (first.signature || (first as any).txHash || (first as any).tx_hash)) || null, __meta: meta });
                      }
                      hostState[hk] = state;
                      return;
                    }
                  }
                }
              } catch (e) {
                // ignore
              }

              results.push({ mint: t.mint, error: r.__error });
              hostState[hk] = state;
              return;
            }

            // r2 succeeded: compute earliest blockTime from r2
            const arr2 = Array.isArray(r2) ? r2 : (r2.result ?? r2);
            if (!arr2 || !Array.isArray(arr2) || arr2.length === 0) {
              results.push({ mint: t.mint, error: 'no-signatures' });
              hostState[hk] = state;
              return;
            }

            let bt2: any = null;
            let sig2: string | null = null;
            try {
              const withBt2 = arr2.filter((x: any) => x && (x.blockTime || x.block_time || x.blocktime));
              if (withBt2.length) {
                let min = withBt2[0];
                for (const it of withBt2) {
                  const b = it.blockTime ?? it.block_time ?? it.blocktime ?? 0;
                  if (b && b < (min.blockTime ?? min.block_time ?? min.blocktime ?? Infinity)) min = it;
                }
                bt2 = min.blockTime ?? min.block_time ?? min.blocktime ?? null;
                sig2 = min.signature || (min as any).txHash || (min as any).tx_hash || null;
              } else {
                const last = arr2[arr2.length - 1];
                bt2 = last?.blockTime ?? last?.block_time ?? last?.blocktime ?? null;
                sig2 = last?.signature || (last as any)?.txHash || (last as any)?.tx_hash || null;
              }
            } catch (e) {}

            // If we have a signature, always try parsed tx to get the most accurate (possibly earlier) blockTime.
            if (sig2) {
              try {
                const parsed2 = await getParsedTransaction(sig2);
                const pbt2 = parsed2?.blockTime ?? parsed2?.result?.blockTime ?? parsed2?.result?.block_time ?? parsed2?.result?.blocktime ?? null;
                if (pbt2) {
                  // prefer the earlier timestamp (smallest)
                  const pnum = Number(pbt2 > 1e12 ? Math.floor(pbt2 / 1000) : pbt2);
                  if (!bt2 || pnum < Number(bt2)) bt2 = pnum;
                }
              } catch (e) {}
            }

            if (bt2 && bt2 > 1e12) bt2 = Math.floor(Number(bt2) / 1000);
            if (!bt2) {
              results.push({ mint: t.mint, error: 'no-blockTime' });
              hostState[hk] = state;
              return;
            }

                  {
                    const btNum = Number(bt2);
                    const btMs = btNum > 1e12 ? btNum : Math.floor(btNum * 1000);
                    results.push({ mint: t.mint, firstBlockTime: btMs, ageSeconds: Math.max(0, Math.floor((Date.now() - btMs) / 1000)), source: 'helius-rpc', earliestSignature: sig2 || null });
                  }
            hostState[hk] = state;
            return;
          }

          // if no alt configured or alt equals heliusUrl, just emit the original error
          results.push({ mint: t.mint, error: r.__error });
          hostState[hk] = state;
          return;
        }

        // success path: r contains signatures
        const arr = Array.isArray(r) ? r : (r.result ?? r);
        if (!arr || !Array.isArray(arr) || arr.length === 0) {
          results.push({ mint: t.mint, error: 'no-signatures' });
          return;
        }

        // compute earliest blockTime across signatures
        let minBt: number | null = null;
        let earliestSig: string | null = null;
        for (const s of arr) {
          let btv = s?.blockTime ?? s?.block_time ?? s?.blocktime ?? s?.timestamp ?? null;
          if (btv && btv > 1e12) btv = Math.floor(Number(btv) / 1000);
          if (btv && (!minBt || Number(btv) < minBt)) {
            minBt = Number(btv);
            earliestSig = s?.signature || (s as any)?.txHash || (s as any)?.tx_hash || null;
          }
        }

        // If we found an earliestSig from signatures, verify with getTransaction (it may be earlier or more accurate)
        if (earliestSig) {
          try {
            const parsed = await getParsedTransaction(earliestSig);
            const pbt = parsed?.blockTime ?? parsed?.result?.blockTime ?? parsed?.result?.block_time ?? parsed?.result?.blocktime ?? null;
            if (pbt) {
              const pnum = Number(pbt > 1e12 ? Math.floor(pbt / 1000) : pbt);
              if (!minBt || pnum < minBt) minBt = pnum;
            }
          } catch (e) {}
        } else {
          const sigTry = arr[arr.length - 1]?.signature || (arr[arr.length - 1] as any)?.txHash || (arr[arr.length - 1] as any)?.tx_hash || null;
          if (sigTry) {
            try {
              const parsed = await getParsedTransaction(sigTry);
              const pbt = parsed?.blockTime ?? parsed?.result?.blockTime ?? parsed?.result?.block_time ?? parsed?.result?.blocktime ?? null;
              if (pbt) minBt = Number(pbt > 1e12 ? Math.floor(pbt / 1000) : pbt);
              earliestSig = sigTry;
            } catch (e) {}
          }
        }

        if (!minBt) {
          results.push({ mint: t.mint, error: 'no-blockTime' });
          hostState[hk] = state;
          return;
        }

        // If token looks very young (<=10min), deep-verify by paging full signature history to avoid false-youth
        try {
          const ageNow = nowSec - Number(minBt);
          if (ageNow <= 600) {
            const fullSigs = await collectSignaturesFull(t.mint, 2000);
            if (Array.isArray(fullSigs) && fullSigs.length) {
              let fullMin: number | null = null;
              let candidateSig: string | null = null;
              for (const s of fullSigs) {
                let btv = s?.blockTime ?? s?.block_time ?? s?.blocktime ?? s?.timestamp ?? null;
                if (btv && btv > 1e12) btv = Math.floor(Number(btv) / 1000);
                if (btv && (!fullMin || Number(btv) < fullMin)) { fullMin = Number(btv); candidateSig = s?.signature || (s as any)?.txHash || (s as any)?.tx_hash || null; }
              }
              if (candidateSig) {
                try {
                  const parsed = await getParsedTransaction(candidateSig);
                  const pbt = parsed?.blockTime ?? parsed?.result?.blockTime ?? parsed?.result?.block_time ?? parsed?.result?.blocktime ?? null;
                  if (pbt) {
                    const pnum = Number(pbt > 1e12 ? Math.floor(pbt / 1000) : pbt);
                    if (!fullMin || pnum < fullMin) fullMin = pnum;
                  }
                } catch (e) {}
              }
              if (fullMin && (!minBt || fullMin < minBt)) minBt = fullMin;
            }
          }
        } catch (e) {}

  {
    const btNum = Number(minBt);
    const btMs = btNum > 1e12 ? btNum : Math.floor(btNum * 1000);
    results.push({ mint: t.mint, firstBlockTime: btMs, ageSeconds: Math.max(0, Math.floor((Date.now() - btMs) / 1000)), source: 'helius-fast', earliestSignature: earliestSig || null });
  }
        hostState[hk] = state;
        return;
      } catch (e) {
        results.push({ mint: t.mint, error: 'exception' });
        return;
      }
    }));

    // small pause between batches
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log('\nFast enrichment results (JSON lines):');
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
}

// If executed directly, run with defaults
if (require && require.main === module) {
  (async () => {
    await runFastDiscoveryCli({ topN: 10, timeoutMs: 3000, concurrency: 3 });
  })();
}

// Fetch latest N unique mints from multiple sources: Helius WS recent events, DexScreener boosts, and Solana RPC (via Helius parse-history)
export async function fetchLatest5FromAllSources(n = 5) {
  const axiosLocal = axios;
  const heliusEvents: string[] = [];
  try {
    const { getRecentHeliusEvents } = require('./heliusWsListener');
    const evs = getRecentHeliusEvents();
    for (const e of evs) {
      if (e && e.mint) heliusEvents.push(e.mint);
      if (heliusEvents.length >= n) break;
    }
  } catch (e) {}

  // DexScreener top N (use limiter + structured meta)
  const dex: string[] = [];
  try {
    const dsRaw = await fetchDexBoostsRaw(3000);
    let data: any[] = [];
    if (dsRaw) {
      if ((dsRaw as any).data) data = (dsRaw as any).data;
      else if (Array.isArray(dsRaw)) data = dsRaw as any[];
      else if ((dsRaw as any).__meta && (dsRaw as any).data) data = (dsRaw as any).data;
    }
    for (const it of data) {
      const m = extractMintFromItemLocal(it);
      const norm = normalizeMintCandidate(m);
      if (norm && !dex.includes(norm)) dex.push(norm);
      if (dex.length >= n) break;
    }
  } catch (e) {}

  // Solana parse history approach: use HELIUS_PARSE_HISTORY_URL template if available
  const heliusHistory: string[] = [];
  try {
  const parseUrlTemplate = HELIUS_PARSE_HISTORY_URL;
    if (parseUrlTemplate) {
      // if parseHistory supports an endpoint to query recent addresses, we try a small approach: query top dex list mints for their first tx
      const candidates = dex.slice(0, Math.max(n, 10));
      for (const c of candidates) {
        try {
          const url = parseUrlTemplate.replace('{address}', c);
          const res = await axiosLocal.get(url, { timeout: 2000 });
          // if it returns array, and first tx exists, consider it a candidate
          const arr = res.data ?? [];
          if (Array.isArray(arr) && arr.length) {
            heliusHistory.push(c);
          }
        } catch (err) {}
        if (heliusHistory.length >= n) break;
      }
    }
  } catch (e) {}

  // Optional validation via helius getAccountInfo to ensure the mint/account exists (reduce 404s)
  const shouldValidate = (process.env.HELIUS_VALIDATE_ACCOUNTS || 'false').toLowerCase() === 'true';
  async function maybeValidate(list: string[]) {
    if (!shouldValidate) return list.slice(0, n);
    const out: string[] = [];
    const concurrency = Number(process.env.HELIUS_VALIDATE_CONCURRENCY || 3);
    const limiter = createLimiter(concurrency);
    await Promise.all(list.map((a) => limiter(async () => {
      try {
        const acct = await getAccountInfo(a);
        if (acct && acct.value) out.push(a);
      } catch (e) {}
    })));
    return out.slice(0, n);
  }

  const heliusEventsNorm = Array.from(new Set(heliusEvents)).map(x=>normalizeMintCandidate(x)).filter(Boolean) as string[];
  const heliusHistoryNorm = Array.from(new Set(heliusHistory)).map(x=>normalizeMintCandidate(x)).filter(Boolean) as string[];

  return {
    heliusEvents: await maybeValidate(heliusEventsNorm),
    dexTop: dex.slice(0, n),
    heliusHistory: await maybeValidate(heliusHistoryNorm),
  };
}

// --- Test helper: fetch latest 5 unique mints, enqueue enrichment, then filter via a simple default strategy ---
export async function testFetchEnrichFilterLatest() {
  try {
    const limit = 5;
    // 1) fetch latest candidates from combined sources
    const subs = await fetchLatest5FromAllSources(limit);
    const mints: string[] = Array.from(new Set([...(subs.heliusEvents || []), ...(subs.dexTop || []), ...(subs.heliusHistory || [])])).slice(0, limit);

    // 2) prepare enrichment manager and handler (reuse handleNewMintEvent if available)
    const { createEnrichmentManager } = require('./heliusEnrichmentQueue');
    const mgr = createEnrichmentManager({ ttlSeconds: 300, maxConcurrent: 3 });
    // small list to collect results
    const enriched: any[] = [];

    // use existing handleNewMintEvent if present as hf; otherwise use a lightweight enrichment wrapper
    let hf: any = null;
    try { const ff = require('./fastTokenFetcher'); hf = ff && (ff.handleNewMintEvent || ff.default && ff.default.handleNewMintEvent); } catch(e) {}
    if (!hf) {
      // fallback: use enrichTokenTimestamps on single token objects
      const { enrichTokenTimestamps } = require('./utils/tokenUtils');
      hf = async (evt: any) => { const addr = evt && (evt.mint || evt.address); const token = { tokenAddress: addr }; await enrichTokenTimestamps([token], { batchSize: 1, delayMs: 0 }); return token; };
    }

    // 3) enqueue enrich jobs and wait for them
    const promises = mints.map((m: string) => mgr.enqueue({ mint: m, detectedAt: Date.now() }, hf));
    const results = await Promise.all(promises.map(p => p.catch((e:any)=>({ error: String(e && e.message || e) }))));

    // 4) build a naive default strategy requiring some on-chain evidence (minFreshnessScore 20)
    const defaultStrategy = { enabled: true, minFreshnessScore: 20 };
    // 5) get canonical global cache and filter using filterTokensByStrategy (import from bot/strategy)
    const cache = getGlobalFetchCache();
    const tu = require('./utils/tokenUtils');
    // map tokens by mint
    const candidates = mints.map((m:any) => {
      const found = (cache || []).find((c:any) => (c.tokenAddress || c.address || c.mint || '').toString() === (m||'').toString());
      return found ? found : { tokenAddress: m, mint: m };
    });
    const { filterTokensByStrategy } = require('./bot/strategy');
    const filtered = await filterTokensByStrategy(candidates, defaultStrategy).catch(() => []);

    return { mints, results, candidates, filtered };
  } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
}

// If run directly with command `node fastTokenFetcher.js latest` print latest 5 from each source
if (require && require.main === module) {
  const arg = process.argv[2] || '';
  if (arg === 'latest') {
    (async () => {
      const res = await fetchLatest5FromAllSources(5);
      console.log('Latest from Helius WS buffer:', res.heliusEvents);
      console.log('Top from DexScreener:', res.dexTop);
      console.log('Helius parse-history hits:', res.heliusHistory);
      process.exit(0);
    })();
  }
}
