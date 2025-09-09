// Smart field-specific formatting for token stats
function fmtField(val: number | string | undefined | null, field: string): string {
  if (val === undefined || val === null || val === '-' || val === '' || val === 'N/A' || val === 'null' || val === 'undefined') return 'Not available';
  let num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num)) return String(val);
  switch (field) {
    case 'price':
      if (Math.abs(num) >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
      if (Math.abs(num) >= 0.01) return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
      return num.toLocaleString(undefined, { maximumFractionDigits: 8 });
    case 'marketCap':
    case 'liquidity':
    case 'volume':
      return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    case 'holders':
    case 'age':
      return Math.round(num).toLocaleString();
    default:
      return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}
// Suppress noisy 429/retry lines globally (guarded so we only patch once)
try {
  // @ts-ignore
  if (!globalThis.__SUPPRESS_429_LOGS) {
    // preserve originals
    const _w = console.warn.bind(console);
    const _e = console.error.bind(console);
    const _l = console.log.bind(console);
  const _filter = /(Server responded with 429 Too Many Requests|Retrying after|Too Many Requests|entering cooldown|HTTP failure for)/i;
    console.warn = (...args: any[]) => {
      try {
        const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        if (_filter.test(s)) return;
      } catch (e) {}
      _w(...args);
    };
    console.error = (...args: any[]) => {
      try {
        const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        if (_filter.test(s)) return;
      } catch (e) {}
      _e(...args);
    };
    console.log = (...args: any[]) => {
      try {
        const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        if (_filter.test(s)) return;
      } catch (e) {}
      _l(...args);
    };
    // @ts-ignore
    globalThis.__SUPPRESS_429_LOGS = true;
  }
} catch (e) {}

// Additionally filter raw stdout/stderr writes (some libs write directly) to hide noisy 429 retry lines
try {
  // @ts-ignore
  if (!globalThis.__SUPPRESS_429_STDIO) {
    const _stdoutWrite = process.stdout.write.bind(process.stdout);
    const _stderrWrite = process.stderr.write.bind(process.stderr);
  const _filterStd = /(Server responded with 429 Too Many Requests|Retrying after|Too Many Requests|entering cooldown|HTTP failure for)/i;
    // @ts-ignore
    process.stdout.write = (chunk: any, encoding?: any, cb?: any) => {
      try {
        const s = typeof chunk === 'string' ? chunk : chunk && chunk.toString ? chunk.toString() : '';
        if (_filterStd.test(s)) return true;
      } catch (e) {}
      // @ts-ignore
      return _stdoutWrite(chunk, encoding, cb);
    };
    // @ts-ignore
    process.stderr.write = (chunk: any, encoding?: any, cb?: any) => {
      try {
        const s = typeof chunk === 'string' ? chunk : chunk && chunk.toString ? chunk.toString() : '';
        if (_filterStd.test(s)) return true;
      } catch (e) {}
      // @ts-ignore
      return _stderrWrite(chunk, encoding, cb);
    };
    // @ts-ignore
    globalThis.__SUPPRESS_429_STDIO = true;
  }
} catch (e) {}
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import {
  HELIUS_RPC_URL,
  HELIUS_PARSE_HISTORY_URL,
  HELIUS_API_KEY,
  HELIUS_CACHE_TTL_MS,
  HELIUS_RETRY_MAX_ATTEMPTS,
  HELIUS_RETRY_BASE_MS,
  HELIUS_RETRY_JITTER_MS,
  HELIUS_FALLBACK_ENABLED,
  HELIUS_SIG_LIMIT,
  HELIUS_RPC_CONCURRENCY,
  HELIUS_BATCH_SIZE,
  HELIUS_BATCH_DELAY_MS,
  HELIUS_ENRICH_LIMIT,
} from '../config';

// Additional config flags used in this module
import {
  HELIUS_USE_WEBSOCKET,
  HELIUS_WS_URL_RAW,
  SOLSCAN_API_URL,
  SOLSCAN_FALLBACK_ENABLED,
  ENABLE_ONCHAIN_FRESHNESS,
  ONCHAIN_FRESHNESS_TIMEOUT_MS,
  FRESHNESS_MAX_AGE_MINUTES,
  FRESHNESS_SCORE_TIMEOUT_MS,
} from '../config';
import { getSolscanApiKey, getJupiterApiKey } from '../config';

// Mirror listener-only guard used elsewhere: when true, avoid making outbound HTTP/RPC calls
const LISTENER_ONLY_MODE = String(process.env.LISTENER_ONLY_MODE ?? process.env.LISTENER_ONLY ?? 'true').toLowerCase() === 'true';


// ========== General Constants ==========
const EMPTY_VALUES = [undefined, null, '-', '', 'N/A', 'null', 'undefined'];

// Simple heuristic to detect system/program addresses that should be ignored as tokens
export function isSystemMint(addr: string | null | undefined): boolean {
  if (!addr || typeof addr !== 'string') return false;
  const a = addr.trim();
  if (!a) return false;
  const sysPatterns = [/^So11111111111111111111111111111111111111112$/, /^11111111111111111111111111111111$/, /^TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA$/i];
  for (const p of sysPatterns) if (p.test(a)) return true;
  return false;
}

// Unified field map (easily extendable)
const FIELD_MAP: Record<string, string[]> = {
  marketCap: ['marketCap', 'fdv', 'totalAmount', 'amount'],
  liquidity: ['liquidity', 'liquidityUsd'],
  volume: ['volume', 'amount', 'totalAmount'],
  age: ['age', 'createdAt'],
};

const missingFieldsLog: Set<string> = new Set();
const MAX_MISSING_FIELDS = Number(process.env.MAX_MISSING_FIELDS_LOG || 200);

// Simple in-memory cache for first-tx timestamps to reduce repeat RPC/HTTP calls
const firstTxCache: Map<string, { ts: number; expiresAt: number }> = new Map();
const FIRST_TX_CACHE_MS = Number(process.env.FIRST_TX_CACHE_MS || 10 * 60 * 1000);
const FIRST_TX_CACHE_FILE = process.env.FIRST_TX_CACHE_FILE || path.join(process.cwd(), '.first_tx_cache.json');

// No disk persistence for firstTxCache per listener-only / no-central-cache requirement
export function getCachedFirstTx(mint: string): number | null {
  const v = firstTxCache.get(mint);
  if (!v) return null;
  if (v.expiresAt < Date.now()) { firstTxCache.delete(mint); return null; }
  return v.ts;
}
export function setCachedFirstTx(mint: string, ts: number) {
  try { firstTxCache.set(mint, { ts, expiresAt: Date.now() + FIRST_TX_CACHE_MS }); } catch {}
}



// Extract field value (supports nested paths)
export function getField(token: any, ...fields: string[]): any {
  for (let f of fields) {
    const mapped = FIELD_MAP[f] || [f];
    for (const mf of mapped) {
      // دعم المسارات المتداخلة
      const path = mf.split('.');
      let val = token;
      for (const key of path) {
        if (val == null) break;
        val = val[key];
      }
      if (!EMPTY_VALUES.includes(val)) return extractNumeric(val, val);
      if (mf in token && !EMPTY_VALUES.includes(token[mf])) return extractNumeric(token[mf], token[mf]);
    }
  }
  if (fields.length > 0) {
    try {
      if (missingFieldsLog.size < MAX_MISSING_FIELDS) missingFieldsLog.add(fields[0]);
    } catch (e) {}
  }
  return undefined;
}

// دالة لعرض الحقول المفقودة (للمطور أو المستخدم)
export function getMissingFields(): string[] {
  return Array.from(missingFieldsLog);
}

// Extract a number from any value (helper)
function extractNumeric(val: any, fallback?: number): number | undefined {
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string' && !isNaN(Number(val))) return Number(val);
  if (val && typeof val === 'object') {
    for (const k of ['usd','h24','amount','value','total','native','sol']) {
      if (typeof val[k] === 'number' && !isNaN(val[k])) return val[k];
    }
    for (const k in val) if (typeof val[k] === 'number' && !isNaN(val[k])) return val[k];
  }
  return fallback;
}

// Small helper used by message formatting. Make it a top-level function so compiled
// builds always include it (prevents "nice is not defined" runtime errors).
export function nice(v: any) {
  return (v === undefined || v === null || v === 'Not available') ? '—' : v;
}

// Parse duration input (supports numbers and strings like '30s','5m','2h')
export function parseDuration(v: string | number | undefined | null): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') {
  // Treat plain numeric values as seconds (explicit and unambiguous)
  const n = Number(v);
  if (isNaN(n)) return undefined;
  return Math.floor(n);
  }
  const s = String(v).trim().toLowerCase();
  const match = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|day|days)?$/);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2] || 's';
  switch (unit) {
    case 's': case 'sec': case 'secs': case 'seconds': return Math.floor(n);
    case 'm': case 'min': case 'mins': case 'minutes': return Math.floor(n * 60);
    case 'h': case 'hr': case 'hrs': case 'hours': return Math.floor(n * 3600);
    case 'd': case 'day': case 'days': return Math.floor(n * 86400);
    default: return Math.floor(n * 60);
  }
}

