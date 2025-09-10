// Minimal safe Helius WebSocket listener.
// Uses centralized config from `src/config.ts` so env parsing is in one place.
import { HELIUS_USE_WEBSOCKET, getHeliusWebsocketUrl, HELIUS_SUBSCRIBE_METADATA, HELIUS_SUBSCRIBE_SPLTOKEN } from './config';
// optional blockTime lookup helpers from fastTokenFetcher
let _getBlockTimeForSlotCached: ((slot: number) => Promise<number | null>) | null = null;
let _getCachedBlockTimeForSlot: ((slot: number) => Promise<number | null>) | null = null;
try {
  const ft = require('./fastTokenFetcher');
  _getBlockTimeForSlotCached = ft && ft.getBlockTimeForSlotCached ? ft.getBlockTimeForSlotCached : null;
  _getCachedBlockTimeForSlot = ft && ft.getCachedBlockTimeForSlot ? ft.getCachedBlockTimeForSlot : null;
} catch (e) { _getBlockTimeForSlotCached = null; _getCachedBlockTimeForSlot = null; }

// Background warmer: periodically prefill recent slot_blocktime entries using the
// existing getBlockTimeForSlotCached helper. This runs best-effort and uses an
// in-memory dedupe set to avoid parallel lookups for the same slot.
let _slotBlocktimeWarmerHandle: any = null;
function startSlotBlocktimeWarmer(opts?: { intervalMs?: number, lookbackSlots?: number }) {
  try {
    if (!(_getBlockTimeForSlotCached || _getCachedBlockTimeForSlot)) return;
    if (_slotBlocktimeWarmerHandle) return;
    const intervalMs = Number(opts?.intervalMs ?? process.env.SLOT_BLOCKTIME_WARMER_INTERVAL_MS ?? 30000);
    const lookback = Number(opts?.lookbackSlots ?? process.env.SLOT_BLOCKTIME_WARMER_LOOKBACK ?? 300);
    const inFlight: Set<number> = new Set();
    _slotBlocktimeWarmerHandle = setInterval(async () => {
      try {
        // determine a recent tip slot from fastTokenFetcher if available, else skip
        const ff = require('./fastTokenFetcher');
        let tipSlot: number | null = null;
        try { if (ff && typeof ff.getRecentSlot === 'function') { tipSlot = await ff.getRecentSlot().catch(() => null); } } catch (e) {}
        // fallback: if no tip, just use Date-based estimation (no-op)
        if (!tipSlot) return;
        const from = Math.max(0, tipSlot - lookback);
        const to = tipSlot;
        for (let s = to; s >= from; s--) {
          if (inFlight.has(s)) continue;
          inFlight.add(s);
          try {
            // use cache-only first to avoid RPCs in warm loop; if missing, call full helper
            const cached = _getCachedBlockTimeForSlot ? await _getCachedBlockTimeForSlot(s).catch(() => null) : null;
            if (cached || cached === 0) {
              // already cached
            } else if (_getBlockTimeForSlotCached) {
              // call full helper which will write cache on success
              try { await _getBlockTimeForSlotCached(s).catch(() => null); } catch (e) {}
            }
          } catch (e) {}
          try { inFlight.delete(s); } catch (e) {}
        }
      } catch (e) {}
    }, intervalMs);
  } catch (e) {}
}
function stopSlotBlocktimeWarmer() { try { if (_slotBlocktimeWarmerHandle) { clearInterval(_slotBlocktimeWarmerHandle); _slotBlocktimeWarmerHandle = null; } } catch (e) {} }
// Normalize a timestamp value (seconds or ms) into ms epoch, or return null
function tsToMs(v: any): number | null {
  try {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!n || Number.isNaN(n)) return null;
    if (n > 1e12) return Math.floor(n);
    if (n > 1e9) return Math.floor(n * 1000);
    return null;
  } catch (e) { return null; }
}
const HELIUS_WS_URL = getHeliusWebsocketUrl();
const USE_WS = HELIUS_USE_WEBSOCKET;
const SUBSCRIBE_METADATA = HELIUS_SUBSCRIBE_METADATA;
const SUBSCRIBE_SPLTOKEN = HELIUS_SUBSCRIBE_SPLTOKEN;

// Enforce listener-only safe mode: when true, avoid making outbound HTTP calls
// or quick external checks (DexScreener/CoinGecko/etc). Controlled via env
// LISTENER_ONLY_MODE or LISTENER_ONLY. Default to true to follow repo policy.
const LISTENER_ONLY_MODE = String(process.env.LISTENER_ONLY_MODE ?? process.env.LISTENER_ONLY ?? 'true').toLowerCase() === 'true';


// Protocol rules dynamic loader (shared with other listeners)
import * as fs from 'fs';
import * as path from 'path';
const PROTOCOL_RULES_PATH = path.join(process.cwd(), 'scripts', 'amm_protocol_rules.json');
let PROTOCOL_RULES: any = null;
function loadProtocolRules() {
  try {
    if (!fs.existsSync(PROTOCOL_RULES_PATH)) return null;
    const txt = fs.readFileSync(PROTOCOL_RULES_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    // build quick map by lowercased pubkey
    const map: Record<string, any> = {};
    for (const p of (parsed.protocols || [])) {
      if (p && p.pubkey) map[String(p.pubkey).toLowerCase()] = p;
    }
    parsed._map = map;
    PROTOCOL_RULES = parsed;
    return parsed;
  } catch (e) { return null; }
}
// initial load and periodic reload every 7s
loadProtocolRules();
setInterval(() => { try { loadProtocolRules(); } catch (e) {} }, Number(process.env.PROTOCOL_RULES_RELOAD_MS || 7000));

export function getProtocolRules() { return PROTOCOL_RULES; }

// Freshness threshold (seconds) used to prefer very recent events even when
// base confidence score is low. Tunable via env HELIUS_FRESHNESS_THRESHOLD_S
const HELIUS_FRESHNESS_THRESHOLD_S = Number(process.env.HELIUS_FRESHNESS_THRESHOLD_S ?? 180);
// If true, only accept low-confidence events when Dexscreener reports pairs (no Helius fallback)
const HELIUS_REQUIRE_DEXSCREENER = (String(process.env.HELIUS_REQUIRE_DEXSCREENER || 'false').toLowerCase() === 'true');
// Max allowed mint age (seconds) for accepting low-confidence events
const HELIUS_MAX_MINT_AGE_S = Number(process.env.HELIUS_MAX_MINT_AGE_S ?? 60);
// In-memory quick caches to reduce API calls
const _quickCheckCache: Map<string, { isTraded?: boolean; isYoung?: boolean; ts: number }> = new Map();
const QUICK_CHECK_TTL_S = Number(process.env.HELIUS_QUICK_CHECK_TTL_S ?? 600); // 10 minutes default
// per-mint dedupe window to ignore repeated events (seconds)
const HELIUS_MINT_DEDUPE_S = Number(process.env.HELIUS_MINT_DEDUPE_S ?? 60);
// Measurement mode: relax dedupe and force extra quick checks when enabled
const HELIUS_MEASURE_MODE = String(process.env.HELIUS_MEASURE_MODE || 'false').toLowerCase() === 'true';
const _recentAccepted: Map<string, number> = new Map();

// Simple HTTP GET with retry/backoff for transient errors (used for quick checks)
async function httpGetWithRetry(url: string, opts: any = {}) {
  try {
  if (LISTENER_ONLY_MODE) return null;
    const axios = require('axios');
    const maxAttempts = Number(process.env.HELIUS_HTTP_RETRY_COUNT ?? 3);
    const baseMs = Number(process.env.HELIUS_HTTP_RETRY_BASE_MS ?? 300);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await axios.get(url, { timeout: Number(opts.timeoutMs || 2000) });
        return res;
      } catch (err: any) {
        const status = err && err.response && err.response.status ? Number(err.response.status) : null;
        // retry on 429/5xx or network errors
        if (attempt < maxAttempts && (status === 429 || (status && status >= 500) || !status)) {
          const delay = baseMs * Math.pow(2, attempt - 1);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        throw err;
      }
    }
    return null;
  } catch (e) { return null; }
}