// Normalize candidate mint strings: extract base58 substrings and validate via PublicKey
export function normalizeMintCandidate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Remove common wrappers and trailing separators but keep labels like pump/bonk
  s = s.replace(/(?:\s+)?(?:\[?solana\]?|\(?sol\)?)/i, '');
  s = s.replace(/^https?:\/\/.+\//i, '');
  s = s.replace(/^chain:\w+\//i, '');
  s = s.replace(/[^A-Za-z0-9\-\_]+$/i, '');

  // If it's an obvious ethereum hex address, skip
  if (s.startsWith('0x') || /^[0-9a-fA-F]{40}$/.test(s)) return null;

  // If the whole string is a plausible base58 public key, validate via PublicKey
  try {
    if (s.length >= 32 && s.length <= 50) {
      const pk = new PublicKey(s);
      return pk.toBase58();
    }
  } catch (e) {}

  // Otherwise, attempt to extract the first base58-like substring (32-44 chars) from the raw string
  try {
    const m = s.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
    if (m && m.length) {
      for (const candidate of m) {
        try {
          const pk2 = new PublicKey(candidate);
          return pk2.toBase58();
        } catch (e) {
          // try next
        }
      }
    }
  } catch (e) {}

  // fallback: try bs58 decode to see if decodes to reasonable length
  try {
    const bs58 = require('bs58');
    const dec = bs58.decode(s);
    if (dec && dec.length >= 32) return s;
  } catch (ee) {}

  return null;
}


export async function retryAsync<T>(fn: () => Promise<T>, retries = 0, delayMs = 2000): Promise<T> {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const retryAfter = err?.response?.headers?.['retry-after'];
      const wait = retryAfter ? Number(retryAfter) * 1000 : delayMs;
      if (i < retries - 1) await new Promise(res => setTimeout(res, wait));
    }
  }
  throw lastErr;
}


// ========== Fetch token data from CoinGecko and DexScreener ==========
export async function fetchSolanaFromCoinGecko(): Promise<any> {
  // CoinGecko disabled in listener-only mode to avoid external network calls outside the program-listener.
  console.log('[fetchSolanaFromCoinGecko] disabled in listener-only mode');
  return null;
}


// ========== User-editable fields (for strategies) ==========



/**
 * STRATEGY_FIELDS: Only user-editable filter fields (used for filtering tokens)
 * Users can only set these fields in their strategy.
 */
export type StrategyField = { key: string; label: string; type: string; optional: boolean; tokenField?: string };
export let STRATEGY_FIELDS: StrategyField[] = [
  { key: 'minMarketCap', label: 'Minimum Market Cap (USD)', type: 'number', optional: false, tokenField: 'marketCap' },
  { key: 'minLiquidity', label: 'Minimum Liquidity (USD)', type: 'number', optional: false, tokenField: 'liquidity' },
  { key: 'minVolume', label: 'Minimum Volume (24h USD)', type: 'number', optional: false, tokenField: 'volume' },
  { key: 'minAge', label: 'Minimum Age (use suffix e.g. "30s", "2m" or plain number = seconds)', type: 'string', optional: false, tokenField: 'age' }
];


// ========== DexScreener API Integration ==========

/**
 * Fetch token profiles from DexScreener API.
 * @param chainId Optional chainId to filter (e.g., 'solana').
 * @param extraParams Optional object for more query params.
 * @returns Array of token profiles.
 *
 * If the API does not support filtering, filtering will be done locally.
 */
export async function fetchDexScreenerProfiles(chainId?: string, extraParams?: Record<string, string>): Promise<any[]> {
  // DexScreener profiles disabled. Listener-only mode: return empty list.
  return [];
}

export async function fetchDexScreenerPairsForSolanaTokens(tokenAddresses: string[]): Promise<any[]> {
  // DexScreener pairs disabled. Listener-only mode: return empty list.
  return [];
}

/**
 * Fetch Solana tokens (or any chain) from DexScreener with optional params.
 * @param chainId Chain to fetch (default: 'solana')
 * @param extraParams Optional query params (e.g. { limit: '100' })
 */
export async function fetchDexScreenerTokens(chainId: string = 'solana', extraParams?: Record<string, string>): Promise<any[]> {
  // Listener-only implementation: query the program-listener for fresh mints
  try {
    // require the listener module relative to this util
    // tslint:disable-next-line:no-var-requires
    const seq = require('../../scripts/sequential_10s_per_program.js');
    if (!seq || typeof seq.collectFreshMints !== 'function') return [];
    const maxCollect = Number(extraParams?.limit ? Math.max(1, Number(extraParams.limit)) : 50);
    const timeoutMs = 20000;
    const maxAgeSec = undefined;
    // support per-call collector strictness from extraParams.collectorStrict
    let strictOverride: boolean | undefined = undefined;
    try {
      if (extraParams && Object.prototype.hasOwnProperty.call(extraParams, 'collectorStrict')) {
        const v = (extraParams as any).collectorStrict;
        if (v === 'true' || v === '1' || v === 1 || v === true) strictOverride = true;
        else if (v === 'false' || v === '0' || v === 0 || v === false) strictOverride = false;
      }
    } catch (e) {}
  const items: any[] = await seq.collectFreshMints({ maxCollect, timeoutMs, maxAgeSec, strictOverride, onlyPrintExplicit: true }).catch(() => []);
    if (!Array.isArray(items) || items.length === 0) return [];
    return items.map((it: any) => {
      // listener may return either simple mint strings or enriched token objects
      if (!it) return null;
      if (typeof it === 'string') return { tokenAddress: it, address: it, mint: it, sourceCandidates: true, __listenerCollected: true };
      // merge and normalize fields
      const addr = it.tokenAddress || it.address || it.mint || null;
      return Object.assign({ tokenAddress: addr, address: addr, mint: addr, sourceCandidates: true, __listenerCollected: true }, it);
    }).filter(Boolean);
  } catch (e) {
    console.error('[fetchDexScreenerTokens] listener fetch failed:', e?.message || e);
    return [];
  }
}


// ===== Enrichment helpers (Helius primary, RPC fallback) =====
const heliusTimestampCache: Record<string, { ts: number | null; fetchedAt: number }> = {};
// Per-host state to avoid tight retry loops when a provider starts returning 429s
const heliusHostState: Record<string, { failureCount: number; cooldownUntil: number }> = {};
const enrichmentMetrics: {
  heliusCalls: number; heliusFailures: number; heliusTotalMs: number;
  rpcCalls: number; rpcFailures: number; rpcTotalMs: number;
  solscanCalls: number; solscanFailures: number; solscanTotalMs: number;
} = {
  heliusCalls: 0, heliusFailures: 0, heliusTotalMs: 0,
  rpcCalls: 0, rpcFailures: 0, rpcTotalMs: 0,
  solscanCalls: 0, solscanFailures: 0, solscanTotalMs: 0
};

async function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function getFirstTxTimestampFromRpc(address: string): Promise<number | null> {
  // Avoid RPC/network calls in listener-only mode; return null to indicate unknown.
  if (LISTENER_ONLY_MODE) return null;
  // Check lightweight global first-tx cache
  try {
    const cached = getCachedFirstTx(address);
    if (cached) return cached;
  } catch (e) {}
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const rpcUrl = HELIUS_RPC_URL || process.env.MAINNET_RPC;
    if (!rpcUrl) return null;
    const conn = new Connection(rpcUrl, { commitment: 'confirmed' } as any);
    const pub = new PublicKey(address);
    const start = Date.now();
    enrichmentMetrics.rpcCalls++;
    // Page signatures to try to reach the earliest transaction available (may be slow)
    const collectSignaturesFull = async (maxCollect = 2000) => {
      const out: any[] = [];
      let before: string | null = null;
      const limit = 1000;
      for (let i = 0; i < 5 && out.length < maxCollect; i++) {
        try {
          const params: any = { limit };
          if (before) params.before = before;
          const page = await conn.getSignaturesForAddress(pub, params as any);
          if (!Array.isArray(page) || page.length === 0) break;
          out.push(...page);
          if (page.length < limit) break;
          before = page[page.length - 1].signature || (page[page.length - 1] as any).txHash || (page[page.length - 1] as any).tx_hash || null;
        } catch (e) {
          break;
        }
      }
      return out.slice(0, maxCollect);
    };

    const sigs = await collectSignaturesFull(Number(process.env.RPC_SIG_PAGE_MAX || 2000));
    if (!sigs || sigs.length === 0) {
      enrichmentMetrics.rpcTotalMs += (Date.now() - start);
      return null;
    }

    // fetch transactions in bounded concurrency and compute earliest blockTime
    let earliestMs: number | null = null;
    const concurrency = 4;
    for (let i = 0; i < sigs.length; i += concurrency) {
      const slice = sigs.slice(i, i + concurrency);
      const txs = await Promise.all(slice.map((s: any) => conn.getTransaction(s.signature, { commitment: 'confirmed' } as any).catch(() => null)));
      for (const tx of txs) {
        try {
          const bt = tx?.blockTime;
          if (!bt) continue;
          const ms = (bt > 1e9 && bt < 1e12) ? bt * 1000 : (bt > 1e12 ? bt : bt * 1000);
          if (!earliestMs || ms < earliestMs) earliestMs = ms;
        } catch (e) {
          // ignore per-tx errors
        }
      }
      // small pause to avoid RPC bursts
      await sleep(50);
    }
    enrichmentMetrics.rpcTotalMs += (Date.now() - start);
    if (earliestMs) try { setCachedFirstTx(address, earliestMs); } catch (e) {}
    return earliestMs;
    } catch (e) {
      enrichmentMetrics.rpcFailures++;
      try {
        const status = (e as any)?.response?.status || (e as any)?.code || 'n/a';
        const safeSnippet = (v: any, n = 200) => { try { if (!v && v !== 0) return ''; if (typeof v === 'string') return v.slice(0,n); return JSON.stringify(v).slice(0,n); } catch { try { return String(v).slice(0,n); } catch { return ''; } } };
        const dataSnippet = (() => { try { const d = (e as any)?.response?.data; return safeSnippet(d,200); } catch { return ''; } })();
      console.error(`[RPC] getFirstTxTimestampFromRpc failed for ${address}: status=${status} msg=${String((e as any)?.message || e)} data=${dataSnippet}`);
    } catch(_) {}
    return null;
  }
}