// Retry wrapper for tokenUtils.officialEnrich to handle transient Helius 429s
async function retryOfficialEnrich(tuMod: any, tokenObj: any, opts: { timeoutMs?: number } = {}) {
  try {
  if (LISTENER_ONLY_MODE) return null;
    try { const cg = await import('./utils/collectorGuard'); if (!cg || !cg.allowEnrichment || !cg.allowEnrichment()) return null; } catch (e) {}
    const maxAttempts = Number(process.env.HELIUS_OFFICIAL_ENRICH_RETRY_COUNT ?? 3);
    const baseMs = Number(process.env.HELIUS_OFFICIAL_ENRICH_RETRY_BASE_MS ?? 300);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!tuMod || typeof tuMod.officialEnrich !== 'function') return null;
        await Promise.race([
          tuMod.officialEnrich(tokenObj, { timeoutMs: Number(opts.timeoutMs || 2000) }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('official-enrich-timeout')), Number(opts.timeoutMs || 2000)))
        ]).catch(() => null);
        // if officialEnrich ran without throwing, return tokenObj so caller can inspect fields
        return tokenObj;
      } catch (err: any) {
        const status = err && err.response && err.response.status ? Number(err.response.status) : null;
        if (attempt < maxAttempts && (status === 429 || (status && status >= 500) || !status)) {
          const delay = baseMs * Math.pow(2, attempt - 1);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        // non-retryable or exhausted attempts
        return null;
      }
    }
    return null;
  } catch (e) { return null; }
}

// Quick external checks to decide if a low-confidence mint has real trading activity.
async function quickIsTraded(mintAddr: string) {
  try {
  if (LISTENER_ONLY_MODE) return false;
    const now = Math.floor(Date.now()/1000);
    const key = String(mintAddr).toLowerCase();
    const cached = _quickCheckCache.get(key);
    if (cached && (now - (cached.ts || 0) <= QUICK_CHECK_TTL_S) && typeof cached.isTraded === 'boolean') return cached.isTraded;
  } catch (e) {}
  try {
    const axios = require('axios');
    const nowS = Math.floor(Date.now()/1000);
    // 1) Dexscreener token pairs endpoint (fast, public)
    try {
  const dTpl = process.env.DEXSCREENER_API_ENDPOINT_TOKEN_PAIRS || 'https://api.dexscreener.com/token-pairs/v1/solana/So11111111111111111111111111111111111111112';
  const dUrl = dTpl.replace(/So11111111111111111111111111111111111111112/g, encodeURIComponent(mintAddr));
  const dRes = await httpGetWithRetry(dUrl, { timeoutMs: Number(process.env.DEXSCREENER_QUICK_TIMEOUT_MS || 1800) }).catch(() => null);
      if (dRes && dRes.data) {
        // dexscreener returns object with pairs; if any pairs exist, it's trading
        if (Array.isArray(dRes.data.pairs) && dRes.data.pairs.length > 0) return true;
        // some endpoints return an object where keys are pairs
        if (typeof dRes.data === 'object' && Object.keys(dRes.data).length > 0 && (dRes.data.pairs || dRes.data.pair)) return true;
      }
    } catch (e) {}

    // 2) Fallback: Helius parse-history for tokenTransfers/nativeTransfers within freshness window
    try {
      const cfg = require('./config');
      const parseTemplate = process.env.HELIUS_PARSE_HISTORY_URL || cfg.HELIUS_PARSE_HISTORY_URL || 'https://api.helius.xyz/v0/addresses/{address}/transactions/?api-key=' + (process.env.HELIUS_API_KEY || '');
      const url = parseTemplate.replace('{address}', encodeURIComponent(mintAddr));
      const axios = require('axios');
  const resp = await httpGetWithRetry(url, { timeoutMs: Number(process.env.HELIUS_QUICK_HTTP_TIMEOUT_MS || 1800) }).catch(() => null);
      if (resp && resp.data && Array.isArray(resp.data) && resp.data.length) {
        for (const tx of resp.data) {
          try {
            const bt = tx.blockTime || (tx?.meta && tx.meta.blockTime) || null;
            if (bt && (nowS - Number(bt) <= HELIUS_FRESHNESS_THRESHOLD_S)) return true;
            // also check tokenTransfers/nativeTransfers entries for non-zero amounts
            const tokenTransfers = tx.tokenTransfers || [];
            for (const tt of tokenTransfers) {
              if (tt && (tt.mint === mintAddr || tt.mint === String(mintAddr))) {
                // consider any token transfer as signal of trading/flow
                if (Number(tt.amount || tt.tokenAmount || tt.uiAmount || 0) > 0) return true;
              }
            }
            const nativeTransfers = tx.nativeTransfers || [];
            if (Array.isArray(nativeTransfers) && nativeTransfers.length) return true;
          } catch (e) {}
        }
      }
    } catch (e) {}
  try { _quickCheckCache.set(String(mintAddr).toLowerCase(), { isTraded: false, ts: Math.floor(Date.now()/1000) }); } catch (e) {}
  return false;
  } catch (e) { return false; }
}

// Dex-only quick check: returns true only if Dexscreener reports pairs/liquidity.
async function quickIsTradedByDex(mintAddr: string) {
  try {
  if (LISTENER_ONLY_MODE) return false;
    const now = Math.floor(Date.now()/1000);
    const key = String(mintAddr).toLowerCase();
    const cached = _quickCheckCache.get(key);
    if (cached && (now - (cached.ts || 0) <= QUICK_CHECK_TTL_S) && typeof cached.isTraded === 'boolean') return cached.isTraded;
  } catch (e) {}
  try {
  const dTpl = process.env.DEXSCREENER_API_ENDPOINT_TOKEN_PAIRS || 'https://api.dexscreener.com/token-pairs/v1/solana/So11111111111111111111111111111111111111112';
  const dUrl = dTpl.replace(/So11111111111111111111111111111111111111112/g, encodeURIComponent(mintAddr));
  const dRes = await httpGetWithRetry(dUrl, { timeoutMs: Number(process.env.DEXSCREENER_QUICK_TIMEOUT_MS || 1800) }).catch(() => null);
    if (dRes && dRes.data) {
      if (Array.isArray(dRes.data.pairs) && dRes.data.pairs.length > 0) return true;
      if (typeof dRes.data === 'object' && Object.keys(dRes.data).length > 0 && (dRes.data.pairs || dRes.data.pair)) return true;
    }
  try { _quickCheckCache.set(String(mintAddr).toLowerCase(), { isTraded: false, ts: Math.floor(Date.now()/1000) }); } catch (e) {}
  return false;
  } catch (e) { return false; }
}