async function getFirstTxTimestampFromHelius(address: string): Promise<number | null> {
  // Avoid Helius HTTP/RPC calls in listener-only mode to keep active flows local.
  if (LISTENER_ONLY_MODE) return null;
  // Prefer Helius RPC (if provided) which is typically higher-rate for paid keys.
  const heliusRpc = HELIUS_RPC_URL || process.env.MAINNET_RPC;
  const apiUrlTemplate = HELIUS_PARSE_HISTORY_URL || '';
  // cache check (global lightweight cache first)
  try {
    const gc = getCachedFirstTx(address);
    if (gc) return gc;
  } catch (e) {}
  // module cache
  const cached = heliusTimestampCache[address];
  const ttl = Number(HELIUS_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
  if (cached && (Date.now() - cached.fetchedAt) < ttl) return cached.ts;

  // Helper: HTTP GET with retry/backoff honoring Retry-After
  async function heliusHttpGetWithRetries(url: string, maxAttempts = Number(HELIUS_RETRY_MAX_ATTEMPTS || 1)) {
    const axios = (await import('axios')).default;
    let lastErr: any = null;
    const baseMs = Number(HELIUS_RETRY_BASE_MS || 500);
    const jitterMs = Number(HELIUS_RETRY_JITTER_MS || 300);
    // derive host key for simple circuit breaker / cooldown
    let hostKey: string | null = null;
    try { hostKey = new URL(url).host; } catch (e) { hostKey = null; }
    if (hostKey) {
      const state = heliusHostState[hostKey];
      if (state && state.cooldownUntil && Date.now() < state.cooldownUntil) {
        // Fail fast silently (no repeated logs)
        const err: any = new Error(`Host ${hostKey} in cooldown`);
        err.code = 'HELIUS_HOST_COOLDOWN';
        throw err;
      }
    }
    // Clamp attempts to 1 if host previously entered cooldown to avoid tight retry loops
    let effectiveMaxAttempts = maxAttempts;
    try {
      const hostKeyTmp = new URL(url).host;
      const st = heliusHostState[hostKeyTmp];
      if (st && st.cooldownUntil && Date.now() < st.cooldownUntil) {
        effectiveMaxAttempts = 1;
      }
    } catch (e) {}

    for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
      const start = Date.now();
      try {
  enrichmentMetrics.heliusCalls++;
  const headers: Record<string,string> = { 'Accept': 'application/json' };
  try { const { getHeliusApiKey, maskKey } = await import('../config'); const _hk = getHeliusApiKey(); if (_hk) { headers['x-api-key'] = _hk; try { console.log(`[Helius] using key=${maskKey(_hk)}`); } catch (e) {} } } catch (e) {}
        const r = await axios.get(url, { timeout: 20000, headers });
        enrichmentMetrics.heliusTotalMs += (Date.now() - start);
        // on success, reset host failure count
        if (hostKey && heliusHostState[hostKey]) {
          heliusHostState[hostKey].failureCount = 0;
          heliusHostState[hostKey].cooldownUntil = 0;
        }
        return r;
      } catch (err: any) {
        lastErr = err;
        const status = err?.response?.status;
        if (!status || status >= 500 || status === 429) enrichmentMetrics.heliusFailures++;
        const retryAfter = err?.response?.headers?.['retry-after'];
        // If non-retryable client error (4xx other than 429), bail
        if (status && status >= 400 && status < 500 && status !== 429) break;
        // If host is returning 429s, increment failure counter and set longer cooldown
        if (status === 429 && hostKey) {
          const state = heliusHostState[hostKey] || { failureCount: 0, cooldownUntil: 0 };
          state.failureCount = (state.failureCount || 0) + 1;
          // exponential cooldown (cap at 5 minutes) + jitter
          const cooldown = Math.min(baseMs * Math.pow(2, state.failureCount), 5 * 60 * 1000) + Math.floor(Math.random() * jitterMs);
          state.cooldownUntil = Date.now() + cooldown;
          heliusHostState[hostKey] = state;
          // Avoid repeated 'Retrying...' style logging; only log when first entering cooldown
          if (state.failureCount === 1) {
            console.warn(`[Helius] ${hostKey} responded 429 — entering cooldown ~${Math.round(cooldown/1000)}s`);
          }
          // Fail fast: do not spin retries for 429 — rely on cooldown
          break;
        }
        // If server provided Retry-After, honor it
        if (retryAfter) {
          const ra = Number(retryAfter);
          if (!isNaN(ra) && ra > 0) {
            await sleep(ra * 1000);
            continue;
          }
        }
        // Default exponential backoff with jitter
        if (attempt < maxAttempts) {
          let wait = Math.min(baseMs * Math.pow(2, attempt - 1), 30000);
          wait += Math.floor(Math.random() * jitterMs);
          await sleep(wait);
          continue;
        }
        break;
      }
    }
    // Final: emit a concise single-line error (no stack) and throw, include headers/data snippets
    try {
      const status = lastErr?.response?.status || lastErr?.code || 'n/a';
  const headersSnippet = (() => { try { return lastErr?.response?.headers ? Object.keys(lastErr.response.headers).slice(0,5).join(',') : ''; } catch { return ''; } })();
  const dataSnippet = (() => { try { const d = lastErr?.response?.data; if (!d) return ''; if (typeof d === 'string') return d.slice(0,200); try { return JSON.stringify(d).slice(0,200); } catch { return String(d).slice(0,200); } } catch { return ''; } })();
      const host = hostKey || 'unknown-host';
      console.error(`[Helius] HTTP failure for ${host} after retries (status=${status}) headers=[${headersSnippet}] data=${dataSnippet} message=${String(lastErr?.message || lastErr)}`);
    } catch (e) {
      console.error('[Helius] HTTP failure after retries');
    }
    throw lastErr;
  }

  try {
    // Optional: try Helius WebSocket RPC when configured (preferred for live parsed streams)
  // NOTE: disabled per-address WS attempts to reduce 429s; use parse/history HTTP or RPC batch instead
  if (false && HELIUS_USE_WEBSOCKET && HELIUS_WS_URL_RAW) {
      try {
  const wsMod = await import('ws');
  const WebSocketCtor: any = (wsMod && (wsMod.default || wsMod));
  const wsUrl = HELIUS_WS_URL_RAW as string;
  const socket: any = new WebSocketCtor(wsUrl);
        // wait open
        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('ws open timeout')), 5000);
          socket.once('open', () => { clearTimeout(to); resolve(null); });
          socket.once('error', (err: any) => { clearTimeout(to); reject(err); });
        });
  const sigLimit = Number(HELIUS_SIG_LIMIT || 20);
        const reqId = Math.floor(Math.random() * 1e9);
        const req = { jsonrpc: '2.0', id: reqId, method: 'getSignaturesForAddress', params: [address, { limit: sigLimit }] };
        socket.send(JSON.stringify(req));
        const sigsResp: any = await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('ws sigs timeout')), 10000);
          const onMsg = (msg: any) => {
            try {
              const o = JSON.parse(msg.toString());
              if (o.id === reqId) {
                clearTimeout(to);
                socket.removeListener('message', onMsg);
                resolve(o);
              }
            } catch (e) {}
          };
          socket.on('message', onMsg);
          socket.on('error', (err: any) => { clearTimeout(to); socket.removeListener('message', onMsg); reject(err); });
        }).catch(() => null as any);
        if (sigsResp && (sigsResp.result || sigsResp.value)) {
          const sigs = sigsResp.result || sigsResp.value;
          let earliestMs: number | null = null;
          // fetch transactions sequentially (bounded) to avoid bursts
          for (const s of sigs) {
            try {
              const txReqId = Math.floor(Math.random() * 1e9);
              const txReq = { jsonrpc: '2.0', id: txReqId, method: 'getTransaction', params: [s.signature, { commitment: 'confirmed' }] };
              socket.send(JSON.stringify(txReq));
              const txResp: any = await new Promise((resolve, reject) => {
                const to = setTimeout(() => reject(new Error('ws tx timeout')), 7000);
                const onMsg = (msg: any) => {
                  try {
                    const o = JSON.parse(msg.toString());
                    if (o.id === txReqId) {
                      clearTimeout(to);
                      socket.removeListener('message', onMsg);
                      resolve(o);
                    }
                  } catch (e) {}
                };
                socket.on('message', onMsg);
                socket.on('error', (err: any) => { clearTimeout(to); socket.removeListener('message', onMsg); reject(err); });
              }).catch(() => null as any);
              const tx = txResp && (txResp.result || txResp.value) ? (txResp.result || txResp.value) : null;
              const bt = tx?.blockTime;
              if (bt) {
                const ms = (bt > 1e9 && bt < 1e12) ? bt * 1000 : (bt > 1e12 ? bt : bt * 1000);
                if (!earliestMs || ms < earliestMs) earliestMs = ms;
              }
            } catch (e) { /* ignore per-tx failures */ }
          }
          try { socket.close(); } catch (e) {}
          if (earliestMs) { heliusTimestampCache[address] = { ts: earliestMs, fetchedAt: Date.now() }; try { setCachedFirstTx(address, earliestMs); } catch (e) {} return earliestMs; }
        } else {
          try { socket.close(); } catch (e) {}
        }
      } catch (e) {
        // websocket attempt failed - continue to next methods
        try { console.warn(`[Helius] WS attempt failed for ${address}: ${e?.message || e}`); } catch(_) {}
      }
    }
    // 1) Try Helius RPC endpoint via solana web3 (best for paid keys)
    if (heliusRpc) {
      try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const conn = new Connection(heliusRpc, { commitment: 'confirmed' } as any);
        const pub = new PublicKey(address);
        const start = Date.now();
        enrichmentMetrics.heliusCalls++;
        // Page signatures to try to reach the earliest transaction available (may be slow)
        const collectSignaturesFull = async (maxCollect = Number(process.env.HELIUS_RPC_SIG_PAGE_MAX || 2000)) => {
          const out: any[] = [];
          let before: string | null = null;
          const limit = Number(HELIUS_SIG_LIMIT || 1000);
          for (let page = 0; page < 10 && out.length < maxCollect; page++) {
            try {
              const params: any = { limit };
              if (before) params.before = before;
              const pageSigs = await conn.getSignaturesForAddress(pub, params as any);
              if (!Array.isArray(pageSigs) || pageSigs.length === 0) break;
              out.push(...pageSigs);
              if (pageSigs.length < limit) break;
              before = pageSigs[pageSigs.length - 1].signature || (pageSigs[pageSigs.length - 1] as any).txHash || (pageSigs[pageSigs.length - 1] as any).tx_hash || null;
            } catch (e) {
              break;
            }
          }
          return out.slice(0, maxCollect);
        };

        const sigs = await collectSignaturesFull(Number(process.env.HELIUS_RPC_SIG_PAGE_MAX || 2000));
        if (!sigs || sigs.length === 0) {
          enrichmentMetrics.heliusTotalMs += (Date.now() - start);
          // no signatures found via Helius RPC
        } else {
          let earliestMs: number | null = null;
          const concurrency = Math.max(1, Number(HELIUS_RPC_CONCURRENCY || 2));
          for (let i = 0; i < sigs.length; i += concurrency) {
            const slice = sigs.slice(i, i + concurrency);
            const txs = await Promise.all(slice.map((s: any) => conn.getTransaction(s.signature, { commitment: 'confirmed' } as any).catch(() => null)));
            for (const tx of txs) {
              const bt = tx?.blockTime;
              if (!bt) continue;
              const ms = (bt > 1e9 && bt < 1e12) ? bt * 1000 : (bt > 1e12 ? bt : bt * 1000);
              if (!earliestMs || ms < earliestMs) earliestMs = ms;
            }
            await sleep(50);
          }
          enrichmentMetrics.heliusTotalMs += (Date.now() - start);
          heliusTimestampCache[address] = { ts: earliestMs, fetchedAt: Date.now() };
          return earliestMs;
        }
      } catch (err) {
        try { console.warn(`[Helius] RPC endpoint attempt failed for ${address}: ${err?.message || err}`); } catch(_) {}
      }
    }

    // 2) Fall back to Helius parse/history HTTP endpoints (if configured)
    if (apiUrlTemplate) {
      const url = (apiUrlTemplate.indexOf('{address}') !== -1) ? apiUrlTemplate.replace('{address}', address) : apiUrlTemplate + '&mint=' + address;
      const r = await heliusHttpGetWithRetries(url);
      const items: any[] = Array.isArray(r.data) ? r.data : (r.data?.transactions || []);
      if (!items || items.length === 0) {
        heliusTimestampCache[address] = { ts: null, fetchedAt: Date.now() };
        return null;
      }
      let earliest = Number.MAX_SAFE_INTEGER;
      for (const it of items) {
        const bt = it.blockTime || it.timestamp || (it.slot ? undefined : undefined);
        if (!bt) continue;
        if (bt > 1e9 && bt < 1e12) earliest = Math.min(earliest, bt * 1000);
        else if (bt > 1e12) earliest = Math.min(earliest, bt);
        else if (bt < 1e9) earliest = Math.min(earliest, bt * 1000);
      }
      const resultMs = (earliest === Number.MAX_SAFE_INTEGER) ? null : earliest;
      heliusTimestampCache[address] = { ts: resultMs, fetchedAt: Date.now() };
      return resultMs;
    }

    // 3) If nothing configured, return null
    return null;
  } catch (e) {
    // If HTTP / RPC failed: try Solscan then RPC fallback if enabled
  enrichmentMetrics.heliusFailures++;
  try { console.error(`[Helius] getFirstTxTimestampFromHelius failed for ${address}: ${e?.message || e}`); } catch(_) {}
  if (HELIUS_FALLBACK_ENABLED) {
      const fallback = await getFirstTxTimestampFromRpc(address);
      return fallback;
    }
    return null;
  }
}

async function getFirstTxTimestampFromSolscan(address: string): Promise<number | null> {
  if (LISTENER_ONLY_MODE) return null;
  try {
  const base = SOLSCAN_API_URL;
  if (!base) return null;
  const url = `${base.replace(/\/+$/,'')}/account/transactions?address=${encodeURIComponent(address)}&limit=50`;
  const axios = (await import('axios')).default;
  const start = Date.now();
  enrichmentMetrics.solscanCalls++;
  const headers: any = {};
  try { const k = getSolscanApiKey(true); if (k) { headers['x-api-key'] = k; try { const { maskKey } = await import('../config'); console.log(`[Solscan] using key=${maskKey(k)}`); } catch (e) {} } } catch (e) {}
  const r = await axios.get(url, { timeout: 8000, headers });
    enrichmentMetrics.solscanTotalMs += (Date.now() - start);
    const items: any[] = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    if (!items || items.length === 0) {
      enrichmentMetrics.solscanFailures++;
      return null;
    }
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const it of items) {
      const bt = it.blockTime || it.block_time || it.timestamp || it.time;
      if (!bt) continue;
      if (bt > 1e9 && bt < 1e12) earliest = Math.min(earliest, bt * 1000);
      else if (bt > 1e12) earliest = Math.min(earliest, bt);
      else if (bt < 1e9) earliest = Math.min(earliest, bt * 1000);
    }
    const resultMs = (earliest === Number.MAX_SAFE_INTEGER) ? null : earliest;
    return resultMs;
  } catch (e) {
  enrichmentMetrics.solscanFailures++;
  try {
    const status = (e as any)?.response?.status || (e as any)?.code || 'n/a';
    const dataSnippet = (() => { try { const d = (e as any)?.response?.data; return d ? (typeof d === 'string' ? d.slice(0,200) : JSON.stringify(d).slice(0,200)) : ''; } catch { return ''; } })();
    console.error(`[Solscan] getFirstTxTimestampFromSolscan failed for ${address}: status=${status} data=${dataSnippet} msg=${String((e as any)?.message || e)}`);
  } catch(_) {}
  return null;
  }
}

// --- Debug exports (temporary): expose internal helpers for diagnosis
export { getFirstTxTimestampFromHelius, getFirstTxTimestampFromRpc };

// ----- On-chain activity quick checks -----
export async function checkOnChainActivity(address: string): Promise<{ firstTxMs: number | null; found: boolean }> {
  if (!address) return { firstTxMs: null, found: false };
  try {
    // Prefer Helius / RPC path since they tend to return parsed transactions or block times
    let ts: number | null = null;
    try {
      if (!LISTENER_ONLY_MODE) ts = await getFirstTxTimestampFromHelius(address);
    } catch (e) {
      ts = null;
    }
    // If Helius did not yield a result, fall back to RPC (skip Solscan per config)
    if (!ts) {
      try {
        if (!LISTENER_ONLY_MODE) ts = await getFirstTxTimestampFromRpc(address);
      } catch (e) { ts = null; }
    }
    if (!ts) {
      try {
        ts = await getFirstTxTimestampFromRpc(address);
      } catch (e) {
        ts = null;
      }
    }
    return { firstTxMs: ts, found: !!ts };
  } catch (err) {
    return { firstTxMs: null, found: false };
  }
}

/**
 * getFirstOnchainTimestamp: unified helper to return the earliest on-chain timestamp for a mint/address.
 * - Uses in-memory + disk cache when available.
 * - Tries Helius -> Solscan -> RPC fallbacks (configurable via environment flags in config.ts).
 * - Returns an object with ts (ms) | null, source string and cached flag.
 */
export async function getFirstOnchainTimestamp(address: string, opts?: { timeoutMs?: number; prefer?: ('hel'|'solscan'|'rpc')[] }): Promise<{ ts: number | null; source?: string; cached?: boolean }> {
  if (!address) return { ts: null };
  try {
    // check short-lived cache first
    try {
      const c = getCachedFirstTx(address);
      if (c) return { ts: c, source: 'cache', cached: true };
    } catch (e) {}

    const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts!.timeoutMs : Number(ONCHAIN_FRESHNESS_TIMEOUT_MS || 3000);

  // Prefer Helius first, then RPC. Solscan fallback disabled per operator request.
  const order = opts?.prefer && opts.prefer.length ? opts.prefer : ['hel','rpc'];
    let resultMs: number | null = null;
    let source: string | undefined = undefined;

    for (const o of order) {
      try {
        if (LISTENER_ONLY_MODE) continue;
        if (o === 'hel') {
          const ts = await withTimeout(getFirstTxTimestampFromHelius(address), timeoutMs, 'firsttx-helius');
          if (ts) { resultMs = ts; source = 'hel'; break; }
        } else if (o === 'rpc') {
          const ts = await withTimeout(getFirstTxTimestampFromRpc(address), timeoutMs, 'firsttx-rpc');
          if (ts) { resultMs = ts; source = 'rpc'; break; }
        }
      } catch (e) {
        // continue to next source on timeout/error
      }
    }

    if (resultMs) {
      try { setCachedFirstTx(address, resultMs); } catch (e) {}
      return { ts: resultMs, source, cached: false };
    }

    // no timestamp found
    return { ts: null, source: 'none', cached: false };
  } catch (e) {
    return { ts: null };
  }
}

/**
 * Uses DexScreener / pair timestamps (token.poolOpenTimeMs, pairCreatedAt),
 * on-chain first-tx timestamps, and simple liquidity/volume heuristics.
 * Attaches token.freshnessScore and token.freshnessDetails for downstream use.
 */