// Quick check whether a mint is actually young (recently created/first-seen)
async function quickIsMintYoung(mintAddr: string, maxAgeSec = HELIUS_MAX_MINT_AGE_S) {
  try {
  if (LISTENER_ONLY_MODE) return false;
    const now = Math.floor(Date.now()/1000);
    const key = String(mintAddr).toLowerCase();
    const cached = _quickCheckCache.get(key);
    if (cached && (now - (cached.ts || 0) <= QUICK_CHECK_TTL_S) && typeof cached.isYoung === 'boolean') return cached.isYoung;
  } catch (e) {}
  try {
    if (!mintAddr) return false;
    const ff = require('./fastTokenFetcher');
    // 1) try cache-only snapshot for cheap result
    try {
      if (ff && typeof ff.getMintSnapshotCached === 'function') {
        const snap = await ff.getMintSnapshotCached(mintAddr).catch(() => null);
        if (snap) {
          let ok = false;
          if (typeof snap.ageSeconds === 'number' && !isNaN(Number(snap.ageSeconds))) {
            ok = Number(snap.ageSeconds) <= Number(maxAgeSec);
          } else if (typeof snap.lastSeenTs === 'number' && !isNaN(Number(snap.lastSeenTs))) {
            const age = Math.floor(Date.now() / 1000) - Number(snap.lastSeenTs);
            ok = age <= Number(maxAgeSec);
          }
          try { _quickCheckCache.set(String(mintAddr).toLowerCase(), { isYoung: ok, ts: Math.floor(Date.now()/1000) }); } catch (e) {}
          if (ok) return true;
        }
      }
    } catch (e) {}

    // 2) fallback: run handleNewMintEventCached (heavier, but reliable) with short timeout
    try {
      const ffLocal = require('./fastTokenFetcher');
      const tmo = Number(process.env.HELIUS_QUICK_HANDLE_TIMEOUT_MS || 2500);
      let res: any = null;
      try {
        res = await Promise.race([
          ffLocal && typeof ffLocal.handleNewMintEventCached === 'function' ? ffLocal.handleNewMintEventCached(mintAddr).catch(() => null) : (ffLocal && typeof ffLocal.handleNewMintEvent === 'function' ? ffLocal.handleNewMintEvent(mintAddr).catch(() => null) : null),
          new Promise((_, rej) => setTimeout(() => rej(new Error('handle-timeout')), tmo))
        ]).catch(() => null);
      } catch (e) { res = null; }
      if (res && typeof res.ageSeconds === 'number' && !isNaN(Number(res.ageSeconds))) {
        const ok = Number(res.ageSeconds) <= Number(maxAgeSec);
        try { _quickCheckCache.set(String(mintAddr).toLowerCase(), { isYoung: ok, ts: Math.floor(Date.now()/1000) }); } catch (e) {}
        return ok;
      }
    } catch (e) {}

  try { _quickCheckCache.set(String(mintAddr).toLowerCase(), { isYoung: false, ts: Math.floor(Date.now()/1000) }); } catch (e) {}
  return false;
  } catch (e) { return false; }
}


// Confidence threshold for automatic enrichment (0.0 - 1.0). Can be tuned via env.
// Lower default to include lower-confidence events in automatic enrichment flows.
// Set env HELIUS_ENRICH_SCORE_THRESHOLD to override (e.g. 0.05 for permissive).
const HELIUS_ENRICH_SCORE_THRESHOLD = Number(process.env.HELIUS_ENRICH_SCORE_THRESHOLD ?? 0.05);
// Known program/account IDs that should never be treated as mint addresses
const HELIUS_KNOWN_PROGRAM_IDS = new Set([
  '11111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  'SysvarRent111111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111'
]);

// Simple in-memory stats for listener (useful for quick diagnostics)
const _heliusListenerStats: Record<string, number> = {
  processed: 0,
  enriched: 0,
  skippedLowConfidence: 0,
  parseErrors: 0,
  // quick-path telemetry
  cacheHit: 0,
  cacheMiss: 0,
  // background resolution telemetry
  bgResolved: 0,
  bgNull: 0,
  bgInFlight: 0,
  bgSkippedDueToDedupe: 0,
  // per-mint background enrichment telemetry
  bgMintInFlight: 0,
  bgMintResolved: 0,
  bgMintNull: 0,
  bgMintFailed: 0,
  bgMintSkippedDueToDedupe: 0,
};

export function getHeliusListenerStats() { try { return { ..._heliusListenerStats }; } catch { return null; } }
export function resetHeliusListenerStats() { try { _heliusListenerStats.processed = 0; _heliusListenerStats.enriched = 0; _heliusListenerStats.skippedLowConfidence = 0; _heliusListenerStats.parseErrors = 0; } catch {} }