export async function computeFreshnessScore(token: any): Promise<{ score: number; details: any }> {
  const addr = token?.tokenAddress || token?.address || token?.mint || token?.pairAddress;
  const now = Date.now();
  // Candidate timestamps
  const dsTs = token?.poolOpenTimeMs || token?.pairCreatedAt || token?.pairCreatedAtMs || null;
  let dsTsMs: number | null = null;
  if (typeof dsTs === 'number') {
    dsTsMs = dsTs;
    // normalize seconds -> ms if necessary
    if (dsTsMs && dsTsMs < 1e12 && dsTsMs > 1e9) dsTsMs = Math.floor(dsTsMs * 1000);
  }

  let onChainTs: number | null = null;
  // Allow env toggle to opt-out of extra on-chain calls
  const enableOnchain = ENABLE_ONCHAIN_FRESHNESS;
  if (enableOnchain && addr) {
    try {
      // Keep on-chain check short to avoid long blocking; use withTimeout utility
  if (LISTENER_ONLY_MODE) {
    console.error(`DIAG_ONCHAIN_SKIPPED LISTENER_ONLY_MODE addr=${addr}`);
  } else {
  const res = await withTimeout(checkOnChainActivity(addr), Number(ONCHAIN_FRESHNESS_TIMEOUT_MS || 3000), 'onchain-freshness');
    onChainTs = res.firstTxMs || null;
  }
    } catch (e) {
      onChainTs = null;
    }
  }

  // Base scoring
  let score = 0;
  const details: any = { dsTs: dsTsMs, onChainTs };

  if (dsTsMs && onChainTs) {
    const delta = Math.abs(dsTsMs - onChainTs);
    // close agreement => high score
    if (delta <= 5 * 60 * 1000) score += 60, details.corroboration = 'very_close';
    else if (delta <= 60 * 60 * 1000) score += 45, details.corroboration = 'close';
    else if (delta <= 24 * 60 * 60 * 1000) score += 30, details.corroboration = 'same_day';
    else score += 15, details.corroboration = 'different_days';
  } else if (onChainTs) {
    score += 40; details.corroboration = 'onchain_only';
  } else if (dsTsMs) {
    score += 30; details.corroboration = 'dex_only';
  } else {
    score += 10; details.corroboration = 'no_timestamps';
  }

  // Liquidity / volume boosts (small boosts)
  const liquidity = extractNumeric(getField(token, 'liquidity')) || 0;
  const volume = extractNumeric(getField(token, 'volume')) || 0;
  if (liquidity >= 1000) score += 10;
  if (volume >= 100) score += 10;

  // Penalize extremely old tokens (unless user explicitly allows old tokens)
  const ageMinutes = typeof token.ageMinutes === 'number' ? token.ageMinutes : undefined;
  if (typeof ageMinutes === 'number' && ageMinutes > Number(FRESHNESS_MAX_AGE_MINUTES || 60 * 24 * 7)) {
    // older than default 1 week => low score
    score = Math.min(score, 20);
    details.agePenalty = true;
  }

  // Normalize to 0-100
  score = Math.max(0, Math.min(100, Math.round(score)));
  // Attach to token for downstream decision making
  try {
    token.freshnessScore = score;
    token.freshnessDetails = details;
  } catch (e) { /* ignore */ }
  return { score, details };
}


export async function enrichTokenTimestamps(tokens: any[], opts?: { batchSize?: number; delayMs?: number }) {
  const batchSize = opts?.batchSize ?? Number(HELIUS_BATCH_SIZE || 4);
  const delayMs = opts?.delayMs ?? Number(HELIUS_BATCH_DELAY_MS || 400);
  const enrichLimit = Number(HELIUS_ENRICH_LIMIT || 8);
  // Build canonical address -> token map
  const addrMap = new Map<string, any>();
  for (const t of tokens) {
    const key = t.tokenAddress || t.address || t.mint || t.pairAddress;
    if (key) addrMap.set(key, t);
  }
  // Rank candidates by liquidity then volume (desc)
  const candidates = Array.from(addrMap.entries()).map(([addr, t]) => ({ addr, token: t, score: (Number(t.liquidity || 0) + Number(t.volume || 0)) }));
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const toEnrich = candidates.slice(0, Math.min(enrichLimit, candidates.length)).map(c => c.addr);
  // Summary counters
  let enrichedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  // Enrich in small batches to avoid bursts
  for (let i = 0; i < toEnrich.length; i += batchSize) {
    const batch = toEnrich.slice(i, i + batchSize);
    const results: Array<number | null> = [];
    for (const addr of batch) {
      try {
        // In listener-only mode avoid heavy external enrichment; leave ts=null
        let ts = null as number | null;
        if (!LISTENER_ONLY_MODE) {
          try { ts = await getFirstTxTimestampFromHelius(addr); } catch (e) { ts = null; }
          if (!ts) {
            try { ts = await getFirstTxTimestampFromRpc(addr); } catch (e) { ts = null; }
          }
        }
        results.push(ts);
      } catch (e) {
        errorCount++;
        results.push(null);
      }
    }
    // Apply results to tokens
    for (let j = 0; j < batch.length; j++) {
      const addr = batch[j];
      const tsMs = results[j];
      const token = addrMap.get(addr);
      if (!token) { skippedCount++; continue; }
      if (tsMs) {
        token.poolOpenTimeMs = tsMs;
        token.ageSeconds = Math.floor((Date.now() - tsMs) / 1000);
        token.ageMinutes = Math.floor(token.ageSeconds / 60);
        enrichedCount++;
      } else {
        skippedCount++;
      }
        // Compute a lightweight freshness score for downstream filters/notifications
        try {
          // fire-and-wait with a short timeout to avoid blocking the batch too long
          const scoreRes = await withTimeout(computeFreshnessScore(token), Number(FRESHNESS_SCORE_TIMEOUT_MS || 2000), 'freshness-score');
          // token.freshnessScore and token.freshnessDetails are set by computeFreshnessScore
        } catch (e) {
          // If scoring fails, continue silently; don't block notifications
        }
    }
    if (i + batchSize < toEnrich.length) await sleep(delayMs);
  }
  // Final concise log
  // Avoid printing repetitive messages; print a single-line summary
  console.log(`Enrichment summary: attempted=${toEnrich.length} enriched=${enrichedCount} skipped=${skippedCount} errors=${errorCount}`);
}

export function getEnrichmentMetrics() {
  return { ...enrichmentMetrics };
}

/**
 * officialEnrich: perform an authoritative enrichment for a single token object.
 * - runs the existing on-chain + solscan enrichment paths (via enrichTokenTimestamps)
 * - attempts a lightweight Jupiter route check and attaches results on token.jupiter
 * - runs under the global onchainLimiter to avoid bursts
 */
export async function officialEnrich(token: any, opts?: { amountUsd?: number; timeoutMs?: number }) {
  if (!token) return null;
  return onchainLimiter.enqueue(async () => {
    try {
      // Ensure token has canonical address
      const addr = token.tokenAddress || token.address || token.mint || token.pairAddress;
      if (!addr) return token;
        // In listener-only mode skip heavy enrichment and external Jupiter checks
        if (!LISTENER_ONLY_MODE) {
          try { await enrichTokenTimestamps([token], { batchSize: 1, delayMs: 0 }); } catch (e) {}
          try {
            const minJupiterUsd = typeof opts?.amountUsd === 'number' ? Number(opts!.amountUsd) : undefined;
            const jres = await finalJupiterCheck(addr, 0, { minJupiterUsd, timeoutMs: opts?.timeoutMs || 3000 });
            token.jupiter = jres.data || null;
            token.jupiterCheck = { ok: jres.ok, reason: jres.reason || null };
          } catch (e) { token.jupiter = null; }
        } else {
          token.jupiter = null;
          token.jupiterCheck = { ok: true, reason: 'listener-only' };
        }
      // Recompute freshness score after enrichment
      try { await computeFreshnessScore(token); } catch (e) {}
      return token;
    } catch (e) {
      throw e;
    }
  });
}

// ========== Formatting and display functions ==========
export function fmt(val: number | string | undefined | null, digits?: number, unit?: string): string {
  if (val === undefined || val === null) return '-';
  let num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num)) return String(val);
  let usedDigits = digits !== undefined ? digits : (Math.abs(num) < 1 ? 6 : 2);
  let str = num.toLocaleString(undefined, { maximumFractionDigits: usedDigits });
  if (unit) str += ' ' + unit;
  return str;
}



// --- Helper functions for building the message ---

function buildInlineKeyboard(token: any, botUsername: string, pairAddress: string, userId?: string) {
  // Only expose external links for tokens explicitly created in the discovered tx
  const isExplicit = Boolean(token && token.createdHere === true);
  // For explicit tokens prefer token.url only; avoid constructing dexscreener links from pairAddress
  // because pairAddress may be a liquidity/pair id or a program address unrelated to the mint.
  const dexUrl = isExplicit ? (token.url || '') : (token.url || (pairAddress ? `https://dexscreener.com/solana/${pairAddress}` : ''));
  const twitterEmoji = '🐦', dexEmoji = '🧪', shareEmoji = '📤';
  const inlineKeyboard: any[][] = [];
  // Row 1: Twitter, DexScreener (only if available)
  const row1: any[] = [];
  if (Array.isArray(token.links)) {
    for (const l of token.links) {
      if (l.type === 'twitter' && l.url) row1.push({ text: `${twitterEmoji} Twitter`, url: l.url });
    }
  }
  if (dexUrl) row1.push({ text: `${dexEmoji} DexScreener`, url: dexUrl });
  if (row1.length) inlineKeyboard.push(row1);
  // Row 2: Share button (external share link)
  // Only add a Share button when the token is explicit and has a valid id
  if (isExplicit) {
  // Use canonical token id for sharing: prefer mint/tokenAddress/address and *avoid* pairAddress when explicit
  let shareId = userId || token._userId || (token.mint || token.tokenAddress || token.address || token.pairAddress || '');
    const shareUrl = `https://t.me/share/url?url=https://t.me/${botUsername}?start=${shareId}`;
    const row2: any[] = [ { text: `${shareEmoji} Share`, url: shareUrl } ];
    inlineKeyboard.push(row2);
  }
  return { inlineKeyboard };
}

// --- Helper functions for building the message ---
function getTokenCoreFields(token: any) {
  return {
    name: token.name || token.baseToken?.name || '',
    symbol: token.symbol || token.baseToken?.symbol || '',
  // Prefer on-chain mint/tokenAddress/address as the canonical address. Avoid pairAddress for explicit tokens.
  address: token.mint || token.tokenAddress || token.address || token.url?.split('/').pop() || token.pairAddress || '',
  // Prefer an explicit token.url when present. Only fallback to pairAddress-based dexscreener URL
  // for non-explicit tokens or when token.url is not available.
  dexUrl: token.url || (token.pairAddress ? `https://dexscreener.com/solana/${token.pairAddress}` : ''),
    logo: token.imageUrl || token.logoURI || token.logo || token.baseToken?.logoURI || ''
  };
}

function getTokenStats(token: any) {
  const price = extractNumeric(getField(token, 'priceUsd', 'price', 'baseToken.priceUsd', 'baseToken.price'), 0);
  const marketCap = extractNumeric(getField(token, 'marketCap'));
  const liquidity = extractNumeric(getField(token, 'liquidity'));
  const volume = extractNumeric(getField(token, 'volume'));
  const holders = extractNumeric(getField(token, 'holders'));
  // Prefer canonical on-chain age fields (seconds) when available to avoid unit confusion.
  let ageDisplay: string = 'Not available';
  let ageMs: number | undefined = undefined;
  // canonical seconds sources
  const canonSec = (token && token._canonicalAgeSeconds !== undefined && token._canonicalAgeSeconds !== null) ? Number(token._canonicalAgeSeconds) :
                    (typeof token.ageSeconds === 'number' && !isNaN(token.ageSeconds) ? Number(token.ageSeconds) : undefined);
  if (canonSec !== undefined && !isNaN(canonSec)) {
    if (canonSec >= 0) ageMs = Math.floor(canonSec * 1000);
  } else {
    // fallback: legacy 'age' or 'createdAt' fields
    let age = getField(token, 'age', 'createdAt');
    if (typeof age === 'string') age = Number(age);
    if (typeof age === 'number' && !isNaN(age)) {
      if (age > 1e12) ageMs = Date.now() - age; // ms timestamp
      else if (age > 1e9) ageMs = Date.now() - age * 1000; // s timestamp
      else if (age < 1e7 && age > 0) ageMs = age * 60 * 1000; // minutes
    }
  }
  if (typeof ageMs === 'number' && !isNaN(ageMs) && ageMs > 0) {
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((ageMs % (60 * 1000)) / 1000);
    if (days > 0) {
      ageDisplay = `${days} day${days > 1 ? 's' : ''}`;
      if (hours > 0) ageDisplay += ` ${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      ageDisplay = `${hours} hour${hours > 1 ? 's' : ''}`;
      if (minutes > 0) ageDisplay += ` ${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      ageDisplay = `${minutes} minute${minutes > 1 ? 's' : ''}`;
      if (seconds > 0) ageDisplay += ` ${seconds} second${seconds > 1 ? 's' : ''}`;
    } else {
      ageDisplay = `${seconds} second${seconds > 1 ? 's' : ''}`;
    }
  }
  return { price, marketCap, liquidity, volume, holders, ageDisplay };
}

function getTokenBuySell(token: any) {
  const buyVol = extractNumeric(token.buyVolume || token.buy_volume || token.volumeBuy || token.volume_buy);
  const sellVol = extractNumeric(token.sellVolume || token.sell_volume || token.volumeSell || token.volume_sell);
  return { buyVol, sellVol };
}

function buildExtraFields(token: any) {
  // Add unimportant fields to the skip list
  const skipFields = new Set([
    'name','baseToken','tokenAddress','address','mint','pairAddress','url','imageUrl','logoURI','logo','links','description','symbol','priceUsd','price','marketCap','liquidity','volume','holders','age','genesis_date','pairCreatedAt',
    'icon','header','openGraph' // unimportant fields
  ]);
  let msg = '';
  for (const key of Object.keys(token)) {
    if (skipFields.has(key)) continue;
    let value = token[key];
    if (value === undefined || value === null || value === '' || value === '-' || value === 'N/A' || value === 'null' || value === 'undefined') continue;
    if (typeof value === 'number') {
      msg += `<b>${key}:</b> ${fmt(value, 6)}\n`;
    } else if (typeof value === 'string') {
      // Don't show any image links or pictures
      if (/^https?:\/\/.*\.(png|jpg|jpeg|gif|webp)$/i.test(value)) {
        continue;
      } else if (/^https?:\/.*/.test(value)) {
        // If it's a link, show it as a link with an emoji only
        msg += `<b>${key}:</b> <a href='${value}'>🔗</a>\n`;
      } else {
        msg += `<b>${key}:</b> ${value}\n`;
      }
    } else if (typeof value === 'boolean') {
      msg += `<b>${key}:</b> ${value ? '✅' : '❌'}\n`;
    } else if (typeof value === 'object') {
      const numVal = extractNumeric(value);
      if (numVal !== undefined) {
        msg += `<b>${key}:</b> ${fmt(numVal, 6)}\n`;
      } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
        msg += `<b>${key}:</b> ${value.join(', ')}\n`;
      }
    }
  }
  return msg;
}

export function buildTokenMessage(token: any, botUsername: string, pairAddress: string, userId?: string): { msg: string, msgMarkdown?: string, inlineKeyboard: any[][] } {
  const { name, symbol, address, dexUrl, logo } = getTokenCoreFields(token);
  const { price, marketCap, liquidity, volume, holders, ageDisplay } = getTokenStats(token);
  const { buyVol, sellVol } = getTokenBuySell(token);
  // --- Emojis ---
  const solEmoji = '🟣', memecoinEmoji = '🚀', chartEmoji = '📈', capEmoji = '💰', liqEmoji = '💧', volEmoji = '🔊', holdersEmoji = '👥', ageEmoji = '⏱️', linkEmoji = '🔗';
  // --- Message header (HTML) ---
  let msg = '';
  const nice = (v: any) => (v === undefined || v === null || v === 'Not available') ? '—' : v;
  // Title
  const isExplicit = Boolean(token && token.createdHere === true);
  msg += `🪙 ${solEmoji} <b>${name ? name : 'Unknown'}</b>${symbol ? ' <code>' + symbol + '</code>' : ''}`;
  msg += isExplicit ? ` <b>🔒 Explicit</b>\n` : ` <i>Not explicit</i>\n`;
  msg += `${linkEmoji} <b>Address:</b> <code>${address ? address : 'N/A'}</code>\n\n`;
  // --- Stats (compact, human friendly) ---
  msg += `${capEmoji} <b>Market Cap:</b> ${nice(fmtField(marketCap, 'marketCap'))} USD\n`;
  msg += `${liqEmoji} <b>Liquidity:</b> ${nice(fmtField(liquidity, 'liquidity'))} USD  `;
  if (typeof liquidity === 'number' && !isNaN(liquidity) && typeof marketCap === 'number' && marketCap > 0) {
    const liqPct = Math.min(100, Math.round((liquidity / marketCap) * 100));
    msg += progressBar(liqPct, 10, '🟦', '⬜') + ` ${liqPct}%\n`;
  } else {
    msg += '\n';
  }
  msg += `${volEmoji} <b>Volume 24h:</b> ${fmtField(volume, 'volume')} USD  `;
  if (typeof volume === 'number' && !isNaN(volume) && typeof marketCap === 'number' && marketCap > 0) {
    const volPct = Math.min(100, Math.round((volume / marketCap) * 100));
    msg += progressBar(volPct, 10, '🟩', '⬜') + ` ${volPct}%\n`;
  } else {
    msg += '\n';
  }
  msg += `${ageEmoji} <b>Age:</b> ${ageDisplay}\n`;
  msg += `${chartEmoji} <b>Price:</b> ${fmtField(price, 'price')} USD\n`;
  // --- Buy/Sell progress bar ---
  if (buyVol !== undefined || sellVol !== undefined) {
    const totalVol = (buyVol || 0) + (sellVol || 0);
    if (totalVol > 0) {
      const buyPct = Math.round((buyVol || 0) / totalVol * 100);
      const sellPct = 100 - buyPct;
      msg += `🟢 Buy:  ${progressBar(buyPct, 10, '🟩', '⬜')} ${buyPct}%\n`;
      msg += `🔴 Sell: ${progressBar(sellPct, 10, '🟥', '⬜')} ${sellPct}%\n`;
    }
  }
  // --- Extra fields ---
  // include a small set of extra fields if they help users (but avoid raw debug dumps)
  const debugFields = ['freshnessScore','freshnessDetails','poolOpenTimeMs','ageSeconds','jupiterCheck'];
  const extras = {} as any;
  for (const k of debugFields) if (token[k] !== undefined) extras[k] = token[k];
  if (Object.keys(extras).length) {
    msg += '\n<b>Details:</b>\n';
    msg += buildExtraFields(extras);
  }
  // --- Description ---
  if (token.description) msg += `\n<em>${token.description}</em>\n`;
  // --- Network line ---
  if (token.chainId || token.chain || token.chainName) {
    const network = token.chainId || token.chain || token.chainName;
    msg += `🌐 <b>Network:</b> ${network}\n`;
  }
  // --- Only add community/footer line ---
  if (isExplicit) {
    msg += `\n${memecoinEmoji} <b>Solana Memecoin Community</b> | ${solEmoji} <b>Powered by DexScreener</b>\n`;
  } else {
    msg += `\n${memecoinEmoji} <b>Solana Memecoin Community</b>\n`;
  }
  // --- Inline keyboard (all links/buttons at the bottom) ---
  const { inlineKeyboard } = buildInlineKeyboard(token, botUsername, pairAddress, userId);
  // Also produce a Markdown variant for clients that prefer Markdown (returned for inspection)
  const esc = (s: string) => s.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
  let msgMd = '';
  msgMd += `🪙 ${name ? esc(name) : 'Unknown'}` + (symbol ? ` \`${esc(symbol)}\`` : '') + '\n';
  msgMd += `🔗 Address: \`${esc(address || 'N/A')}\`\n\n`;
  msgMd += `💰 Market Cap: ${esc(String(nice(fmtField(marketCap, 'marketCap'))))} USD\n`;
  msgMd += `💧 Liquidity: ${esc(String(nice(fmtField(liquidity, 'liquidity'))))} USD\n`;
  msgMd += `🔊 Volume 24h: ${esc(String(nice(fmtField(volume, 'volume'))))} USD\n`;
  msgMd += `⏱️ Age: ${esc(String(ageDisplay))}\n`;
  msgMd += `📈 Price: ${esc(String(fmtField(price, 'price')))} USD\n`;
  if (Object.keys(extras).length) {
    msgMd += '\n**Details:**\n';
    for (const k of Object.keys(extras)) {
      try { msgMd += `- ${esc(k)}: \`${esc(String(typeof extras[k] === 'object' ? JSON.stringify(extras[k]) : String(extras[k])))}\`\n`; } catch(e){}
    }
  }
  msgMd += `\n🚀 Solana Memecoin Community | 🟣 Powered by DexScreener\n`;

  return { msg, msgMarkdown: msgMd, inlineKeyboard };
}