// Lazy import so project can run without ws installed when not used
async function startHeliusWebsocketListener(options?: { onMessage?: (msg: any) => void; onOpen?: () => void; onClose?: () => void; onError?: (err: any) => void; }) {
  if (!USE_WS) {
    console.log('HELIUS WebSocket disabled via HELIUS_USE_WEBSOCKET=false');
    return { stop: () => Promise.resolve() };
  }

  if (!HELIUS_WS_URL) {
    console.warn('HELIUS_WEBSOCKET_URL not set in .env; WebSocket listener will not start.');
    return { stop: () => Promise.resolve() };
  }

  const wsModule = await import('ws');
  const WebSocket = (wsModule as any).default || wsModule;

  const ws = new WebSocket(HELIUS_WS_URL, {
    // no extra options; Helius typically accepts api-key in query string
    handshakeTimeout: 5000,
  } as any);

  let closed = false;
  // recent events buffer (in-memory) to allow polling latest events
  const recentEvents: any[] = [];
  // in-memory set to dedupe background slot->blockTime resolutions
  const _backgroundSlotLookupsInFlight: Set<number> = new Set();
  // in-memory set to dedupe background per-mint officialEnrich resolutions
  const _backgroundMintEnrichInFlight: Set<string> = new Set();
  function pushEvent(ev: any) {
    try {
  recentEvents.unshift(ev);
      if (recentEvents.length > 200) recentEvents.length = 200;
    } catch {}
  }

  // periodic diagnostics logger for telemetry
  let _diagInterval: any = null;
  function startDiagInterval() {
    try {
      if (_diagInterval) return;
      const verbose = !!process.env.HELIUS_VERBOSE;
      const interval = Number(process.env.HELIUS_DIAG_INTERVAL_MS || (verbose ? 15000 : 60000));
      _diagInterval = setInterval(() => {
        try {
          const s = { ..._heliusListenerStats };
          if (verbose) console.log('HELIUS-LISTENER-STATS:', JSON.stringify(s)); else if ((s.processed || 0) % 500 === 0) console.log('HELIUS-LISTENER-STATS summary:', JSON.stringify({ processed: s.processed, enriched: s.enriched, skippedLowConfidence: s.skippedLowConfidence }));
        } catch (e) {}
      }, interval);
    } catch (e) {}
  }
  function stopDiagInterval() { try { if (_diagInterval) { clearInterval(_diagInterval); _diagInterval = null; } } catch (e) {} }

  ws.on('open', () => {
    options?.onOpen && options.onOpen();
    console.log('HELIUS WebSocket connected');
  startDiagInterval();
  try { startSlotBlocktimeWarmer({ intervalMs: Number(process.env.SLOT_BLOCKTIME_WARMER_INTERVAL_MS || 30000), lookbackSlots: Number(process.env.SLOT_BLOCKTIME_WARMER_LOOKBACK || 400) }); } catch (e) {}
    try {
      // automatic subscriptions for common programs
      const subscriptions: Record<number, string> = {};
      let sid = 1;
      const sendSub = (method: string, params: any, tag: string) => {
        const id = sid++;
        subscriptions[id] = tag;
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch (e) {}
        console.log('Sent subscribe', tag, method);
      };
      if (SUBSCRIBE_METADATA) {
        // Metaplex Token Metadata program
        const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
        sendSub('logsSubscribe', [{ mentions: [METADATA_PROGRAM] }, { commitment: 'confirmed' }], 'metadata');
      }
      if (SUBSCRIBE_SPLTOKEN) {
        const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        sendSub('logsSubscribe', [{ mentions: [SPL_TOKEN_PROGRAM] }, { commitment: 'confirmed' }], 'spl-token');
      }
      // listen for subscription confirmations in messages (they come as normal JSON responses)
      ws.on('message', (m) => {
        try {
          const parsed = typeof m === 'string' ? JSON.parse(m) : JSON.parse(m.toString());
          if (parsed && typeof parsed === 'object' && parsed.id && subscriptions[parsed.id]) {
            console.log('Subscription confirmed:', subscriptions[parsed.id], 'id=', parsed.result ?? parsed.id);
          }
        } catch (e) {}
      });
    } catch (e) {
      // ignore subscription failures
    }
  });

  ws.on('message', async (data) => {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
      // Single onMessage callback
      try { options?.onMessage && options.onMessage(parsed); } catch (e) {}
      try {
  const evt = analyzeHeliusMessage(parsed);
        if (!evt) return;
  try { const tmod = await import('./utils/trace'); tmod.traceFlow('heliusWsListener:event_received',{ mint: evt.mint || null, kind: evt.eventType || null, rawSummary: !!(parsed && parsed.params && parsed.params.result && parsed.params.result.value), signature: parsed?.params?.result?.value?.signature ?? parsed?.result?.value?.signature ?? null }); } catch(e){}
        // attach protocol-rule match if available
        try {
          const rules = PROTOCOL_RULES && PROTOCOL_RULES._map ? PROTOCOL_RULES._map : null;
          if (rules && parsed && parsed.params && parsed.params.result && parsed.params.result.value) {
            const value = parsed.params.result.value;
            const instrs = (value.transaction && value.transaction.message && value.transaction.message.instructions) || (value.meta && value.meta.innerInstructions) || [];
            // try to detect a programId from top-level instructions
            try {
              const first = Array.isArray(instrs) ? instrs[0] : null;
              const pid = first && (first.programId || first.program) ? String(first.programId || first.program).toLowerCase() : null;
              if (pid && rules[pid]) {
                (evt as any)._protocolRule = rules[pid];
              }
            } catch (e) {}
          }
        } catch (e) {}
        const VERBOSE = !!process.env.HELIUS_VERBOSE;
        // Strict memo policy: reject memo-only detections unless corroborated
        if (evt.eventType === 'memo') {
          const v = parsed?.params?.result?.value || parsed?.result?.value || parsed?.value || parsed?.result || parsed;
          const hasPostBalances = !!(v && v.meta && Array.isArray(v.meta.postTokenBalances) && v.meta.postTokenBalances.length > 0);
          const hasInnerWithPost = !!(v && v.meta && Array.isArray(v.meta.innerInstructions) && v.meta.innerInstructions.some((b: any) => Array.isArray(b.instructions) && b.instructions.some((ins: any) => ins && ins.parsed && ins.parsed.info && Array.isArray(ins.parsed.info.postTokenBalances) && ins.parsed.info.postTokenBalances.length > 0)));
          // Conservative policy: reject any memo-only event that lacks on-chain corroboration.
          if (!hasPostBalances && !hasInnerWithPost) {
            _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
            if (VERBOSE) console.log('Rejecting memo-only event (conservative policy): no on-chain corroboration', evt.mint || '(no-mint)');
            return;
          }
        }
        pushEvent(evt);
        try { if ((options as any)?.onNewMint) (options as any).onNewMint(evt); } catch (e) {}

        _heliusListenerStats.processed = (_heliusListenerStats.processed || 0) + 1;
        const score = computeEventConfidence(evt, parsed);
        if (typeof score !== 'number' || Number.isNaN(score) || score < HELIUS_ENRICH_SCORE_THRESHOLD) {
          // Before skipping, try a lightweight quick-check against the global fetch cache
          try {
            const ff = require('./fastTokenFetcher');
            const tu = require('./utils/tokenUtils');
            const globalCache = ff.getGlobalFetchCache ? ff.getGlobalFetchCache() : [];
            const addrKey = String(evt.mint || '').toLowerCase();
            let quickHintFound = false;
            if (Array.isArray(globalCache) && addrKey) {
              for (const item of globalCache) {
                try {
                  const key = String(item.tokenAddress || item.address || item.mint || '').toLowerCase();
                  if (!key) continue;
                  if (key === addrKey) {
                    const liq = tu.getField(item, 'liquidity');
                    const vol = tu.getField(item, 'volume');
                    if ((liq && Number(liq) > 0) || (vol && Number(vol) > 0)) {
                      quickHintFound = true;
                      break;
                    }
                  }
                } catch (e) {}
              }
            }
            if (quickHintFound) {
              // For memo-only events, require nearby postTokenBalances to avoid memo noise
              if (evt.eventType === 'memo') {
                const v = parsed?.params?.result?.value || parsed?.result?.value || parsed?.value || parsed?.result || parsed;
                const hasPostBalances = !!(v && v.meta && Array.isArray(v.meta.postTokenBalances) && v.meta.postTokenBalances.length > 0);
                if (!hasPostBalances) {
                  _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
                  try { if ((_heliusListenerStats.skippedLowConfidence || 0) % 50 === 1) console.log('Skipping memo-only event (no postTokenBalances)', evt.mint || '(no-mint)'); } catch {}
                  return;
                }
              }
              // If cache hints liquidity/volume, schedule a non-blocking quick officialEnrich for this mint
              try {
                const tuMod = require('./utils/tokenUtils');
                const ff = require('./fastTokenFetcher');
                const tokenAddr = evt.mint;
                // schedule background enrichment (do not await). If it fills useful fields, emit a followup.
                // dedupe background enrich for same mint
                if (!_backgroundMintEnrichInFlight.has(String(tokenAddr).toLowerCase())) {
                  _backgroundMintEnrichInFlight.add(String(tokenAddr).toLowerCase());
                  _heliusListenerStats.bgMintInFlight = (_heliusListenerStats.bgMintInFlight || 0) + 1;
                  (async () => {
                    try {
                      const tokenObj: any = { tokenAddress: tokenAddr };
                      // run officialEnrich with retry/backoff wrapper
                      await retryOfficialEnrich(tuMod, tokenObj, { timeoutMs: Number(process.env.HELIUS_QUICK_OFFICIAL_ENRICH_TIMEOUT_MS || 2000) }).catch(() => null);
                      // If enrichment retrieved useful fields, persist snapshot via fastTokenFetcher if available
                      if (tokenObj && (tokenObj.poolOpenTimeMs || tokenObj.liquidity || tokenObj.volume)) {
                        try {
                          if (ff && typeof ff.updateMintStatsFromEvent === 'function') {
                            // best-effort: update mint stats cache so future quick-emits include numeric fields
                            const slotForUpdate = (evt && (evt.firstSlot !== undefined ? evt.firstSlot : null));
                            await ff.updateMintStatsFromEvent(tokenAddr, 0, slotForUpdate, Date.now() / 1000).catch(() => {});
                          }
                        } catch (e) {}
                        // emit follow-up so downstream parsers see enriched data
                        try {
                          const follow = { mint: tokenAddr, eventType: evt.eventType || null, detectedAt: evt.detectedAt || null, enriched: true, _diag: { quickOfficialEnrich: true } };
                          if (VERBOSE) console.log(JSON.stringify({ helius_quick_enrich_followup: follow }));
                        } catch (e) {}
                        _heliusListenerStats.bgMintResolved = (_heliusListenerStats.bgMintResolved || 0) + 1;
                      } else {
                        _heliusListenerStats.bgMintNull = (_heliusListenerStats.bgMintNull || 0) + 1;
                      }
                    } catch (e) {
                      _heliusListenerStats.bgMintFailed = (_heliusListenerStats.bgMintFailed || 0) + 1;
                    } finally {
                      try { _backgroundMintEnrichInFlight.delete(String(tokenAddr).toLowerCase()); } catch (e) {}
                      try { _heliusListenerStats.bgMintInFlight = Math.max(0, (_heliusListenerStats.bgMintInFlight || 1) - 1); } catch (e) {}
                    }
                  })();
                } else {
                  _heliusListenerStats.bgMintSkippedDueToDedupe = (_heliusListenerStats.bgMintSkippedDueToDedupe || 0) + 1;
                }
                // allow original flow to continue (do not block)
              } catch (e) {
                _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
                try { if ((_heliusListenerStats.skippedLowConfidence || 0) % 10 === 1) console.log('Skipping enrichment due to low confidence (sampled)', evt.mint || '(no-mint)', 'score=', typeof score === 'number' && score.toFixed ? score.toFixed(2) : score); } catch {}
                return;
              }
            } else {
                // Before skipping low-confidence events, require the transaction
                // itself to show token-related activity. This avoids trusting labels
                // or memos without transaction corroboration. Only when transaction
                // content indicates token activity do we run external quick checks.
                try {
                  const txLikely = isLikelyTokenByTx(parsed, evt);
                  if (!txLikely) {
                    _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
                    try { if ((_heliusListenerStats.skippedLowConfidence || 0) % 50 === 1) console.log('Skipping low-confidence event: tx does not show token activity', evt.mint || '(no-mint)', 'eventType=', evt.eventType); } catch {}
                    return;
                  }

                  const mintAddr = String(evt.mint || '').trim();
                  let isTraded = false;
                  if (mintAddr) {
                    try {
                      if (HELIUS_REQUIRE_DEXSCREENER) isTraded = await quickIsTradedByDex(mintAddr);
                      else isTraded = await quickIsTraded(mintAddr);
                    } catch (e) { isTraded = false; }
                  }
                  // Also require the mint to be actually young (created/recently seen)
                  let isYoung = false;
                  try { isYoung = await quickIsMintYoung(evt.mint); } catch (e) { isYoung = false; }
                  if (!isTraded || !isYoung) {
                    _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
                    try { if ((_heliusListenerStats.skippedLowConfidence || 0) % 50 === 1) console.log('Skipping enrichment due to low confidence (not traded/too-old)', evt.mint || '(no-mint)', 'score=', typeof score === 'number' && score.toFixed ? score.toFixed(2) : score); } catch {}
                    return;
                  }
                  // if traded and young, allow flow to continue and schedule background enrich if needed
                } catch (e) {
                  _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
                  try { console.log('Skipping enrichment due to low confidence', evt.mint || '(no-mint)', 'score=', typeof score === 'number' && score.toFixed ? score.toFixed(2) : score); } catch {}
                  return;
                }
            }
          } catch (e) {
            _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
            try { console.log('Skipping enrichment due to low confidence', evt.mint || '(no-mint)', 'score=', typeof score === 'number' && score.toFixed ? score.toFixed(2) : score); } catch {}
            return;
          }
        }

        // Emit a compact, single-line structured JSON for quick observation / terminal-only workflows.
        try {
          const sig = parsed?.params?.result?.value?.signature ?? parsed?.result?.value?.signature ?? null;
          const slot = evt.firstSlot ?? parsed?.params?.result?.context?.slot ?? parsed?.result?.context?.slot ?? null;
          const _slotForMintStats = slot ? Number(slot) : undefined;
          // attempt a small cached blockTime lookup (race with timeout)
          let blockTime: number | null = null;
          let blockTimeReason: string | null = null;
          let quickDebug: Record<string, any> | null = null;
          if (slot) {
            // 1) Cache-only fast lookup (no RPCs)
            try {
              if (_getCachedBlockTimeForSlot) {
                const start = Date.now();
                const cached = await _getCachedBlockTimeForSlot(Number(slot)).catch(() => null);
                const elapsed = Date.now() - start;
                if (cached || cached === 0) {
                  blockTime = cached;
                  blockTimeReason = 'cache-hit';
                  _heliusListenerStats.cacheHit = (_heliusListenerStats.cacheHit || 0) + 1;
                  quickDebug ??= {};
                  (quickDebug as any).blockTimeDiag = { reason: blockTimeReason, elapsedMs: elapsed };
                } else {
                  blockTimeReason = 'cache-miss';
                  _heliusListenerStats.cacheMiss = (_heliusListenerStats.cacheMiss || 0) + 1;
                  quickDebug ??= {};
                  (quickDebug as any).blockTimeDiag = { reason: blockTimeReason, elapsedMs: elapsed };
                }
              }
            } catch (e) {
              blockTime = null; blockTimeReason = 'exception';
            }

            // 2) Optional short synchronous resolution (race with timeout)
            try {
              const ALLOW_SYNC = String(process.env.HELIUS_QUICK_SYNC_BLOCKTIME ?? 'true').toLowerCase() !== 'false';
              const SYNC_TIMEOUT_MS = Number(process.env.HELIUS_QUICK_SYNC_TIMEOUT_MS ?? 1200);
              if ((blockTime === null || blockTime === undefined) && _getBlockTimeForSlotCached && ALLOW_SYNC) {
                try {
                  const startSync = Date.now();
                  const wrapped = await Promise.race([
                    _getBlockTimeForSlotCached(Number(slot)).catch(() => null),
                    new Promise(resolve => setTimeout(() => resolve(null), SYNC_TIMEOUT_MS))
                  ]) as any;
                  const elapsedSync = Date.now() - startSync;
                  if (wrapped || wrapped === 0) {
                    blockTime = wrapped;
                    blockTimeReason = 'sync-resolved';
                    _heliusListenerStats.bgResolved = (_heliusListenerStats.bgResolved || 0) + 1;
                    quickDebug ??= {};
                    (quickDebug as any).blockTimeDiag = { reason: blockTimeReason, elapsedMs: elapsedSync };
                  } else {
                    // leave reason as cache-miss and fall through to background resolution
                    blockTimeReason = 'cache-miss';
                  }
                } catch (e) {
                  blockTimeReason = 'exception';
                }
              }
            } catch (e) {
              /* ignore */
            }

            // 3) If still unresolved, schedule a background resolution (best-effort)
            if ((blockTime === null || blockTime === undefined) && _getBlockTimeForSlotCached) {
              const slotNum = Number(slot);
              if (!_backgroundSlotLookupsInFlight.has(slotNum)) {
                _backgroundSlotLookupsInFlight.add(slotNum);
                _heliusListenerStats.bgInFlight = (_heliusListenerStats.bgInFlight || 0) + 1;
                (async () => {
                  try {
                    const start2 = Date.now();
                    const bt = await _getBlockTimeForSlotCached(slotNum);
                    const elapsed2 = Date.now() - start2;
                    if (bt || bt === 0) {
                      _heliusListenerStats.bgResolved = (_heliusListenerStats.bgResolved || 0) + 1;
                                  const follow = {
                                    mint: evt.mint || null,
                                    eventType: evt.eventType || null,
                                    detectedAt: evt.detectedAt || null,
                                    slot: slotNum,
                                    signature: sig,
                                    blockTime: tsToMs(bt) || null,
                                    score: (typeof score === 'number' && !Number.isNaN(score)) ? Number(score.toFixed ? score.toFixed(3) : score) : null,
                                    _diag: { blockTimeDiag: { reason: 'background-resolved', elapsedMs: elapsed2 } }
                                  };
                      try { if (VERBOSE) console.log('helius_quick_enrich_followup:', evt.mint || '(no-mint)', 'slot=', slotNum, 'blockTime=', bt, 'diag=', JSON.stringify((follow as any)._diag)); } catch {}
                      if (VERBOSE) console.log(JSON.stringify({ helius_quick_enrich_followup: follow }));
                    } else {
                      _heliusListenerStats.bgNull = (_heliusListenerStats.bgNull || 0) + 1;
                      const follow = { mint: evt.mint || null, slot: slotNum, blockTime: null, _diag: { blockTimeDiag: { reason: 'background-null', elapsedMs: elapsed2 } } };
                      try { if (VERBOSE) console.log('helius_quick_enrich_followup:', evt.mint || '(no-mint)', 'slot=', slotNum, 'blockTime= null', 'diag=', JSON.stringify((follow as any)._diag)); } catch {}
                      if (VERBOSE) console.log(JSON.stringify({ helius_quick_enrich_followup: follow }));
                    }
                  } catch (e) {
                    // background resolution failed; best-effort
                  } finally {
                    try { _backgroundSlotLookupsInFlight.delete(slotNum); } catch (e) {}
                    try { _heliusListenerStats.bgInFlight = Math.max(0, (_heliusListenerStats.bgInFlight || 1) - 1); } catch (e) {}
                  }
                })();
              } else {
                _heliusListenerStats.bgSkippedDueToDedupe = (_heliusListenerStats.bgSkippedDueToDedupe || 0) + 1;
              }
            }
          }

            // Attempt to attach a per-mint snapshot from cache (must be fast and cache-only)
            let mintSnapshot: Record<string, any> | null = null;
            let mintSnapshotDiag: Record<string, any> | null = null;
            try {
              if (evt && evt.mint) {
                const ftf = require('./fastTokenFetcher');
                if (ftf && typeof ftf.getMintSnapshotCached === 'function') {
                  const startMs = Date.now();
                  const snap = await ftf.getMintSnapshotCached(evt.mint).catch(() => null);
                  const elapsedMs = Date.now() - startMs;
                  if (snap) {
                    mintSnapshot = snap;
                    mintSnapshotDiag = { reason: 'cache-hit', elapsedMs };
                  } else {
                    mintSnapshotDiag = { reason: 'cache-miss', elapsedMs };
                  }
                }
              }
            } catch (e) { mintSnapshot = null; mintSnapshotDiag = { reason: 'exception' }; }

          const quick: any = {
            mint: evt.mint || null,
            eventType: evt.eventType || null,
            detectedAt: evt.detectedAt || null,
            slot: slot,
            signature: sig,
            blockTime: tsToMs(blockTime) || null,
            score: (typeof score === 'number' && !Number.isNaN(score)) ? Number(score.toFixed ? score.toFixed(3) : score) : null,
          };
          // attach mintSnapshot if available
          try { if (mintSnapshot) (quick as any).mintSnapshot = mintSnapshot; if (mintSnapshotDiag) (quick as any)._diag = (quick as any)._diag || {}; (quick as any)._diag.mintSnapshotDiag = mintSnapshotDiag; } catch (e) {}
          // best-effort: lift numeric snapshot fields into quick top-level for easier parsing/filters
          try {
            if (mintSnapshot) {
              if (typeof mintSnapshot.approxLiquidity === 'number') quick.approxLiquidity = mintSnapshot.approxLiquidity;
              if (typeof mintSnapshot.volume_60s === 'number') quick.volume_60s = mintSnapshot.volume_60s;
              if (typeof mintSnapshot.volume_3600s === 'number') quick.volume_3600s = mintSnapshot.volume_3600s;
            }
          } catch (e) {}
          // include optional debug diagnostics
          try { if (!(quickDebug as any)) quickDebug = {}; if (Object.keys((quickDebug as any)).length) (quick as any)._diag = quickDebug; } catch {}
          // If blockTime is missing, attempt a short on-chain first-tx lookup to improve accuracy
          try {
            if ((!blockTime && blockTime !== 0) && typeof evt.mint === 'string' && evt.mint.length) {
              try {
                const tu = require('./utils/tokenUtils');
                // small timeout so we don't block too long on quick-path
                const quickTs = await tu.getFirstOnchainTimestamp(evt.mint, { timeoutMs: Number(process.env.HELIUS_QUICK_ONCHAIN_TIMEOUT_MS ?? 900) }).catch(() => ({ ts: null }));
                if (quickTs && quickTs.ts) {
                  blockTime = quickTs.ts;
                  blockTimeReason = 'first-onchain-quick';
                  (quickDebug as any) ??= {};
                  (quickDebug as any).blockTimeDiag = { reason: blockTimeReason, source: quickTs.source || 'onchain', elapsedMs: null };
                }
              } catch (e) {}
            }
          } catch (e) {}

          // enforce per-mint dedupe: avoid emitting same mint within effective window
          try {
            const k = String(evt.mint || '').toLowerCase();
            const last = _recentAccepted.get(k);
            const nowSec = Math.floor(Date.now()/1000);
            const effectiveDedupe = HELIUS_MEASURE_MODE ? Number(process.env.HELIUS_MEASURE_DEDUPE_S ?? 5) : HELIUS_MINT_DEDUPE_S;

            // If still no blockTime, require quickIsTraded & quickIsMintYoung (best-effort) to avoid old references
            if ((!blockTime && blockTime !== 0)) {
              try {
                let isTraded = false;
                let isYoung = false;
                try { if (String(evt.mint || '').trim()) isTraded = await quickIsTraded(String(evt.mint).trim()); } catch (e) { isTraded = false; }
                try { isYoung = await quickIsMintYoung(evt.mint); } catch (e) { isYoung = false; }
                if (!(isTraded && isYoung)) {
                  // skip noisy/old reference
                  _heliusListenerStats.skippedLowConfidence = (_heliusListenerStats.skippedLowConfidence || 0) + 1;
                  try { if ((_heliusListenerStats.skippedLowConfidence || 0) % 50 === 1) console.log('Skipping quick-enrich: missing blockTime and not traded/young', evt.mint || '(no-mint)'); } catch (e) {}
                  throw new Error('skip-quiet-older');
                }
              } catch (e) { throw e; }
            }

            if (!last || (nowSec - last) > effectiveDedupe) {
              // record acceptance timestamp
              try { _recentAccepted.set(k, nowSec); } catch (e) {}
              const diagShort = (quick as any)._diag ? `diag=${JSON.stringify((quick as any)._diag)}` : '';
              try { console.log('helius_quick_enrich:', evt.mint || '(no-mint)', 'slot=', slot, 'blockTime=', blockTime, diagShort); } catch (e) {}
              console.log(JSON.stringify({ helius_quick_enrich: quick }));
            } else {
              // skip noisy duplicate emission
            }
          } catch (e) {}
        } catch (e) {}

        // proceed with enrichment
        try {
          const ff = require('./fastTokenFetcher');
          const hf = ff && (ff.handleNewMintEvent || ff.default && ff.default.handleNewMintEvent);
          if (typeof hf === 'function') {
            try {
              const mgrMod = require('./heliusEnrichmentQueue');
              const mgr = (mgrMod && mgrMod._manager) || (mgrMod && mgrMod.createEnrichmentManager && (mgrMod._manager = mgrMod.createEnrichmentManager({ ttlSeconds: 300, maxConcurrent: 3 })));
              const p = mgr.enqueue(evt, hf);
              try { const tmod = await import('./utils/trace'); tmod.traceFlow('heliusWsListener:enrichment_enqueued',{ mint: evt.mint || null, handler: hf ? 'fastTokenFetcher.handleNewMintEvent' : 'none' }); } catch(e){}
              // best-effort background stats update: update mint snapshot volumes/eventCount (non-blocking)
              try {
                const ftf = require('./fastTokenFetcher');
                if (ftf && typeof ftf.updateMintStatsFromEvent === 'function') {
                  // try to extract a numeric amount from parsed innerInstructions/postTokenBalances if present
                  (async () => {
                    try {
                      let amt = 0;
                      try {
                        const res = parsed?.params?.result?.value || parsed?.result?.value || parsed?.result || parsed;
                        // search postTokenBalances for lamports changes (amount fields may be string w/ decimals)
                        if (res && res.meta && Array.isArray(res.meta.postTokenBalances)) {
                          for (const b of res.meta.postTokenBalances) {
                            try { if (b && b.mint === evt.mint && b.uiTokenAmount && b.uiTokenAmount.uiAmount) { amt = Math.max(amt, Number(b.uiTokenAmount.uiAmount)); } } catch (e) {}
                          }
                        }
                      } catch (e) {}
            try {
                      const capturedSlotLocal = evt.firstSlot ?? parsed?.params?.result?.context?.slot ?? parsed?.result?.context?.slot ?? null;
                      await ftf.updateMintStatsFromEvent(evt.mint, amt || 0, capturedSlotLocal ? Number(capturedSlotLocal) : undefined, undefined);
                    } catch (e) {}
                    } catch (e) {}
          })();
                }
              } catch (e) {}
              _heliusListenerStats.enriched = (_heliusListenerStats.enriched || 0) + 1;
              if (p && typeof p.then === 'function') {
                const safeString = (v: any, n = 400) => { try { if (!v && v !== 0) return ''; if (typeof v === 'string') return v.slice(0,n); return JSON.stringify(v).slice(0,n); } catch { try { return String(v).slice(0,n); } catch { return ''; } } };
                p.then((res: any) => {
                  try {
                    if (res && res.skipped) console.log('Enrichment result skipped for', evt.mint || '(no-mint)', 'reason=', res.reason);
                    else if (res) console.log('Enrichment completed for', evt.mint || '(no-mint)', safeString(res, 400));
                  } catch (e) {}
                }).catch((err: any) => { try { console.warn('Enrichment promise rejected', err && err.message ? err.message : err); } catch {} });
              }
            } catch (e) {
              try { hf(evt).catch(() => {}); } catch {}
            }
          }
        } catch (e) { /* swallow enrichment path errors */ }
      } catch (e) { _heliusListenerStats.parseErrors = (_heliusListenerStats.parseErrors || 0) + 1; }
    } catch (err) {
      _heliusListenerStats.parseErrors = (_heliusListenerStats.parseErrors || 0) + 1;
      console.warn('Failed to parse Helius WS message', err);
    }
  });

  ws.on('close', (code, reason) => {
    closed = true;
    options?.onClose && options.onClose();
    console.log('HELIUS WebSocket closed', code, reason?.toString());
  stopDiagInterval();
  try { stopSlotBlocktimeWarmer(); } catch (e) {}
  });

  ws.on('error', (err) => {
    options?.onError && options.onError(err);
    console.warn('HELIUS WebSocket error', err?.message || err);
  });

  function stop() {
    return new Promise<void>((resolve) => {
      if (closed) return resolve();
      try {
        ws.once('close', () => resolve());
        ws.close();
      } catch (e) {
        resolve();
      }
    });
  }

  // ensure diag interval cleaned up when stop called
  const origStop = api => {};

  // Public API
  const api = {
    ws,
    stop,
    getRecentEvents: () => Array.isArray(recentEvents) ? recentEvents.slice() : [],
  };
  // save instance for global getter
  try { saveLastInstance(api); } catch {}
  return api;
}