// Build a concise preview message used in fast previews and notifications
export function buildPreviewMessage(token: any): { title: string; addr: string; price: string; url?: string; shortMsg: string } {
  const addr = token.mint || token.tokenAddress || token.address || token.pairAddress || 'N/A';
  const name = token.name || token.symbol || addr;
  const priceNum = token.priceUsd || token.price || token.priceUsdFloat || token.priceFloat;
  const price = (typeof priceNum === 'number') ? priceNum.toLocaleString(undefined, { maximumFractionDigits: 8 }) : (priceNum ? String(priceNum) : 'N/A');
  const url = token.url || (token.pairAddress ? `https://dexscreener.com/solana/${token.pairAddress}` : undefined);
  // Include source program/signature when available (useful for listener-sourced candidates)
  let srcLine = '';
  try {
    const sp = token.sourceProgram || token.source || token.sourceName;
    const sig = token.sourceSignature || token.signature || token.sig;
    if (sp) srcLine += `\nSource: ${sp}`;
    if (sig) srcLine += ` | Sig: ${sig}`;
  } catch (e) {}
  const shortMsg = `🪙 ${name} (${addr})\nPrice: ${price} USD${url ? '\n' + url : ''}${srcLine}`;
  return { title: name, addr, price, url, shortMsg };
}

// Build a bulleted HTML message and inline keyboard for a list of tokens.
// Uses the full `buildTokenMessage` template for each token so multi-token
// notifications show the same rich block that single-token messages use.
export function buildBulletedMessage(tokens: any[], opts?: { cluster?: string; title?: string; maxShow?: number; program?: string; signature?: string }) {
  const cluster = opts?.cluster || process.env.SOLANA_CLUSTER || 'mainnet';
  const title = opts?.title || 'Live tokens (listener)';
  const maxShow = opts?.maxShow ?? (Array.isArray(tokens) ? tokens.length : 0);

  const program = opts?.program || (Array.isArray(tokens) && tokens.length && (tokens[0].program || tokens[0].sourceProgram)) || undefined;
  const signature = opts?.signature || (Array.isArray(tokens) && tokens.length && (tokens[0].signature || tokens[0].sourceSignature)) || undefined;

  // By default only include tokens explicitly created in the discovered tx (createdHere === true)
  const allowNonExplicit = (opts && (opts as any).allowNonExplicit) === true;
  const filteredTokens = Array.isArray(tokens) ? tokens.filter(t => { try { if (!t) return false; if (allowNonExplicit) return true; return Boolean(t.createdHere === true); } catch (e) { return false; } }) : [];
  // Header
  let text = `🔔 <b>${title}${opts && (opts as any).forUser ? ' for ' + (opts as any).forUser : ''}</b>\nFound ${filteredTokens.length} candidate(s) (showing ${Math.min(filteredTokens.length, maxShow)}):\n`;
  if (program) text += `Program: <code>${program}</code>\n`;
  if (signature) text += `Signature: <code>${signature}</code>\n`;

  const inline_keyboard: any[][] = [];

  const botUsername = process.env.BOT_USERNAME || 'YourBotUsername';

  for (let i = 0; i < Math.min(filteredTokens.length, maxShow); i++) {
    const t = filteredTokens[i];
    try {
      // Use the rich single-token template for each token
  const pairAddress = t.pairAddress || t.tokenAddress || t.address || t.mint || '';
      const built = buildTokenMessage(t, botUsername, pairAddress, undefined);
      if (built && typeof built.msg === 'string') {
        // Separate items with two newlines for readability
        text += `\n• ${built.msg}\n`;
      } else {
        // Fallback to preview line
        const preview = buildPreviewMessage(t);
        const addr = preview.addr || '<unknown>';
        text += `\n• <b>${preview.title}</b> <code>${addr}</code>\n${preview.shortMsg}\n`;
      }
      // Merge inline keyboard rows if present
  if (built && Array.isArray(built.inlineKeyboard)) {
        for (const row of built.inlineKeyboard) {
          if (Array.isArray(row) && row.length) inline_keyboard.push(row);
        }
      } else if (pairAddress) {
        // fallback: add an explorer button row
        const explorerBase = (cluster === 'devnet') ? 'https://explorer.solana.com' : 'https://explorer.solana.com';
  inline_keyboard.push([{ text: `🔎 ${t.name || pairAddress}`, url: `${explorerBase}/address/${pairAddress}?cluster=${cluster}` }]);
      }
    } catch (e) {
      const addr = t && (t.tokenAddress || t.address || t.mint) || 'unknown';
      text += `\n• <code>${addr}</code>\n`;
      const explorerBase = (cluster === 'devnet') ? 'https://explorer.solana.com' : 'https://explorer.solana.com';
      inline_keyboard.push([{ text: `🔎 ${addr}`, url: `${explorerBase}/address/${addr}?cluster=${cluster}` }]);
    }
  }

  return { text, inline_keyboard };
}


function progressBar(percent: number, size = 10, fill = '█', empty = '░') {
  const filled = Math.round((percent / 100) * size);
  return fill.repeat(filled) + empty.repeat(size - filled);
}


// Notify users with matching tokens (always uses autoFilterTokens)
export async function notifyUsers(bot: any, users: Record<string, any>, tokens: any[]) {
  // If ONLY_PRINT_EXPLICIT is enabled, strictly filter incoming tokens to those
  // explicitly created in the discovered tx (createdHere === true). This prevents
  // external quick-sources (DexScreener, etc.) from being sent to users when the
  // system is operating in explicit-only mode.
  try {
    const onlyExplicit = (process.env.ONLY_PRINT_EXPLICIT === 'true' || process.env.ONLY_PRINT_EXPLICIT === '1');
    if (onlyExplicit) tokens = Array.isArray(tokens) ? tokens.filter(t => t && t.createdHere === true) : [];
  } catch (e) {}
  for (const uid of Object.keys(users)) {
    const strategy: Record<string, any> = users[uid]?.strategy || {};
    const filteredVerbose = autoFilterTokensVerbose(tokens, strategy);
    const filtered = (filteredVerbose && filteredVerbose.passed) ? filteredVerbose.passed : (Array.isArray(filteredVerbose) ? filteredVerbose : tokens);
    if (filtered && filtered.length > 0 && bot) {
      // Filter to Solana tokens only
      const solFiltered = filtered.filter((token: any) => {
        try { const chain = (token.chainId || token.chain || token.chainName || '').toString().toLowerCase(); return !chain || chain.includes('sol'); } catch (e) { return true; }
      });
      if (solFiltered.length === 0) {
        // nothing for this chain
      } else if (solFiltered.length === 1) {
        const token = solFiltered[0];
        let botUsername = (bot && bot.botInfo && bot.botInfo.username) ? bot.botInfo.username : (process.env.BOT_USERNAME || 'YourBotUsername');
        const address = token.tokenAddress || token.address || token.mint || token.pairAddress || 'N/A';
        const pairAddress = token.pairAddress || address;
        const singleMsg = buildTokenMessage(token, botUsername, pairAddress);
        if (typeof singleMsg.msg !== 'string') {
          await bot.telegram.sendMessage(uid, '⚠️ We are still looking for the gems you want.');
        } else {
          await bot.telegram.sendMessage(uid, singleMsg.msg, ({ parse_mode: 'HTML', disable_web_page_preview: false, reply_markup: { inline_keyboard: singleMsg.inlineKeyboard } } as any));
        }
      } else {
        // Multiple tokens: send a single bulleted message with inline buttons
        try {
          const { text, inline_keyboard } = buildBulletedMessage(solFiltered, { cluster: process.env.SOLANA_CLUSTER, title: 'Tokens matching your strategy', maxShow: solFiltered.length });
          await bot.telegram.sendMessage(uid, text, ({ parse_mode: 'HTML', disable_web_page_preview: false, reply_markup: { inline_keyboard } } as any));
        } catch (e) {
          // fallback: send individual messages
          for (const token of solFiltered) {
            try {
              let botUsername = (bot && bot.botInfo && bot.botInfo.username) ? bot.botInfo.username : (process.env.BOT_USERNAME || 'YourBotUsername');
              const address = token.tokenAddress || token.address || token.mint || token.pairAddress || 'N/A';
              const pairAddress = token.pairAddress || address;
              const singleMsg = buildTokenMessage(token, botUsername, pairAddress);
              if (typeof singleMsg.msg === 'string') await bot.telegram.sendMessage(uid, singleMsg.msg, ({ parse_mode: 'HTML', disable_web_page_preview: false, reply_markup: { inline_keyboard: singleMsg.inlineKeyboard } } as any));
            } catch (e2) {}
          }
        }
      }
    } else if (bot) {
              await bot.telegram.sendMessage(
                uid,
                'No tokens currently match your strategy.\n\nYour strategy filters may be too strict for the available data from DexScreener.\n\nTry lowering requirements like liquidity, market cap, volume, age, or holders, then try again.',
          ({ parse_mode: 'HTML', disable_web_page_preview: true } as any)
              );
    }
  }
}