export { startHeliusWebsocketListener };

// Lightweight analyzer: try to find relevant info (mint, eventType, timestamp)
function analyzeHeliusMessage(parsed: any) {
  if (!parsed) return null;
  // Helius WS may deliver messages under params.result or result
  const obj = parsed.params?.result || parsed.result || parsed;
  // try to extract context.slot when present so callers can use slot->getBlockTime fallback
  const slotFromCtx = parsed?.params?.result?.context?.slot ?? parsed?.result?.context?.slot ?? parsed?.context?.slot ?? null;
  // First, if this is a logsNotification, inspect value.logs for initialize_mint or metadata creation
  try {
    const res = parsed.params?.result || parsed.result || parsed;
    const v = res.value || res; // sometimes nested
    // Consolidate logs sources: top-level logs, meta.logMessages, value.logs
    const logs: string[] = [];
    if (v && Array.isArray(v.logs)) logs.push(...v.logs.filter((x: any) => typeof x === 'string'));
    if (v && v.meta && Array.isArray(v.meta.logMessages)) logs.push(...v.meta.logMessages.filter((x: any) => typeof x === 'string'));

    // Helius logsNotification: inspect logs for explicit patterns and memo content
    if (logs.length) {
      for (const ln of logs) {
        if (typeof ln !== 'string') continue;
        const low = ln.toLowerCase();
        // common explicit patterns
        if (low.includes('initialize_mint') || low.includes('create_metadata') || low.includes('create metadata account') || low.includes('create_metadata_account')) {
          const m = ln.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
          if (m && m.length) return { mint: m[0], eventType: 'metadata_or_initialize', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
        }
        // memo program may include a raw mint in memo text or label
        if (low.includes('memo') || ln.includes('Memo') || ln.includes('memo:')) {
          const m = ln.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
          if (m && m.length) return { mint: m[0], eventType: 'memo', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
        }
        // sometimes labels like 'name: <mint>' or 'mint: <addr>' appear
  const labelMatch = ln.match(/(?:mint[:=]\s*|name[:=]\s*)([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (labelMatch && labelMatch[1]) return { mint: labelMatch[1], eventType: 'label', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
      }
    }

    // If Helius gives parsed inner instructions (meta.innerInstructions), search there first
    if (v && v.meta && Array.isArray(v.meta.innerInstructions)) {
      for (const block of v.meta.innerInstructions) {
        if (!block || !Array.isArray(block.instructions)) continue;
        for (const ins of block.instructions) {
          try {
            if (ins.parsed && typeof ins.parsed === 'object') {
              const info = ins.parsed.info || ins.parsed;
              if (info && typeof info === 'object') {
                const cand = info.mint || info.token || info.mintAddress || info.account || info.destination || info.source || null;
                if (typeof cand === 'string' && cand.length >= 32 && cand.length <= 44) return { mint: cand, eventType: 'inner_parsed', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
                // sometimes 'mint' appears nested inside other objects
                if (info.postTokenBalances && Array.isArray(info.postTokenBalances)) {
                  for (const b of info.postTokenBalances) {
                    if (b && typeof b.mint === 'string' && b.mint.length >= 32 && b.mint.length <= 44) return { mint: b.mint, eventType: 'postTokenBalance', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
                  }
                }
              }
            }
          } catch (e) {}
        }
      }
    }

    // Broadened scan of transaction.message.instructions (incl. parsed forms)
    if (v && v.transaction && v.transaction.message && Array.isArray(v.transaction.message.instructions)) {
      for (const ins of v.transaction.message.instructions) {
        try {
          if (ins.parsed && typeof ins.parsed === 'object') {
            const t = (ins.parsed.type || ins.parsed.instruction || '') + '';
            const info = ins.parsed.info || ins.parsed;
            if (info && typeof info === 'object') {
              const cand = info.mint || info.token || info.mintAddress || info.account || info.destination || info.source || null;
              if (typeof cand === 'string' && cand.length >= 32 && cand.length <= 44) return { mint: cand, eventType: 'parsed_instruction', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
              if (info.postTokenBalances && Array.isArray(info.postTokenBalances)) {
                for (const b of info.postTokenBalances) {
                  if (b && typeof b.mint === 'string' && b.mint.length >= 32 && b.mint.length <= 44) return { mint: b.mint, eventType: 'postTokenBalance', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
                }
              }
            }
          }
          // scan accounts field
          if (ins.accounts && Array.isArray(ins.accounts)) {
            for (const a of ins.accounts) {
              if (typeof a === 'string' && a.length >= 32 && a.length <= 44) {
                return { mint: a, eventType: 'account_ref', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  // Fallback: perform a restricted recursive search for base58-like substrings but only
  // accept them when they appear inside account lists, postTokenBalances, instruction accounts
  // or when a nearby log/message explicitly references 'mint' (reduces false positives).
  const found: { mint?: string, candidate?: string, context?: string } = {};
  function walk(o: any, depth = 0, parentKey?: string) {
    if (!o || depth > 10) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1, parentKey));
    if (typeof o === 'object') {
      for (const k of Object.keys(o)) {
        try {
          const v2 = o[k];
          if ((k === 'mint' || k === 'token' || k === 'mintAddress' || k === 'account' || k === 'accounts') && typeof v2 === 'string' && v2.length >= 32 && v2.length <= 44) {
            // ignore known program IDs and common system/program accounts
            const lower = v2.toLowerCase();
            const deny = new Set(['11111111111111111111111111111111','tokenkegqfezyinwajbnbgkpfxcwubvf9ss623vq5da','memosq4gqabaxkb96qnh8tysncwxmywcqxgdlgmfchr','metaqbxxuerdq28cj1rbawkyqm3ybzjb6a8bt518x1s','so11111111111111111111111111111111111111112']);
            if (!HELIUS_KNOWN_PROGRAM_IDS.has(v2) && !deny.has(lower)) found.mint = v2;
          }
          if (Array.isArray(v2) && (k === 'accounts' || k === 'accountKeys')) {
            for (const a of v2) {
              try {
                const lower = (typeof a === 'string' ? a.toLowerCase() : '');
                const deny = new Set(['11111111111111111111111111111111','tokenkegqfezyinwajbnbgkpfxcwubvf9ss623vq5da','memosq4gqabaxkb96qnh8tysncwxmywcqxgdlgmfchr','metaqbxxuerdq28cj1rbawkyqm3ybzjb6a8bt518x1s','so11111111111111111111111111111111111111112']);
                if (typeof a === 'string' && a.length >= 32 && a.length <= 44 && !HELIUS_KNOWN_PROGRAM_IDS.has(a) && !deny.has(lower)) {
                  // only set as candidate (not immediate mint) — require corroboration elsewhere
                  found.candidate = found.candidate || a;
                }
              } catch (e) {}
            }
          }
          // inspect postTokenBalances explicitly
          if (k === 'postTokenBalances' && Array.isArray(v2)) {
            for (const b of v2) { try { if (b && typeof b.mint === 'string' && b.mint.length >= 32 && b.mint.length <= 44 && !HELIUS_KNOWN_PROGRAM_IDS.has(b.mint)) { found.mint = b.mint; found.context = 'postTokenBalances'; } } catch (e) {} }
          }
          // logs / messages nearby mentioning 'mint' increase confidence
          if (typeof v2 === 'string') {
            const m = v2.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
            if (m && m.length) {
              const lower = (parentKey || k || '').toLowerCase();
              const cand = m[0];
              const deny = new Set(['11111111111111111111111111111111','tokenkegqfezyinwajbnbgkpfxcwubvf9ss623vq5da','memosq4gqabaxkb96qnh8tysncwxmywcqxgdlgmfchr','metaqbxxuerdq28cj1rbawkyqm3ybzjb6a8bt518x1s','so11111111111111111111111111111111111111112']);
              if (deny.has(cand.toLowerCase())) continue;
              if (lower.includes('log') || lower.includes('message') || v2.toLowerCase().includes('mint')) {
                if (!HELIUS_KNOWN_PROGRAM_IDS.has(cand)) { found.mint = found.mint || cand; found.context = 'log'; }
              } else {
                // keep as candidate but only accept later if we see corroborating context
                if (!HELIUS_KNOWN_PROGRAM_IDS.has(cand)) found.candidate = found.candidate || cand;
              }
            }
          }
          walk(v2, depth + 1, k);
        } catch (e) {}
      }
    } else if (typeof o === 'string') {
      const m = o.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
      if (m && m.length) {
        const cand = m[0]; if (!HELIUS_KNOWN_PROGRAM_IDS.has(cand)) found.candidate = found.candidate || cand;
      }
    }
  }
  walk(obj);
  // Only accept fallback candidate if we have a mint from explicit contexts or candidate plus corroborating account lists
  const mint = found.mint || ((found.candidate && (obj?.transaction?.message?.accountKeys || obj?.params?.result?.value?.meta?.postTokenBalances)) ? found.candidate : null) || null;
  if (!mint) return null;
  return { mint, eventType: 'fallback_recursive', detectedAt: new Date().toISOString(), detectedAtSec: Math.floor(Date.now()/1000), firstSlot: slotFromCtx ?? null, raw: parsed };
}

// Compute a simple confidence score (0..1) for an analyzed event.
// Heuristics:
// - metadata_or_initialize -> 1.0
// - inner_parsed / parsed_instruction / postTokenBalance -> 0.94
// - label -> 0.65
// - memo -> 0.05 (very noisy unless corroborated)
// - fallback_recursive -> 0.01 (only as last resort)
function computeEventConfidence(evt: any, raw: any) {
  try {
    if (!evt || typeof evt !== 'object') return 0;
    const t = evt.eventType || '';
  if (t === 'metadata_or_initialize') return 1.0;
  if (t === 'inner_parsed' || t === 'parsed_instruction' || t === 'postTokenBalance') return 0.94;
  // Labels require corroborating on-chain evidence to be trusted; score moderate
  if (t === 'label') return 0.65;
  // Memos are noisy; under conservative policy treat them as effectively zero base trust.
  if (t === 'memo') return 0.0;
  if (t === 'fallback_recursive') return 0.01;
    // bonus if parsed.transaction contains innerInstructions with mint-like fields
    try {
      const res = raw?.params?.result || raw?.result || raw;
      const v = res?.value || res;
      if (v && v.meta && Array.isArray(v.meta.innerInstructions)) return 0.9;
    } catch (e) {}
    return 0.08;
  } catch (e) { return 0; }
}

// Inspect parsed transaction payload to decide whether the transaction
// actually contains token-related actions for the candidate mint.
// This avoids relying on static address lists; decisions are based on
// transaction content (logs, instructions, postTokenBalances, tokenTransfers).
function isLikelyTokenByTx(parsed: any, evt: any) {
  try {
    if (!parsed || !evt) return false;
    const res = parsed.params?.result || parsed.result || parsed;
    const v = res?.value || res;

    // 1) postTokenBalances or pre/post balances showing the mint
    try {
      const post = v?.meta?.postTokenBalances || v?.meta?.postTokenBalances;
      if (Array.isArray(post) && post.length) {
        for (const b of post) {
          try { if (b && b.mint && String(b.mint) === String(evt.mint)) return true; } catch (e) {}
        }
      }
    } catch (e) {}

    // 2) explicit tokenTransfers/nativeTransfers arrays (Helius parse-history)
    try {
      const tts = v?.tokenTransfers || v?.meta?.tokenTransfers || null;
      if (Array.isArray(tts) && tts.length) {
        for (const tt of tts) {
          try {
            if (!tt) continue;
            if (tt.mint && String(tt.mint) === String(evt.mint)) {
              // any non-zero transfer indicates activity
              const amt = Number(tt.amount ?? tt.tokenAmount ?? tt.uiAmount ?? 0) || 0;
              if (amt > 0) return true;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // 3) innerInstructions / parsed instructions looking for initializeMint / mintTo / transfer
    try {
      const inner = v?.meta?.innerInstructions || null;
      if (Array.isArray(inner) && inner.length) {
        for (const block of inner) {
          if (!block || !Array.isArray(block.instructions)) continue;
          for (const ins of block.instructions) {
            try {
              if (ins.parsed && typeof ins.parsed === 'object') {
                const info = ins.parsed.info || ins.parsed;
                const rawType = (ins.parsed.type || '').toString().toLowerCase();
                if (/initializemint|mintto|transfer|create_metadata|create_metadata_account/.test(rawType)) return true;
                if (info && info.mint && String(info.mint) === String(evt.mint)) return true;
                if (info && info.postTokenBalances && Array.isArray(info.postTokenBalances)) {
                  for (const b of info.postTokenBalances) { try { if (b && b.mint && String(b.mint) === String(evt.mint)) return true; } catch (e) {} }
                }
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}

    // 4) top-level transaction.message.instructions parsed forms
    try {
      const instrs = v?.transaction?.message?.instructions || null;
      if (Array.isArray(instrs) && instrs.length) {
        for (const ins of instrs) {
          try {
            if (ins.parsed && typeof ins.parsed === 'object') {
              const info = ins.parsed.info || ins.parsed;
              const rawType = (ins.parsed.type || '').toString().toLowerCase();
              if (/initializemint|mintto|transfer|create_metadata|create_metadata_account/.test(rawType)) return true;
              if (info && info.mint && String(info.mint) === String(evt.mint)) return true;
            }
            // accounts list may contain the mint
            if (ins.accounts && Array.isArray(ins.accounts)) {
              for (const a of ins.accounts) { try { if (a && String(a) === String(evt.mint)) return true; } catch (e) {} }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // 5) logs containing create_metadata / initialize_mint or explicit mint mention
    try {
      const logs = [] as string[];
      if (Array.isArray(v?.logs)) logs.push(...v.logs.filter((x:any)=>typeof x==='string'));
      if (Array.isArray(v?.meta?.logMessages)) logs.push(...v.meta.logMessages.filter((x:any)=>typeof x==='string'));
      for (const ln of logs) {
        try {
          const low = (ln || '').toLowerCase();
          if (low.includes('create_metadata') || low.includes('initialize_mint') || low.includes('mint_to') || low.includes('create_metadata_account')) return true;
          // if log contains mint address specifically
          const m = (ln || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
          if (m && m.length && m[0] === String(evt.mint)) return true;
        } catch (e) {}
      }
    } catch (e) {}

    return false;
  } catch (e) { return false; }
}

// Helper to expose recent events without keeping the instance around
let _lastInstance: any = null;
function saveLastInstance(inst: any) { _lastInstance = inst; }
function getRecentHeliusEvents() { try { return _lastInstance ? _lastInstance.getRecentEvents() : []; } catch { return []; } }
export { getRecentHeliusEvents, saveLastInstance };

// If run directly, start and subscribe to generic notifications and exit on SIGINT
if (require.main === module) {
  (async () => {
    const instance = await startHeliusWebsocketListener({
      onOpen: () => console.log('Listener started (direct run)'),
  onMessage: (m) => { try { const s = typeof m === 'string' ? m.slice(0,120) : JSON.stringify(m || '').slice(0,120); console.log('WS message sample:', s); } catch (e) { console.log('WS message sample: <unserializable>'); } },
      onClose: () => process.exit(0),
      onError: (e) => {
        console.error('WS error (direct run):', e?.message || e);
        process.exit(1);
      },
    });

    process.on('SIGINT', async () => {
      console.log('Stopping Helius WS listener...');
      await instance.stop();
      process.exit(0);
    });
  })();
}