// Unified token filtering by strategy
export function autoFilterTokensVerbose(tokens: any[], strategy: Record<string, any>): { passed: any[]; rejected: Array<{ token: any; reasons: string[] }> } {
  const passed: any[] = [];
  const rejected: Array<{ token: any; reasons: string[] }> = [];
  for (const token of tokens) {
    // quick reject of obvious system/program addresses
    try {
      const addr = String(token && (token.tokenAddress || token.address || token.mint || '') || '').trim();
      if (isSystemMint(addr)) { rejected.push({ token, reasons: ['system_address'] }); continue; }
    } catch (e) {}
    const reasons: string[] = [];
    let ok = true;
    for (const field of STRATEGY_FIELDS) {
      if (!field.tokenField || !(field.key in strategy)) continue;
      const value = strategy[field.key];
      if (field.type === "number" && (value === undefined || value === null || Number(value) === 0)) continue;
      let tokenValue = getField(token, field.tokenField);
      // Special cases support
      if (field.tokenField === 'liquidity' && tokenValue && typeof tokenValue === 'object' && typeof tokenValue.usd === 'number') tokenValue = tokenValue.usd;
      if (field.tokenField === 'volume' && tokenValue && typeof tokenValue === 'object' && typeof tokenValue.h24 === 'number') tokenValue = tokenValue.h24;
      // age handling
      if (field.tokenField === 'age') {
        const minAgeSeconds = parseDuration(value) ?? undefined;
        let tokenAgeSeconds: number | undefined = undefined;
        if (typeof token.ageSeconds === 'number' && !isNaN(token.ageSeconds)) tokenAgeSeconds = token.ageSeconds;
        else if (typeof token.ageMinutes === 'number' && !isNaN(token.ageMinutes)) tokenAgeSeconds = Math.floor(token.ageMinutes * 60);
        else if (typeof tokenValue === 'number' && !isNaN(tokenValue)) {
          if (tokenValue > 1e12) tokenAgeSeconds = Math.floor((Date.now() - tokenValue) / 1000);
          else if (tokenValue > 1e9) tokenAgeSeconds = Math.floor((Date.now() - tokenValue * 1000) / 1000);
          else tokenAgeSeconds = Math.floor(Number(tokenValue) * 60);
        }
        if (minAgeSeconds !== undefined && (tokenAgeSeconds === undefined || isNaN(tokenAgeSeconds))) {
          if (minAgeSeconds <= 60) {
            // treat as ok for very small min age
            continue;
          }
          if (!field.optional) { reasons.push('missing_age'); ok = false; }
          continue;
        }
        tokenValue = tokenAgeSeconds;
      }
      tokenValue = extractNumeric(tokenValue);
      const numValue = Number(value);
      const numTokenValue = Number(tokenValue);
      if (isNaN(numTokenValue)) {
        if (!field.optional) { reasons.push('missing_'+field.key); ok = false; }
        continue;
      }
      if (field.type === "number") {
        let compareValue = numValue;
        if (field.tokenField === 'age') {
          const parsed = parseDuration(value);
          if (!isNaN(Number(parsed))) compareValue = parsed ?? numValue * 60;
        }
        if (field.key.startsWith("min") && !isNaN(compareValue)) {
          if (numTokenValue < compareValue) { reasons.push('below_'+field.key); ok = false; }
        }
        if (field.key.startsWith("max") && !isNaN(compareValue)) {
          if (numTokenValue > compareValue) { reasons.push('above_'+field.key); ok = false; }
        }
      }
      if (field.type === "boolean" && typeof value === "boolean") {
        if (value === true && !tokenValue) { reasons.push('missing_boolean_'+field.key); ok = false; }
        if (value === false && tokenValue) { reasons.push('boolean_'+field.key+'_mismatch'); ok = false; }
      }
    }
    // freshness checks
    try {
      const minFresh = strategy?.minFreshnessScore !== undefined ? Number(strategy.minFreshnessScore) : undefined;
      if (!isNaN(Number(minFresh)) && typeof token.freshnessScore === 'number') {
        if ((token.freshnessScore || 0) < Number(minFresh)) { reasons.push('low_freshness'); ok = false; }
      }
      if (strategy?.requireOnchain) {
        const onChainTs = token?.freshnessDetails?.onChainTs || token?.freshnessDetails?.firstTxMs || null;
        if (!onChainTs) { reasons.push('no_onchain_evidence'); ok = false; }
      }
    } catch (e) {}
    if (ok) passed.push(token); else rejected.push({ token, reasons });
  }
  return { passed, rejected };
}

export function autoFilterTokens(tokens: any[], strategy: Record<string, any>): any[] {
  try { return autoFilterTokensVerbose(tokens, strategy).passed; } catch (e) { return tokens; }
}

// ========== Signing Key Utilities ==========
const bs58 = require("bs58");
const { Keypair } = require("@solana/web3.js");

export function loadKeypair(secretKey: string) {
  try {
    // إذا كانت Base58
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(secretKey)) {
      return Keypair.fromSecretKey(bs58.decode(secretKey));
    }
    // إذا كانت Base64
    if (/^[A-Za-z0-9+/]+=*$/.test(secretKey)) {
      return Keypair.fromSecretKey(Buffer.from(secretKey, "base64"));
    }
    throw new Error("صيغة المفتاح غير معروفة");
  } catch (err: any) {
    throw new Error("فشل تحميل المفتاح: " + err.message);
  }
}

// ========== Timeout Utility ==========
export function withTimeout<T>(promise: Promise<T>, ms: number, source: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${source}`)), ms)
    )
  ]);
}

// Simple concurrency limiter used to throttle on-chain/enrichment calls to avoid API 429s.
function createLimiter(maxConcurrent: number) {
  let running = 0;
  const q: Array<{ fn: () => Promise<any>; resolve: (v:any)=>void; reject: (e:any)=>void }> = [];
  function runNext() {
    if (running >= maxConcurrent) return;
    const item = q.shift();
    if (!item) return;
    running++;
    Promise.resolve()
      .then(() => item.fn())
      .then((res) => item.resolve(res))
      .catch((err) => item.reject(err))
      .finally(() => { running--; runNext(); });
  }
  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        q.push({ fn, resolve, reject });
        runNext();
      });
    },
    stats() { return { running, queued: q.length, maxConcurrent }; }
  };
}

// global limiter for on-chain enrichment calls; configurable via env
const ONCHAIN_CONCURRENCY = Number(process.env.ONCHAIN_CONCURRENCY || process.env.HELIUS_ONCHAIN_CONCURRENCY || 2);
const onchainLimiter = createLimiter(Math.max(1, ONCHAIN_CONCURRENCY));

// ========== Logging Utility ==========
export function logTrade(trade: {
  action: string;
  source: string;
  token: string;
  amount: number;
  price: number | null;
  tx: string | null;
  latency: number;
  status: string;
}) {
  console.log(`[TRADE] ${trade.action} | ${trade.source} | Token: ${trade.token} | Amount: ${trade.amount} | Price: ${trade.price} | Tx: ${trade.tx} | Latency: ${trade.latency}ms | Status: ${trade.status}`);
}

/**
 * finalJupiterCheck: lightweight verification that a Jupiter route exists for a mint and amount.
 * Returns { ok: boolean, reason?: string }
 * This helper is intentionally permissive: when the Jupiter API is not configured it returns ok=true.
 */
export async function finalJupiterCheck(mint: string, buyAmountSol: number, opts?: { minJupiterUsd?: number; requireRoute?: boolean; timeoutMs?: number }) {
  try {
    // Avoid external HTTP calls in listener-only mode; optimistically allow but mark reason
    if (LISTENER_ONLY_MODE) return { ok: true, reason: 'listener-only' };
  const cfgMod = await import('../config');
  const cfg = (cfgMod as any) && ((cfgMod as any).default || cfgMod);
  const { JUPITER_QUOTE_API } = cfg || {};
    const timeout = opts?.timeoutMs || 3000;
    // If the environment does not provide a Jupiter quote API, allow by default
    if (!JUPITER_QUOTE_API) return { ok: true, reason: 'no-jupiter-api' };
    if (!mint) return { ok: false, reason: 'no-mint' };
    // Compute lamports (amount param for Jupiter) correctly.
    // If the caller provided buyAmountSol (SOL) use that. Otherwise try to convert opts.minJupiterUsd -> SOL via CoinGecko.
    let lamports: number | null = null;
    if (typeof buyAmountSol === 'number' && buyAmountSol > 0) {
      lamports = Math.floor(buyAmountSol * 1e9);
    } else if (typeof opts?.minJupiterUsd === 'number') {
      // Convert USD -> SOL using a lightweight public price API (CoinGecko). If that fails, fall back to $50 ~ 1 SOL assumption (not ideal).
      try {
        const axios = (await import('axios')).default;
        const cg = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 2000 });
        const solUsd = Number(cg.data?.solana?.usd || 0);
        const amountUsd = Number(opts.minJupiterUsd || 50);
        const solEquivalent = solUsd > 0 ? (amountUsd / solUsd) : (amountUsd / 1);
        lamports = Math.floor(solEquivalent * 1e9);
      } catch (e) {
        // fallback: assume 1 USD ~= 1 SOL (very rough) but ensure a minimal amount
        const amountUsd = Number(opts.minJupiterUsd || 50);
        lamports = Math.floor((amountUsd / 1) * 1e9);
      }
    }
    if (!lamports) lamports = Math.floor((50 / 1) * 1e9);
  const url = `${JUPITER_QUOTE_API}?inputMint=So11111111111111111111111111111111111111112&outputMint=${encodeURIComponent(mint)}&amount=${lamports}&slippage=1`;
  const axios = (await import('axios')).default;
  const headers: any = {};
  try { const { maskKey } = await import('../config'); const k = getJupiterApiKey(true); if (k) { headers['x-api-key'] = k; try { console.log(`[Jupiter] using key=${maskKey(k)}`); } catch (e) {} } } catch (e) {}
  const res = await axios.get(url, { timeout, headers });
    if (res && res.data) return { ok: true, data: res.data };
    return { ok: false, reason: 'no-data' };
  } catch (err: any) {
    // If the caller does not require Jupiter strictly, return ok=false but include reason
    return { ok: false, reason: err?.message || String(err) };
  }
}