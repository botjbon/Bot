#!/usr/bin/env node
// @ts-nocheck
require('dotenv').config();
/** @type {any} */
const axios = require('axios');

// Helius RPC configuration: support rotating API keys and RPC URLs to reduce pressure
// Provide comma-separated lists in env: HELIUS_API_KEYS and HELIUS_RPC_URLS
const _HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.HELIUS_RPC || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
// Fallback to single default when none provided
if(_HELIUS_KEYS.length===0){ const k = process.env.HELIUS_API_KEY || ''; if(k) _HELIUS_KEYS.push(k); }
if(HELIUS_RPC_URLS.length===0){ HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/'); }
// internal counter for round-robin
let heliusCallCounter = 0;
// Basic validation: detect obvious placeholder keys/urls to help debugging when no mints appear
function looksLikePlaceholderKey(k){ if(!k) return true; const up = String(k).toUpperCase(); if(up.includes('KEY1')||up.includes('KEY2')||up.includes('KEY')||up.includes('XXX')||up.includes('PLACEHOLDER')) return true; return false; }
function looksLikeUrl(u){ try{ return String(u).toLowerCase().startsWith('http'); }catch(e){ return false; } }
const badKeys = _HELIUS_KEYS.filter(looksLikePlaceholderKey);
const badUrls = HELIUS_RPC_URLS.filter(u => !looksLikeUrl(u));
if(badKeys.length > 0 || badUrls.length > 0){
  console.error('Helius configuration validation failed: please set real API keys and valid RPC URLs via environment variables.');
  if(badKeys.length>0) console.error('  Detected placeholder-ish HELIUS_API_KEYS:', JSON.stringify(_HELIUS_KEYS));
  if(badUrls.length>0) console.error('  Detected invalid HELIUS_RPC_URLS:', JSON.stringify(HELIUS_RPC_URLS));
  console.error('Example (bash):');
  console.error('  HELIUS_API_KEYS="yourKey1,yourKey2" HELIUS_RPC_URLS="https://mainnet.helius-rpc.com/,https://rpc2.example/" node scripts/sequential_10s_per_program.js');
  // fail fast so user notices configuration issue instead of silent RPC errors
  process.exit(1);
}
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
// EventEmitter for in-process notification handling
const notifier = new EventEmitter();
// export notifier when required as a module
try{ module.exports = module.exports || {}; module.exports.notifier = notifier; }catch(e){}
try{ module.exports = module.exports || {}; module.exports.LATEST_COLLECTED_OBJ = LATEST_COLLECTED_OBJ; }catch(e){}
// in-memory per-user notification queues (temporary background memory)
try{ if(!global.__inMemoryNotifQueues) global.__inMemoryNotifQueues = new Map(); }catch(e){}
const INMEM_NOTIF_MAX = Number(process.env.NOTIF_INMEM_MAX || 50);
// optional helper: attempt to require message builder
let _tokenUtils = null;
try{ _tokenUtils = require('../src/utils/tokenUtils'); }catch(e){}
// Minimal output mode: when true, suppress noisy logs and only print the compact
// token array and the JSON payload per discovery. Controlled via env var.
let MINIMAL_OUTPUT = String(process.env.LISTENER_MINIMAL_OUTPUT || '').toLowerCase() === 'true';
// When true: only print explicit-created mints (those with clear Initialize/Create markers)
// Make mutable so callers can override at runtime via startSequentialListener(options)
// Explicit-only mode MUST be enforced for all downstream consumers. Do not allow
// runtime overrides; always treat collector output as explicit-created only.
const ONLY_PRINT_EXPLICIT = true;

// Save original console methods and optionally mute global logging when in explicit/minimal mode.
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn = console.warn.bind(console);
// When explicit-only or minimal output requested, mute console.* globally to suppress noise
if (ONLY_PRINT_EXPLICIT || MINIMAL_OUTPUT) {
  console.log = (..._args) => {};
  console.error = (..._args) => {};
  console.warn = (..._args) => {};
}

// Helper to emit exactly the two-line canonical output: first an array of mints, then a JSON metadata object.
function emitCanonicalLines(arr, metadata) {
  try {
    // Use the original logger to bypass global suppression
    _origLog(JSON.stringify(arr));
    _origLog(JSON.stringify(metadata));
  } catch (e) {
    try { _origLog(JSON.stringify(arr)); } catch (_) {}
    try { _origLog(JSON.stringify(metadata)); } catch (_) {}
  }
}

const PROGRAMS = [
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp',
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
];

// RULES: per-program allowed transaction kinds. This map controls which transaction kinds
// are normally processed for each program during the sequential listener.
// To avoid missing any real mint launches we define a small set of kinds that must
// always be processed regardless of the per-program rule. This allows us to be
// conservative (filter noisy swaps) while never skipping explicit mint initializations.
const RULES = {
  // Make default inclusive: capture explicit initializes and swap events to avoid missing real launches
  default: { allow: ['initialize','pool_creation','swap'] },
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': { allow: ['initialize'] },
  // Token program: allow initialize so we detect mint initializations routed through Tokenkeg
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': { allow: ['initialize'] },
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': { allow: ['pool_creation','swap'] },
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': { allow: ['pool_creation','swap'] },
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': { allow: ['pool_creation','swap'] },
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': { allow: ['swap'] },
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': { allow: ['swap'] },
  '11111111111111111111111111111111': { allow: ['swap'] },
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin': { allow: ['pool_creation','initialize','swap'] },
  // If a program had an empty allow list previously we now include initialize to avoid skipping real mint events
  '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp': { allow: ['initialize'] },
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu': { allow: ['swap'] }
};

// Kinds that should always be processed to avoid dropping real mint launches.
const ALWAYS_PROCESS_KINDS = new Set(['initialize']);

const DENY = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB','So11111111111111111111111111111111111111112','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);

// Configurable timings (ms) via environment variables
// Reduce per-program window to cycle faster and improve chance of catching very-new mints
const PER_PROGRAM_DURATION_MS = Number(process.env.PER_PROGRAM_DURATION_MS) || 8000;
const INNER_SLEEP_MS = Number(process.env.INNER_SLEEP_MS) || 120;
// poll sleep controls delay between quick retries; lower value = more responsiveness (more RPCs)
const POLL_SLEEP_MS = Number(process.env.POLL_SLEEP_MS) || 250;
const CYCLE_SLEEP_MS = Number(process.env.CYCLE_SLEEP_MS) || 1500;
// Increase batch scanning to examine more recent signatures in a single RPC
const SIG_BATCH_LIMIT = Number(process.env.SIG_BATCH_LIMIT) || 48;
// reduce historical signature window to reduce probe cost and favor very recent first-sig checks
const MINT_SIG_LIMIT = Number(process.env.MINT_SIG_LIMIT) || 12;
// Freshness and first-signature matching configuration
// Proposal 1: widen default window slightly to capture marginally delayed mints
// default max mint age (seconds) when not provided via env
const MAX_MINT_AGE_SECS = Number(process.env.MAX_MINT_AGE_SECS) || 3; // seconds
// Collector: allow accumulating a small number of freshly-accepted mints and
// printing them as a single JSON array. Useful for short-lived runs/testing.
const COLLECT_MAX = Number(process.env.COLLECT_MAX) || 10;
const EXIT_ON_COLLECT = (process.env.EXIT_ON_COLLECT === 'false') ? false : true;
const LATEST_COLLECTED = [];
// Keep a parallel recent detailed snapshot of collected token objects (preserves createdHere, collectedAtMs, etc.)
const LATEST_COLLECTED_OBJ = [];
// Optional Redis publishing so other processes (bots) can consult the latest collector snapshot
const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_URI || null;
let _redisClient = null;
if(REDIS_URL){
  try{
    const { createClient } = require('redis');
    _redisClient = createClient({ url: REDIS_URL });
    _redisClient.on && _redisClient.on('error', ()=>{});
    // connect but don't await to avoid blocking startup; errors are swallowed
    _redisClient.connect().catch(()=>{});
  }catch(e){ _redisClient = null; }
}
function publishLatestCollectedSnapshot(){
  try{
    if(!_redisClient) return;
    const key = process.env.LATEST_COLLECTED_REDIS_KEY || 'listener:latest_collected_obj';
    const ttl = Number(process.env.LATEST_COLLECTED_REDIS_TTL || 60);
    const payload = JSON.stringify(LATEST_COLLECTED_OBJ.slice(0, COLLECT_MAX));
    // set with expiry so stale processes don't hold on to old snapshots
    _redisClient.set(key, payload, { EX: ttl }).catch(()=>{});
  }catch(e){}
}
// Capture-only mode: when true the listener writes a minimal capture JSON to disk
// and skips per-user enrichment/strategy analysis (reduces latency to print/save).
const CAPTURE_ONLY = (process.env.CAPTURE_ONLY === 'true');
// TTL for caching first-signature probes (ms). Configurable via env, with a dynamic
// adjustment when upstream rate-limits increase to reduce probe pressure.
// Lower default so we re-probe more frequently for fresh mints during fast testing
const FIRST_SIG_TTL_MS = Number(process.env.FIRST_SIG_TTL_MS) || 8000;
let _lastFirstSigCleanup = 0;
function computeFirstSigTTL(){
  try{
    const base = Number(process.env.FIRST_SIG_TTL_MS) || FIRST_SIG_TTL_MS;
    // If we observe 429s, increase TTL to reduce probe frequency (capped multiplier)
    const rateHits = Math.min(RPC_STATS.rateLimit429 || 0, 5);
    const multiplier = 1 + (rateHits * 0.5); // each 429 increases TTL by 50%, up to 5 hits
    return Math.max(1000, Math.floor(base * multiplier));
  }catch(e){ return FIRST_SIG_TTL_MS; }
}
const FIRST_SIG_MATCH_WINDOW_SECS = Number(process.env.FIRST_SIG_MATCH_WINDOW_SECS) || 6; // allowed delta between firstSig.blockTime and tx.blockTime
const FIRST_SIG_CACHE = new Map(); // mint -> { sig, blockTime, ts }
// Window (seconds) after collection during which enrichment is allowed. Set to 2s per request.
const ENRICH_WINDOW_SEC = Number(process.env.ENRICH_WINDOW_SEC || 2);

// Global listener strict acceptance threshold (seconds). When set, only accept
// a candidate mint when its first-signature equals the current tx sig AND
// the canonical age is <= this threshold. Default 16 seconds (tweakable via env).
const GLOBAL_MAX_ACCEPT_AGE_SEC = Number(process.env.GLOBAL_MAX_ACCEPT_AGE_SEC || 16);

async function getFirstSignatureCached(mint){
  if(!mint) return null;
  try{
    const now = Date.now();
    const ttl = computeFirstSigTTL();
    const cached = FIRST_SIG_CACHE.get(mint);
    if(cached && (now - cached.ts) < ttl) return { sig: cached.sig, blockTime: cached.blockTime };
    // occasional cleanup of stale cache entries to avoid unbounded growth
    try{
      if(now - _lastFirstSigCleanup > 60000){
        _lastFirstSigCleanup = now;
        for(const [k,v] of FIRST_SIG_CACHE.entries()){
          if(!v || !v.ts || (now - v.ts) > (ttl * 3)) FIRST_SIG_CACHE.delete(k);
        }
      }
    }catch(e){}
    // attempt a single lightweight probe (keep retries minimal to avoid rate limit)
    try{
      const res = await heliusRpc('getSignaturesForAddress', [mint, { limit: 1 }]);
      if(Array.isArray(res) && res.length>0){
        const entry = res[0];
        const s = getSig(entry);
        const bt = entry.blockTime || entry.block_time || entry.blocktime || null;
        FIRST_SIG_CACHE.set(mint, { sig: s || null, blockTime: bt || null, ts: Date.now() });
        return { sig: s || null, blockTime: bt || null };
      }
      FIRST_SIG_CACHE.set(mint, { sig: null, blockTime: null, ts: Date.now() });
      return null;
    }catch(e){
      // cache negative briefly to avoid hammering
      FIRST_SIG_CACHE.set(mint, { sig: null, blockTime: null, ts: Date.now() });
      return null;
    }
  }catch(e){ return null; }
}

// Simple RPC statistics for diagnostics
const RPC_STATS = { calls: 0, errors: 0, rateLimit429: 0, totalLatencyMs: 0 };

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// heliusRpc(method, params, useEnrich=false)
// when useEnrich=true the call uses the second Helius key / URL for enrichment work
async function heliusRpc(method, params){
  // lightweight retry/backoff with jitter for transient failures (including 429)
  const maxRetries = Number(process.env.HELIUS_RPC_MAX_RETRIES || 2);
  for(let attempt=0; attempt<=maxRetries; attempt++){
    RPC_STATS.calls++;
    const start = Date.now();
    try{
      const keyIdx = heliusCallCounter % Math.max(1, _HELIUS_KEYS.length);
      const urlIdx = heliusCallCounter % Math.max(1, HELIUS_RPC_URLS.length);
      heliusCallCounter = (heliusCallCounter + 1) >>> 0;
      const url = HELIUS_RPC_URLS[urlIdx];
      const hdrs = Object.assign({ 'Content-Type': 'application/json' }, _HELIUS_KEYS[keyIdx] ? { 'x-api-key': _HELIUS_KEYS[keyIdx] } : {});
      // make helius timeout configurable (default 5000ms) to favor low-latency responses
      const heliusTimeout = Number(process.env.HELIUS_RPC_TIMEOUT_MS) || 5000;
      const res = await axios.post(url, { jsonrpc:'2.0', id:1, method, params }, { headers: hdrs, timeout: heliusTimeout });
      const latency = Date.now() - start; RPC_STATS.totalLatencyMs += latency;
      if(res && res.status === 429) RPC_STATS.rateLimit429++;
      return res.data && (res.data.result || res.data);
    }catch(e){
      const status = e.response && e.response.status;
      if(status === 429) RPC_STATS.rateLimit429++;
      RPC_STATS.errors++;
      // retry on 429 or network errors, otherwise return immediately
      if(attempt < maxRetries && (status === 429 || !status)){
        const base = Number(process.env.HELIUS_RPC_RETRY_BASE_MS) || 150;
        const backoff = base * Math.pow(2, attempt);
        // add jitter
        const jitter = Math.floor(Math.random() * Math.min(100, backoff));
        await sleep(backoff + jitter);
        continue;
      }
      return { __error: (e.response && e.response.statusText) || e.message, status };
    }
  }
}

// Common helius getTransaction options
const HELIUS_TX_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 };

// Concurrency and retry tuning for getTransaction calls
// Increase default concurrency to speed fetching many txs in parallel (tune to your key limits)
const TX_CONCURRENCY = Number(process.env.TX_CONCURRENCY) || 8;
const MAX_TX_RETRIES = Number(process.env.MAX_TX_RETRIES) || 3;
const TX_RETRY_BASE_MS = Number(process.env.TX_RETRY_BASE_MS) || 150;

// simple semaphore for limiting concurrent getTransaction calls
let txActive = 0;
const txQueue = [];
function _acquireTxSlot(){
  if(txActive < TX_CONCURRENCY){ txActive++; return Promise.resolve(); }
  return new Promise(resolve=> txQueue.push(resolve));
}
function _releaseTxSlot(){
  txActive = Math.max(0, txActive-1);
  const next = txQueue.shift(); if(next) { txActive++; next(); }
}

// fetchTransaction: uses heliusRpc under the hood but adds concurrency limiting and retries/backoff
async function fetchTransaction(sig){
  await _acquireTxSlot();
  try{
    for(let attempt=0; attempt<=MAX_TX_RETRIES; attempt++){
      const res = await heliusRpc('getTransaction', [sig, HELIUS_TX_OPTS]);
      // heliusRpc returns an object with __error on failure
      if(res && res.__error){
        const status = res.status || null;
        // if rate-limited or transient, retry with backoff
        if(attempt < MAX_TX_RETRIES){
          const backoff = TX_RETRY_BASE_MS * Math.pow(2, attempt);
          await sleep(backoff);
          continue;
        }
        return res; // last attempt, return error object
      }
      return res; // success
    }
  }finally{ _releaseTxSlot(); }
}

// Utility: normalize signature field from different shapes
function getSig(entry){
  if(!entry) return null;
  return entry.signature || entry.txHash || entry.sig || entry.txhash || null;
}

// Utility: safely join tx log messages to a lowercase string
function joinTxLogs(tx){
  try{
    const logs = (tx && tx.meta && Array.isArray(tx.meta.logMessages)) ? tx.meta.logMessages : [];
    return logs.join('\n').toLowerCase();
  }catch(e){ return ''; }
}

// Helper: compute canonical age in seconds for a mint using firstBlockTime if available,
// otherwise fall back to transaction block time. Returns null when neither is present.
function getCanonicalAgeSeconds(firstBlockTime, txBlockTime){
  try{
  const now = Date.now();
  // Normalize inputs: block times may be in seconds (most cases) or already ms
  const fb = firstBlockTime ? Number(firstBlockTime) : null;
  const tb = txBlockTime ? Number(txBlockTime) : null;
  // Convert seconds to ms when values look like epoch seconds (reasonable threshold)
  const toMs = v => (v && v < 1e12) ? v * 1000 : v;
  const fbMs = fb ? toMs(fb) : null;
  const tbMs = tb ? toMs(tb) : null;
  const useMs = (fbMs && tbMs) ? Math.max(fbMs, tbMs) : (fbMs || tbMs || null);
  if(useMs) return (now - useMs) / 1000;
  }catch(e){}
  return null;
}

function extractMints(tx){
  const s = new Set();
  try{
    const meta = tx && (tx.meta || (tx.transaction && tx.meta)) || {};
    const arr = [].concat(meta.preTokenBalances||[], meta.postTokenBalances||[]);
    for(const b of arr) if(b && b.mint) s.add(b.mint);
    const inner = meta.innerInstructions || [];
    for(const block of inner){
      const instrs = block && block.instructions || [];
      for(const ins of instrs){
        try{
          const pt = ins && ins.parsed && ins.parsed.info && (ins.parsed.info.mint || ins.parsed.info.postTokenBalances);
          if(pt){ if(Array.isArray(pt)) for(const x of pt) if(x && x.mint) s.add(x.mint); else if(pt) s.add(pt); }
        }catch(e){}
      }
    }
  }catch(e){}
  return Array.from(s);
}

function txKindExplicit(tx){
  try{
    const meta = tx && (tx.meta || (tx.transaction && tx.meta)) || {};
    const logs = Array.isArray(meta.logMessages)? meta.logMessages.join('\n').toLowerCase() : '';
    if(logs.includes('instruction: initializemint') || logs.includes('initialize mint') || logs.includes('instruction: initialize_mint')) return 'initialize';
    if(logs.includes('createpool') || logs.includes('initializepool') || logs.includes('create pool')) return 'pool_creation';
    if(logs.includes('instruction: swap') || logs.includes('\nprogram log: instruction: swap') || logs.includes(' swap ')) return 'swap';
    const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
    const instrs = (msg && msg.instructions) || [];
    for(const ins of instrs){
      try{ const t = (ins.parsed && ins.parsed.type) || (ins.type || ''); if(!t) continue; const lt = String(t).toLowerCase(); if(lt.includes('initializemint')||lt.includes('initialize_mint')||lt.includes('initialize mint')) return 'initialize'; if(lt.includes('createpool')||lt.includes('initializepool')||lt.includes('create pool')) return 'pool_creation'; if(lt.includes('swap')) return 'swap'; }catch(e){}
    }
  }catch(e){}
  return null;
}

// Heuristic: confirm that a mint was created/initialized in this transaction
function isMintCreatedInThisTx(tx, mint){
  try{
    if(!tx) return false;
    const logs = joinTxLogs(tx);
    const m = String(mint).toLowerCase();
    // Strict detection: require BOTH a log marker indicating a create/initialize
    // AND a parsed instruction that references the mint address (info.mint or info.newAccount).
    // This avoids treating swap/pool logs or incidental mentions as explicit mint creations.
    const hasLogMarker = !!(logs && logs.match(/initializemint|initialize mint|initialize_mint|createidempotent|instruction:\s*create/));
    // inspect parsed instructions for explicit mint/newAccount references
    let parsedMatches = false;
    const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
    const instrs = (msg && msg.instructions) || [];
    for(const ins of instrs){
      try{
        const t = (ins.parsed && ins.parsed.type) || (ins.type || '');
        if(t && String(t).toLowerCase().includes('initializemint')) parsedMatches = true;
        const info = ins.parsed && ins.parsed.info;
        if(info){
          if(info.mint && String(info.mint).toLowerCase() === m) parsedMatches = true;
          if(info.newAccount && String(info.newAccount).toLowerCase() === m) parsedMatches = true;
        }
      }catch(e){}
    }
    // require both a parsed reference and a log marker to qualify as an explicit creation
    return parsedMatches && hasLogMarker;
  }catch(e){}
  return false;
}

async function mintPreviouslySeen(mint, txBlockTime, currentSig){
  if(!mint) return true;
  try{
    // reduced limit to lower RPC cost; configurable via MINT_SIG_LIMIT
    const sigs = await heliusRpc('getSignaturesForAddress', [mint, { limit: MINT_SIG_LIMIT }]);
    if(!Array.isArray(sigs) || sigs.length===0) return false;
    // Normalize block times to milliseconds for safe comparison
    const txBlockMs = (txBlockTime && Number(txBlockTime) > 1e12) ? Number(txBlockTime) : ((txBlockTime && Number(txBlockTime) > 1e9) ? Number(txBlockTime) * 1000 : (txBlockTime ? Number(txBlockTime) : null));
    for(const s of sigs){
      try{
        const sig = getSig(s);
        const rawBt = s.blockTime||s.block_time||s.blocktime||null;
        const btMs = (rawBt && Number(rawBt) > 1e12) ? Number(rawBt) : ((rawBt && Number(rawBt) > 1e9) ? Number(rawBt) * 1000 : (rawBt ? Number(rawBt) : null));
        if(sig && sig!==currentSig && btMs && txBlockMs && btMs < txBlockMs) return true;
      }catch(e){}
    }
    return false;
  }catch(e){ return true; }
}

// Centralized freshness check used by listener and collector.
// Ensures: (1) canonical age is available and <= GLOBAL_MAX_ACCEPT_AGE_SEC,
// (2) first-signature semantics for swaps/initializes and not previously seen,
// (3) when necessary, verifies creation-in-this-tx.
async function isMintFresh(mint, tx, txBlockTime, currentSig, kind, maxAcceptAgeSec, ageOnly){
  try{
    if(!mint) return false;
    // compute canonical age using cached firstSig when possible
    const getter = (module.exports && module.exports.getFirstSignatureCached) ? module.exports.getFirstSignatureCached : getFirstSignatureCached;
    const prevChecker = (module.exports && module.exports.mintPreviouslySeen) ? module.exports.mintPreviouslySeen : mintPreviouslySeen;
    const first = await getter(mint).catch(()=>null);
    const ft = first && first.blockTime ? first.blockTime : null;
    const ageSec = getCanonicalAgeSeconds(ft, txBlockTime);
    if(ageSec === null) return false;
    const threshold = (maxAcceptAgeSec !== undefined && maxAcceptAgeSec !== null) ? Number(maxAcceptAgeSec) : Number(GLOBAL_MAX_ACCEPT_AGE_SEC);
    if(ageSec > threshold) return false;

    // If caller requested age-only acceptance, skip first-sig / previously-seen / creation checks
    if(ageOnly === true){
      return true;
    }

    // initialize: fresh if not previously seen and age within threshold
    if(kind === 'initialize'){
      // require strong evidence that the mint was created in this tx
      const createdHere = isMintCreatedInThisTx(tx, mint);
      if(!createdHere) return false;
      const prev = await prevChecker(mint, txBlockTime, currentSig).catch(()=>true);
      return (prev === false);
    }

    // swap: require first-signature == currentSig and small block-time delta
    if(kind === 'swap'){
      if(!first || !first.sig) return false;
      if(first.sig !== currentSig) return false;
      if(!ft || !txBlockTime) return false;
      const delta = Math.abs(Number(ft) - Number(txBlockTime));
      if(delta > FIRST_SIG_MATCH_WINDOW_SECS) return false;
      const prev = await prevChecker(mint, txBlockTime, currentSig).catch(()=>true);
      return (prev === false);
    }

    // other kinds: accept only when tx indicates creation and not previously seen
    const createdHere = isMintCreatedInThisTx(tx, mint);
    if(createdHere){
      const prev = await prevChecker(mint, txBlockTime, currentSig).catch(()=>true);
      return (prev === false);
    }
    return false;
  }catch(e){ return false; }
}

async function startSequentialListener(options){
  // allow caller to override explicit-only behavior at runtime
  try{ if(options && typeof options.onlyPrintExplicit !== 'undefined') ONLY_PRINT_EXPLICIT = Boolean(options.onlyPrintExplicit); }catch(e){}
  if(!ONLY_PRINT_EXPLICIT) console.error('Sequential 10s per-program listener starting (daemon mode)');
  const seenMints = new Set();
  let stopped = false;
  process.on('SIGINT', () => { if(!ONLY_PRINT_EXPLICIT) console.error('SIGINT received, stopping listener...'); stopped = true; });
  // Load and cache users once; watch file for changes to avoid reading on every match
  const usersPath = path.join(process.cwd(), 'users.json');
  let users = {};
  const loadUsers = () => {
    try{ const usersRaw = fs.readFileSync(usersPath, 'utf8'); users = usersRaw ? JSON.parse(usersRaw) : {}; }catch(e){ users = {}; }
  };
  loadUsers();
  // Normalize strategy objects (ensure minAge is stored as seconds etc.)
  try{
    const normalize = require('../src/utils/strategyNormalizer').normalizeStrategy;
    for(const k of Object.keys(users || {})){
      try{ if(users[k] && users[k].strategy) users[k].strategy = normalize(users[k].strategy); }catch(e){}
    }
  }catch(e){}
  try{ fs.watchFile(usersPath, { interval: 2000 }, () => { loadUsers(); if(!ONLY_PRINT_EXPLICIT) console.error('users.json reloaded'); }); }catch(e){}
  // require strategy filter once to avoid repeated module resolution cost
  let strategyFilter = null;
  try{ strategyFilter = require('../src/bot/strategy').filterTokensByStrategy; }catch(e){ strategyFilter = null; }
  
  const TARGET_MINTS = Number(process.env.TARGET_MINTS) || 4;
  // track last signature per program to avoid reprocessing the same tx repeatedly
  const lastSigPerProgram = new Map();
  while(!stopped){
    for(const p of PROGRAMS){
      if (stopped) break;
      try{
        const rule = RULES[p] || RULES.default;
  if(!ONLY_PRINT_EXPLICIT) console.error(`[${p}] listening (10s)`);
  // use configured per-program duration so the listener respects PER_PROGRAM_DURATION_MS
  const end = Date.now() + (Number(process.env.PER_PROGRAM_DURATION_MS) || PER_PROGRAM_DURATION_MS);
        const seenTxs = new Set();
    while(Date.now()<end){
          if (stopped) break;
          try{
            // Don't skip programs that have empty allow lists; continue but ensure we don't miss explicit initialize events
            if(!rule || !Array.isArray(rule.allow)) break;
          // fetch a small batch of recent signatures to process any new ones
  const sigs = await heliusRpc('getSignaturesForAddress', [p, { limit: SIG_BATCH_LIMIT }]);
            if(!Array.isArray(sigs)||sigs.length===0){ await sleep(250); continue; }
            // process newest first
            let s = sigs[0];
            // find the first unseen signature in the batch
            for(const cand of sigs){
              const candSig = cand && (cand.signature||cand.txHash||cand.sig||cand.txhash);
              if(!candSig) continue;
              if(seenTxs.has(candSig)) continue;
              // also skip if we've already processed this program's latest sig earlier
              if(lastSigPerProgram.get(p) === candSig) { continue; }
              s = cand; break;
            }
            if(!s) { await sleep(POLL_SLEEP_MS); continue; }
            const sig = getSig(s); if(!sig) { await sleep(250); continue; }
            if(seenTxs.has(sig)) { await sleep(POLL_SLEEP_MS); continue; } seenTxs.add(sig);
            lastSigPerProgram.set(p, sig);
            const tx = await fetchTransaction(sig);
            if(!tx || tx.__error) { await sleep(POLL_SLEEP_MS); continue; }
            const kind = txKindExplicit(tx); if(!kind) { await sleep(250); continue; }
            // Always process explicit 'initialize' transactions to avoid missing real mint launches
            if(!(rule.allow.includes(kind) || kind === 'initialize')) { await sleep(250); continue; }
            const mints = extractMints(tx).filter(x=>x && !DENY.has(x)); if(mints.length===0) { await sleep(250); continue; }
            // Fast-path capture-only: write minimal capture immediately and skip enrichment/acceptance heuristics.
            if(CAPTURE_ONLY){
              try{
                const outDir = path.join(process.cwd(), 'out', 'capture_queue');
                try{ fs.mkdirSync(outDir, { recursive: true }); }catch(e){}
                const payload = { time:new Date().toISOString(), program:p, signature:sig, kind: (txKindExplicit(tx) || null), mints: mints.slice(0,10), sampleLogs:(tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
                const fileName = Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.json';
                const filePath = path.join(outDir, fileName);
                fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
                if(!ONLY_PRINT_EXPLICIT) console.error('CAPTURED', filePath);
                // update seen set and collector so consumer won't reprocess the same mints
                for(const m of mints) seenMints.add(m);
                for(const m of mints){ if(LATEST_COLLECTED.length < COLLECT_MAX && !LATEST_COLLECTED.includes(m)) LATEST_COLLECTED.push(m); }
                if(LATEST_COLLECTED.length >= COLLECT_MAX){ try{ if(!ONLY_PRINT_EXPLICIT) { console.error('COLLECTED_FINAL', JSON.stringify(LATEST_COLLECTED.slice(0, COLLECT_MAX))); console.log(JSON.stringify({ collected: LATEST_COLLECTED.slice(0, COLLECT_MAX), time: new Date().toISOString() })); if(EXIT_ON_COLLECT){ console.error('Exiting because COLLECT_MAX reached'); } } if(EXIT_ON_COLLECT){ try{ process.exit(0); }catch(e){} } }catch(e){} }
              }catch(e){}
              await sleep(120);
              continue;
            }
            const fresh = [];
            const txBlock = (s.blockTime||s.block_time||s.blocktime)||(tx&&tx.blockTime)||null;
            for(const m of mints){
              try{
                if(seenMints.has(m)) continue;
                const freshOk = await isMintFresh(m, tx, txBlock, sig, kind).catch(()=>false);
                if(freshOk) fresh.push(m);
              }catch(e){}
            }
            // Print up to 2 newest discovered fresh mints immediately to terminal with color
            // Track whether we've already emitted the canonical JSONL payload for this signature
            let __printedCanonicalPayloadForSig = false;
            try{
              if(Array.isArray(fresh) && fresh.length>0){
                  const latest = fresh.slice(0,2);
                  // If ONLY_PRINT_EXPLICIT is set, require explicit creation for printing; otherwise behave as before
                  const shouldPrintArray = !ONLY_PRINT_EXPLICIT || latest.some(m => isMintCreatedInThisTx(tx, m));
                  if(shouldPrintArray){
                    // Build canonical metadata object matching the requested shape
                    const metadata = { time:new Date().toISOString(), program: p, signature: sig, kind: kind, freshMints: latest.slice(0, Math.max(0, latest.length)), sampleLogs: (tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
                    try{
                      // Emit exactly the two canonical JSON lines via helper
                      emitCanonicalLines(latest, metadata);
                      __printedCanonicalPayloadForSig = true;
                    }catch(e){
                      try{ emitCanonicalLines(latest, metadata); }catch(_){ }
                      __printedCanonicalPayloadForSig = true;
                    }
                  }
                }
            }catch(e){}
            if(fresh.length===0) { await sleep(250); continue; }
            if(kind==='swap'){
              // Tightened rule: require an explicit parsed instruction reference
              // (info.mint / info.source / info.destination) to match a fresh mint.
              try{
                const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
                const instrs = (msg && msg.instructions) || [];
                let referencesFresh = false;
                for(const ins of instrs){
                  try{
                    const info = ins.parsed && ins.parsed.info;
                    if(info){
                      if(info.mint && fresh.includes(info.mint)) referencesFresh = true;
                      if(info.source && fresh.includes(info.source)) referencesFresh = true;
                      if(info.destination && fresh.includes(info.destination)) referencesFresh = true;
                    }
                  }catch(e){}
                }
        if(!referencesFresh){ await sleep(POLL_SLEEP_MS); continue; }
              }catch(e){}
            }
            for(const m of fresh) seenMints.add(m);
            // Emit global event for listeners (no DEX enrichment)
            const globalEvent = { time:new Date().toISOString(), program:p, signature:sig, kind: kind, freshMints:fresh.slice(0,5), sampleLogs:(tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
              // No optional raw enrichment (PRINT_RAW_FRESH removed) — keep events lightweight
              // Print full JSON payload only when we have strict explicit evidence or when not in ONLY_PRINT_EXPLICIT mode.
            try{
              // Avoid duplicate printing when we've already emitted the canonical payload above
              if(!__printedCanonicalPayloadForSig){
                const anyExplicit = Array.isArray(globalEvent.sampleLogs) && globalEvent.sampleLogs.join('\n').toLowerCase().match(/initializemint|initialize mint|initialize_mint|instruction:\s*create/);
                // Ensure parsed instruction also references the mint(s) when ONLY_PRINT_EXPLICIT is active
                let parsedRefers = false;
                if(Array.isArray(globalEvent.freshMints) && globalEvent.freshMints.length>0){
                  const txObj = tx;
                  for(const fm of globalEvent.freshMints){ if(isMintCreatedInThisTx(txObj, fm)) { parsedRefers = true; break; } }
                }
                const shouldPrintGlobal = (!ONLY_PRINT_EXPLICIT) || (anyExplicit && parsedRefers);
                if(shouldPrintGlobal){ console.log(JSON.stringify(globalEvent)); }
              }
            }catch(e){}
            // If capture-only mode is enabled, write a tiny capture file and skip enrichment
            if(CAPTURE_ONLY){
              try{
                const outDir = path.join(process.cwd(), 'out', 'capture_queue');
                try{ fs.mkdirSync(outDir, { recursive: true }); }catch(e){}
                const payload = { time:new Date().toISOString(), program:p, signature:sig, kind:kind, fresh:fresh.slice(0,10), sampleLogs:(tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
                const fileName = Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.json';
                const filePath = path.join(outDir, fileName);
                fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
                if(!ONLY_PRINT_EXPLICIT) console.error('CAPTURED', filePath);
              }catch(e){}
              // still update collector and seen set but skip heavy enrichment
              try{ for(const m of fresh) seenMints.add(m); }catch(e){}
              await sleep(120);
              continue;
            }
            // Collector: push accepted fresh mints (first up-to COLLECT_MAX unique entries)
            try{
              for(const m of fresh){
                if(LATEST_COLLECTED.length >= COLLECT_MAX) break;
                if(!LATEST_COLLECTED.includes(m)) LATEST_COLLECTED.push(m);
              }
              if(LATEST_COLLECTED.length >= COLLECT_MAX){
                try{
                  // In minimal mode avoid verbose label around collected final and only print the JSON object
                  if(MINIMAL_OUTPUT){
                    // Emit canonical two-line JSONL using helper
                    try{
                      const arr = LATEST_COLLECTED.slice(0, COLLECT_MAX);
                      emitCanonicalLines(arr, { collected: arr, time: new Date().toISOString() });
                    }catch(e){ /* suppressed */ }
                  } else {
                    if(!ONLY_PRINT_EXPLICIT) console.error('COLLECTED_FINAL', JSON.stringify(LATEST_COLLECTED.slice(0, COLLECT_MAX)));
                    if(!ONLY_PRINT_EXPLICIT) console.log(JSON.stringify({ collected: LATEST_COLLECTED.slice(0, COLLECT_MAX), time: new Date().toISOString() }));
                  }
                }catch(e){}
                if(EXIT_ON_COLLECT){
                  try{ if(!ONLY_PRINT_EXPLICIT) console.error('Exiting because COLLECT_MAX reached'); }catch(e){}
                  process.exit(0);
                }
              }
            }catch(e){}
            // emit program-level event
            try{ notifier.emit('programEvent', globalEvent); }catch(e){}
            // Also evaluate per-user strategies (if any) and emit per-user matches
            try{
              const strategyFilterLocal = strategyFilter; // cached above
              const usersLocal = users || {};
              // Build token objects from fresh mints for filtering
              // Lightweight on-chain enrichment: fetch the first signature for each mint to derive a first-tx timestamp (cheap, 1 RPC per mint)
                const candidateTokens = await Promise.all(fresh.map(async (m) => {
                const mintAddr = m;
                // basic validation: ensure this looks like a real Solana public key and not a program id or malformed string
                try{
                  const { PublicKey } = require('@solana/web3.js');
                  const pk = new PublicKey(mintAddr);
                  const normalized = pk.toBase58();
                  // reject obvious program ids or denied addresses
                  if(!normalized || DENY.has(normalized) || PROGRAMS.includes(normalized)) return null;
                }catch(e){ return null; }
                // include listener source metadata so strategy filters can preserve/inspect realtime origin
                const tok = { address: mintAddr, tokenAddress: mintAddr, mint: mintAddr, sourceProgram: p, sourceSignature: sig, sampleLogs: (tx.meta&&tx.meta.logMessages||[]).slice(0,10), sourceCandidates: true };
                try{ tok.createdHere = Boolean(isMintCreatedInThisTx(tx, mintAddr)); }catch(e){ tok.createdHere = false; }
                try{
                  // Compute a deterministic age for the token using cached first-signature probe
                  try{
                    const first = await getFirstSignatureCached(mintAddr).catch(()=>null);
                    const ft = first && first.blockTime ? first.blockTime : null;
                    if(ft){
                      // store ms epoch for downstream consumers
                      try{ tok.firstBlockTime = Number(ft) * 1000; }catch(e){}
                      try{ tok.freshnessDetails = { firstTxMs: Number(ft) * 1000 }; }catch(e){}
                      try{ tok._canonicalAgeSeconds = getCanonicalAgeSeconds(ft, txBlock); }catch(e){}
                    } else if(txBlock){
                      // fallback: use the current tx's block time to estimate age when first-sig missing
                      try{ tok.firstBlockTime = null; }catch(e){}
                      try{ tok._canonicalAgeSeconds = getCanonicalAgeSeconds(null, txBlock); }catch(e){}
                    } else {
                      try{ tok.firstBlockTime = null; }catch(e){}
                    }
                  }catch(e){}
                }catch(e){}
                return tok;
              }));
              // filter out any nulls returned by validation
              const _candidateTokens = (candidateTokens || []).filter(Boolean);
  for(const uid of Object.keys(usersLocal || {})){
                try{
          const user = usersLocal[uid];
                  if(!user || !user.strategy || user.strategy.enabled === false) continue;
          // run the filter (allow enrichment inside strategy filter for accuracy)
      if(!strategyFilterLocal) continue;
          // Per user: do NOT apply market numeric filters (liquidity/marketCap/volume).
          // The user requested that only the age threshold be used from the strategy.
          // Therefore accept the listener-provided candidateTokens and apply per-user
          // age cutoff, explicit-created filter, and per-user maxTrades later.
          let matched = Array.isArray(candidateTokens) ? candidateTokens.slice(0) : [];
          try{ if(!ONLY_PRINT_EXPLICIT) console.error(`MATCH (listener) user=${uid} matched_candidates=${matched.map(t=>t.address||t.tokenAddress||t.mint).slice(0,10)}`); }catch(e){}
                    if(Array.isArray(matched) && matched.length > 0){
                    // Per-user age cutoff: interpret user.strategy.minAge as max allowed age (seconds)
                    const userMinAgeRaw = user && user.strategy ? user.strategy.minAge : undefined;
                    const userMinAge = (userMinAgeRaw !== undefined && userMinAgeRaw !== null && !isNaN(Number(userMinAgeRaw))) ? Number(userMinAgeRaw) : null;

                    // Filter matched tokens by per-user age threshold when available
                    // Re-check freshness per-user using the centralized policy so prevSeen and first-sig
                    // semantics are re-evaluated under the user's minAge threshold.
                    let matchedFiltered = [];
                    if(userMinAge !== null){
                      const checks = await Promise.all((matched || []).map(async (tok) => {
                        try{
                          const mintAddr = tok && (tok.address||tok.tokenAddress||tok.mint);
                          const txBlockSeconds = tok && tok.firstBlockTime ? (Number(tok.firstBlockTime) / 1000) : (tok && tok.txBlock ? Number(tok.txBlock) : null);
                          const kindLocal = tok && tok.kind ? tok.kind : null;
                          const sigLocal = tok && tok.sourceSignature ? tok.sourceSignature : null;
                          const ok = await isMintFresh(mintAddr, null, txBlockSeconds, sigLocal, kindLocal, userMinAge, true).catch(()=>false);
                          return ok ? tok : null;
                        }catch(e){ return null; }
                      }));
                      matchedFiltered = (checks || []).filter(x=>x);
                    } else {
                      matchedFiltered = matched.slice(0);
                    }

                    // Enforce explicit-created only for per-user notifications: require createdHere
                    try{ matchedFiltered = (matchedFiltered || []).filter(t => t && t.createdHere === true); }catch(e){}
                    if(!Array.isArray(matchedFiltered) || matchedFiltered.length === 0) {
                      // nothing left after per-user filtering
                      continue;
                    }

                    // Apply user's maxTrades to the explicit-only list (default 3)
                    const userMaxTrades = Number(user && user.strategy && user.strategy.maxTrades ? user.strategy.maxTrades : 3) || 3;
                    const matchedFinal = (Array.isArray(matchedFiltered) ? matchedFiltered.slice(0, userMaxTrades) : []);

                    // Merge matched tokens into a single compact payload limited by userMaxTrades
                    // Prefer canonical on-chain mint/tokenAddress for exported addresses (mint first)
                    const matchAddrs = matchedFinal.map(t => (t && (t.mint || t.tokenAddress || t.address)) || null).filter(Boolean).slice(0, userMaxTrades);
                    const userEvent = { time:new Date().toISOString(), program:p, signature:sig, user: uid, matched: matchAddrs, kind: kind, candidateTokens: matchedFinal.slice(0,userMaxTrades), tokens: matchedFinal.slice(0,userMaxTrades) };
                    if(!ONLY_PRINT_EXPLICIT) console.error('MATCH', JSON.stringify(userEvent));
                    // Build a Telegram-ready payload using tokenUtils if available
                    let payload = { time: userEvent.time, program: p, signature: sig, matched: matchAddrs, tokens: userEvent.candidateTokens };
                    try{
                      // Prefer a full bulleted message (multiple tokens) when available
                      if(_tokenUtils && typeof _tokenUtils.buildBulletedMessage === 'function' && Array.isArray(userEvent.candidateTokens) && userEvent.candidateTokens.length>0){
                        try{
                          const cluster = process.env.SOLANA_CLUSTER || 'mainnet';
                          const title = `Live tokens (listener)`;
                          const { text, inline_keyboard } = _tokenUtils.buildBulletedMessage(userEvent.candidateTokens, { cluster, title, maxShow: Math.min(10, userEvent.candidateTokens.length) });
                          payload.html = text;
                          payload.inlineKeyboard = inline_keyboard;
                        }catch(e){}
                      }
                      // Fallback: single-token preview if bulleted builder not available
                      if((!payload.html || payload.html.length===0) && _tokenUtils && typeof _tokenUtils.buildTokenMessage === 'function'){
                        const firstAddr = (userEvent.candidateTokens && userEvent.candidateTokens[0]) || null;
                        if(firstAddr){
                          const tokenObj = firstAddr; // already a lightweight token object
                            const botUsername = process.env.BOT_USERNAME || 'YourBotUsername';
                            // Use canonical id for pairAddress argument: prefer mint/tokenAddress/address and DO NOT fall back to pairAddress.
                            const pairAddress = tokenObj.mint || tokenObj.tokenAddress || tokenObj.address || '';
                          try{
                            const built = _tokenUtils.buildTokenMessage(tokenObj, botUsername, pairAddress, uid);
                            if(built && built.msg){ payload.html = built.msg; payload.inlineKeyboard = built.inlineKeyboard || built.inlineKeyboard; }
                          }catch(e){}
                        }
                      }
                    }catch(e){}
                    // Push into in-memory per-user queue (temporary background store)
                    try{
                      const q = global.__inMemoryNotifQueues;
                      if(q){
                        const key = String(uid);
                        if(!q.has(key)) q.set(key, []);
                        const arr = q.get(key) || [];
                        arr.unshift(payload);
                        // trim
                        if(arr.length > INMEM_NOTIF_MAX) arr.length = INMEM_NOTIF_MAX;
                        q.set(key, arr);
                      }
                    }catch(e){}
                    // Emit in-process notification for same-process bots
                    try{ notifier.emit('notification', payload); }catch(e){}
                    // Optional: if Redis configured, LPUSH for cross-process delivery
                    try{
                      const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_URI || null;
                      if(REDIS_URL){
                        try{
                          const { createClient } = require('redis');
                          const rc = createClient({ url: REDIS_URL });
                          rc.on && rc.on('error', ()=>{});
                          await rc.connect().catch(()=>{});
                          const listKey = `listener:notifications:${uid}`;
                          await rc.lPush(listKey, JSON.stringify(payload)).catch(()=>{});
                          const maxlen = Number(process.env.NOTIF_REDIS_MAX_PER_USER || 50);
                          try{ if(maxlen>0) await rc.lTrim(listKey, 0, maxlen-1).catch(()=>{}); }catch(e){}
                          try{ await rc.disconnect().catch(()=>{}); }catch(e){}
                        }catch(e){}
                      }
                      // Optional auto-execution hook: when explicitly enabled via env var, trigger
                      // per-user auto execution (buy) for matched tokens. Disabled by default to
                      // avoid accidental trading. Set ENABLE_AUTO_EXEC_FROM_LISTENER=true to enable.
            try{
              const AUTO_EXEC_ENABLED = (process.env.ENABLE_AUTO_EXEC_FROM_LISTENER === 'true');
              const AUTO_EXEC_CONFIRM_USER_IDS = (process.env.AUTO_EXEC_CONFIRM_USER_IDS || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
              if(AUTO_EXEC_ENABLED){
                          try{
                            const shouldAuto = user && user.strategy && user.strategy.autoBuy !== false && Number(user.strategy && user.strategy.buyAmount) > 0;
                            const hasCredentials = user && (user.wallet || user.secret);
                            // require user to be explicitly confirmed in AUTO_EXEC_CONFIRM_USER_IDS
                            const userConfirmed = AUTO_EXEC_CONFIRM_USER_IDS.length === 0 ? false : AUTO_EXEC_CONFIRM_USER_IDS.includes(String(uid));
                            if(shouldAuto && hasCredentials && userConfirmed){
                              try{
                                const autoExecMod = require('../src/autoStrategyExecutor');
                                const autoExec = autoExecMod && (autoExecMod.autoExecuteStrategyForUser || autoExecMod.default || null);
                                if(typeof autoExec === 'function'){
                                  // run in background, do not block main listener loop
                                  const execTokens = Array.isArray(matched) ? matched.slice(0, Number(user.strategy && user.strategy.maxTrades ? user.strategy.maxTrades : 3) || 1) : [];
                                  (async () => {
                                    try{ await autoExec(user, execTokens, 'buy'); }catch(e){ try{ if(!ONLY_PRINT_EXPLICIT) console.error('[listener:autoExec] error', (e && e.message) || e); }catch(_){} }
                                  })();
                                }
                              }catch(e){ /* ignore auto-exec errors */ }
                            } else if(shouldAuto && hasCredentials && !userConfirmed){
                              try{ if(!ONLY_PRINT_EXPLICIT) console.error(`[listener:autoExec] user=${uid} not in AUTO_EXEC_CONFIRM_USER_IDS - skipping auto-exec`); }catch(e){}
                            }
                          }catch(e){}
                        }
                      }catch(e){}
                    }catch(e){}
                  }
                }catch(e){ /* per-user errors shouldn't break main loop */ }
              }
            }catch(e){}
          }catch(e){ }
          await sleep(120);
        }
  if(!ONLY_PRINT_EXPLICIT) console.error(`[${p}] done`);
  }catch(e){ if(!ONLY_PRINT_EXPLICIT) console.error(`[${p}] err ${String(e)}`); }
    }
    // Print RPC stats summary per full cycle
    try{
      const avg = RPC_STATS.calls ? Math.round(RPC_STATS.totalLatencyMs / RPC_STATS.calls) : 0;
  if(!ONLY_PRINT_EXPLICIT) console.error('RPC_STATS', JSON.stringify({ calls: RPC_STATS.calls, errors: RPC_STATS.errors, rateLimit429: RPC_STATS.rateLimit429, avgLatencyMs: avg }));
    }catch(e){}
    // short delay between cycles to avoid tight looping
    try { await sleep(2000); } catch (e) { }
  }
  if(!ONLY_PRINT_EXPLICIT) console.error('Sequential 10s per-program listener stopped');
}

module.exports.startSequentialListener = startSequentialListener;
// Lightweight one-shot collector: run the minimal discovery loop until we collect
// `maxCollect` fresh mints or `timeoutMs` elapses. Returns an array of mint addresses.
// Collector: try to give enough time to iterate all configured programs by default
async function collectFreshMints({ maxCollect = 3, timeoutMs = (Number(process.env.COLLECT_TIMEOUT_MS) || Math.max(20000, PER_PROGRAM_DURATION_MS * (PROGRAMS.length || 1) + 5000)), maxAgeSec = undefined, strictOverride = false, ageOnly = false, onlyPrintExplicit = undefined } = {}){
  // allow caller to request explicit-only mode for this collector run
  try{ if(typeof onlyPrintExplicit !== 'undefined') ONLY_PRINT_EXPLICIT = Boolean(onlyPrintExplicit); }catch(e){}
  // If explicit-only mode requested, force minimal output immediately to avoid
  // printing collector debug lines during discovery.
  try{ if(ONLY_PRINT_EXPLICIT) MINIMAL_OUTPUT = true; }catch(e){}
  const collected = [];
  const seenMintsLocal = new Set();
  const stopAt = Date.now() + (Number(timeoutMs) || 20000);
  try{
  for(const p of PROGRAMS){
      if(Date.now() > stopAt) break;
      try{
    const sigs = await heliusRpc('getSignaturesForAddress', [p, { limit: SIG_BATCH_LIMIT }]);
  try{ if(!MINIMAL_OUTPUT) console.error(`[LISTENER_DEBUG prog=${p}] signatures=${Array.isArray(sigs)?sigs.length:0}`); }catch(e){}
    if(!Array.isArray(sigs) || sigs.length===0) continue;
        for(const s of sigs){
          if(Date.now() > stopAt) break;
          const sig = getSig(s); if(!sig) continue;
          const tx = await fetchTransaction(sig);
          if(!tx || tx.__error) continue;
          const kind = txKindExplicit(tx); if(!kind) continue;
          const rule = RULES[p] || RULES.default;
          if(!(rule.allow.includes(kind) || kind === 'initialize')) continue;
          const mints = extractMints(tx).filter(x=>x && !DENY.has(x)); if(mints.length===0) continue;
          const txBlock = (s.blockTime||s.block_time||s.blocktime)||(tx&&tx.blockTime)||null;
            for(const m of mints){
            if(collected.length >= maxCollect) break;
            if(seenMintsLocal.has(m)) continue;
            // Determine whether this mint was explicitly created/initialized in this tx
            let createdHere = false;
            try{
              // Strict detection: rely only on isMintCreatedInThisTx (which requires parsed reference AND log marker)
              createdHere = isMintCreatedInThisTx(tx, m);
            }catch(e){ createdHere = false; }
            // When explicit-only mode is requested, skip any mint that was not created in this tx
            if(ONLY_PRINT_EXPLICIT && !createdHere) { continue; }
            // Use centralized freshness policy for collector: require isMintFresh true
            let accept = await isMintFresh(m, tx, txBlock, sig, kind, maxAgeSec, ageOnly).catch(()=>false);
            // If this mint was explicitly created in this tx, accept regardless of other freshness heuristics
            if(createdHere) accept = true;
            if(!accept){
              try{
                const firstCached = await getFirstSignatureCached(m).catch(()=>null);
                const ft = firstCached && firstCached.blockTime ? firstCached.blockTime : null;
                const ageSec = getCanonicalAgeSeconds(ft, txBlock);
                const threshold = (maxAgeSec !== undefined && maxAgeSec !== null) ? Number(maxAgeSec) : Number(GLOBAL_MAX_ACCEPT_AGE_SEC);
                let reason = 'unknown';
                if(ageSec === null) reason = 'no-age';
                else if(ageSec > threshold) reason = 'too-old';
                else {
                  // attempt to mirror swap/initialize checks
                  if(kind === 'initialize'){
                    const prev = await mintPreviouslySeen(m, txBlock, sig).catch(()=>true);
                    reason = prev ? 'previously-seen' : 'init-failed';
                  } else if(kind === 'swap'){
                    if(!firstCached || !firstCached.sig) reason = 'no-first-sig';
                    else if(firstCached.sig !== sig) reason = 'first-sig-mismatch';
                    else {
                      if(!ft || !txBlock) reason = 'no-block-times';
                      else {
                        const delta = Math.abs(Number(ft) - Number(txBlock));
                        if(delta > FIRST_SIG_MATCH_WINDOW_SECS) reason = 'blocktime-delta';
                        else {
                          const prev = await mintPreviouslySeen(m, txBlock, sig).catch(()=>true);
                          reason = prev ? 'previously-seen' : 'swap-failed';
                        }
                      }
                    }
                  }
                }
                if(!MINIMAL_OUTPUT) console.error(`COLLECT_DEBUG reject program=${p} kind=${kind} mint=${m} age=${ageSec} threshold=${threshold} reason=${reason} sig=${sig}`);
              }catch(e){ if(!MINIMAL_OUTPUT) console.error(`COLLECT_DEBUG reject program=${p} mint=${m} reason=debug-failed`); }
            }
            // If explicit-only mode is active, require mint creation markers in this tx.
            // Skip non-explicit tokens when explicit-only mode is requested.
            if(ONLY_PRINT_EXPLICIT && !createdHere) { continue; }
            if(accept){
              try{
                // compute lightweight on-chain age fields for downstream consumers
                const firstCached = await getFirstSignatureCached(m).catch(()=>null);
                const ft = firstCached && firstCached.blockTime ? firstCached.blockTime : null;
                const ageSec = getCanonicalAgeSeconds(ft, txBlock);
                if(!MINIMAL_OUTPUT) console.error(`COLLECT_DEBUG accept program=${p} kind=${kind} mint=${m} age=${ageSec} firstBlock=${ft} txBlock=${txBlock} sig=${sig}`);
                // Validate mint is a parseable PublicKey and not a known program id
                try{
                  const { PublicKey } = require('@solana/web3.js');
                  const pk = new PublicKey(m);
                  const normalized = pk.toBase58();
                  if(!normalized || DENY.has(normalized) || PROGRAMS.includes(normalized)){
                    // reject
                  } else {
                    const tok = {
                      tokenAddress: m,
                      address: m,
                      mint: m,
                      firstBlockTime: ft ? Number(ft) * 1000 : null, // ms epoch when available
                      _canonicalAgeSeconds: ageSec,
                              // timestamp when the collector observed/recorded this token (ms epoch)
                              collectedAtMs: Date.now(),
                      sourceProgram: p,
                      sourceSignature: sig,
                      kind: kind,
                      txBlock: txBlock,
                      sampleLogs: (tx.meta && tx.meta.logMessages || []).slice(0,6),
                      createdHere: Boolean(isMintCreatedInThisTx(tx, m)),
                      __listenerCollected: true,
                    };
                            // compute age since capture and whether enrichment is still allowed
                            try{ tok._ageSinceCaptureSec = (Date.now() - Number(tok.collectedAtMs)) / 1000; }catch(e){ tok._ageSinceCaptureSec = null; }
                            try{ tok.enrichAllowed = (ENRICH_WINDOW_SEC <= 0) ? true : (tok._ageSinceCaptureSec !== null && tok._ageSinceCaptureSec <= ENRICH_WINDOW_SEC); }catch(e){ tok.enrichAllowed = false; }
                    collected.push(tok);
                    seenMintsLocal.add(m);
                    try{
                      // maintain a small recent snapshot of token objects for fast access by callers
                      const exists = LATEST_COLLECTED_OBJ.find(o => (o && (o.mint || o.tokenAddress || o.address)) === m);
                      if(!exists){
                        LATEST_COLLECTED_OBJ.unshift(tok);
                        // cap snapshot length
                        if(LATEST_COLLECTED_OBJ.length > COLLECT_MAX) LATEST_COLLECTED_OBJ.length = COLLECT_MAX;
                        try{ publishLatestCollectedSnapshot(); }catch(e){}
                      }
                    }catch(e){}
                  }
                }catch(e){ /* invalid mint, skip */ }
              }catch(e){
                // fallback: still push a simple string if object creation fails
                try{ collected.push(m); seenMintsLocal.add(m); }catch(_){}
              }
            }
          }
          if(collected.length >= maxCollect) break;
        }
      }catch(e){}
      if(collected.length >= maxCollect) break;
  }
  try { const t = require('../src/utils/trace'); t.traceFlow('collector:collectFreshMints:finished',{ collectedCount: collected.length, sample: collected.slice(0,3).map(i=> (i && (i.mint||i.address||i.tokenAddress)) ) }); } catch(e){}
  }catch(e){}
  try{
    // If ONLY_PRINT_EXPLICIT is active, enforce that the collector returns only
    // tokens that were explicitly created in the discovered transaction (createdHere===true).
    if(ONLY_PRINT_EXPLICIT) {
      try{ collected = (Array.isArray(collected) ? collected.filter(c => (c && typeof c === 'object' && c.createdHere === true)) : []); }catch(e){}
    }
  }catch(e){}
  return Array.from(new Set(collected)).slice(0, maxCollect);
}
module.exports.collectFreshMints = collectFreshMints;
// Helper: collect once and return per-user merged payloads filtered by each user's strategy
async function collectFreshMintsPerUser(usersObj = {}, { maxCollect = 10, timeoutMs = (Number(process.env.COLLECT_TIMEOUT_MS) || 20000), strictOverride = false, ageOnly = false } = {}){
  // Do not pass per-user age thresholds into the centralized collector. We want
  // the collector to discover explicit-created mints first; apply per-user
  // age filters after discovery so users don't influence which mints are found.
  try{ if(ONLY_PRINT_EXPLICIT) MINIMAL_OUTPUT = true; }catch(e){}

  try{ if(!MINIMAL_OUTPUT) console.error(`[LISTENER_DEBUG] collectFreshMintsPerUser starting collector for users=${Object.keys(usersObj||{}).length}`); }catch(e){}
  try { const t = require('../src/utils/trace'); t.traceFlow('collector:collectFreshMintsPerUser:start',{ userCount: Object.keys(usersObj||{}).length, maxCollect, timeoutMs, strictOverride, ageOnly }); } catch(e){}

  // Build per-user desired counts from usersObj: prefer `strategy.requiredMints`,
  // fallback to `strategy.maxTrades`, then default to 3.
  const perUserDesired = {};
  for(const uid of Object.keys(usersObj || {})){
    try{
      const user = usersObj[uid] || {};
      const s = user.strategy || {};
      const desired = (s.requiredMints !== undefined && s.requiredMints !== null) ? Number(s.requiredMints) : ((s.maxTrades !== undefined && s.maxTrades !== null) ? Number(s.maxTrades) : 3);
      perUserDesired[String(uid)] = (isNaN(desired) || desired < 0) ? 0 : Math.max(0, Math.floor(desired));
    }catch(e){ perUserDesired[String(uid)] = 3; }
  }

  // Prepare per-user results and tracking structures
  const assigned = {}; // uid -> Map(mint -> tokenObj)
  for(const uid of Object.keys(usersObj || {})) assigned[String(uid)] = new Map();

  const startTs = Date.now();
  const stopAt = Date.now() + (Number(timeoutMs) || 20000);
  // main loop: keep collecting until every user has their requested count or timeout
  while(Date.now() < stopAt){
    // determine how many new tokens to request this iteration: max remaining across users, up to maxCollect
    let maxNeeded = 0;
    for(const uid of Object.keys(perUserDesired)){
      const need = Math.max(0, perUserDesired[uid] - (assigned[uid] ? assigned[uid].size : 0));
      if(need > maxNeeded) maxNeeded = need;
    }
    if(maxNeeded <= 0) break; // everyone satisfied

    const fetchCount = Math.min(Math.max(5, maxNeeded * 2), Math.max(5, maxCollect));
    const remainingTime = Math.max(1000, stopAt - Date.now());
    // collect an unbiased batch (explicit-only enforced inside collectFreshMints)
  const collectorFn = (module.exports && module.exports.collectFreshMints) ? module.exports.collectFreshMints : collectFreshMints;
  const collected = await collectorFn({ maxCollect: fetchCount, timeoutMs: Math.min(remainingTime, 5000), strictOverride, ageOnly, onlyPrintExplicit: true }).catch(()=>[]);
    const pool = Array.isArray(collected) ? collected : [];
    // strict filter: prefer object tokens and require createdHere when explicit-only
    const poolFiltered = pool.filter(c => {
      try{ if(!c) return false; if(typeof c === 'string') return false; if(ONLY_PRINT_EXPLICIT) return Boolean(c.createdHere); return true; }catch(e){ return false; }
    });

    // Print explicit mints array clearly to terminal for observability
    try{
      // Suppressed noisy collector explicit array dump per operator request.
      // const explicitAddrs = poolFiltered.map(t => (t && (t.mint || t.tokenAddress || t.address)) || null).filter(Boolean);
      // if(explicitAddrs.length > 0){ /* debug output intentionally removed */ }
    }catch(e){}

    // Assign unique tokens to users up to their desired counts
    for(const token of poolFiltered){
      try{
        const addr = (token && (token.mint || token.tokenAddress || token.address)) || null;
        if(!addr) continue;
        // For each user that still needs this token, add it (ensure uniqueness per user)
        for(const uid of Object.keys(perUserDesired)){
          try{
            const need = Math.max(0, perUserDesired[uid] - (assigned[uid] ? assigned[uid].size : 0));
            if(need <= 0) continue;
            if(!assigned[uid].has(addr)){
              assigned[uid].set(addr, token);
            }
          }catch(e){}
        }
      }catch(e){}
    }

    // Check if all users satisfied
    let allSatisfied = true;
    for(const uid of Object.keys(perUserDesired)){
      const need = Math.max(0, perUserDesired[uid] - (assigned[uid] ? assigned[uid].size : 0));
      if(need > 0) { allSatisfied = false; break; }
    }
    if(allSatisfied) break;

    // small delay before next iteration
    await sleep(250);
  }

  // Build result object per user and include a unique userMessage with their addresses
  const result = {};
  for(const uid of Object.keys(usersObj || {})){
    try{
      const map = assigned[uid] || new Map();
      const tokens = Array.from(map.values()).slice(0, 50);
      // attach computed per-token fields similar to previous behavior
      for(const t of tokens){
        try{
          let ageSinceCapture = null;
          if(t && t.collectedAtMs) ageSinceCapture = (Date.now() - Number(t.collectedAtMs)) / 1000;
          else if(t && t._canonicalAgeSeconds != null) ageSinceCapture = Number(t._canonicalAgeSeconds);
          t.ageSinceCaptureSec = (ageSinceCapture !== null && !isNaN(ageSinceCapture)) ? Number(ageSinceCapture) : null;
          t.enrichAllowed = (typeof t.collectedAtMs !== 'undefined') ? ((ENRICH_WINDOW_SEC <= 0) ? true : (t.ageSinceCaptureSec !== null && t.ageSinceCaptureSec <= ENRICH_WINDOW_SEC)) : false;
        }catch(e){ t.ageSinceCaptureSec = null; t.enrichAllowed = false; }
      }
      const addrs = tokens.map(t => (t && (t.mint || t.tokenAddress || t.address)) || null).filter(Boolean);
      // unique addresses and deterministic order
      const uniqueAddrs = Array.from(new Set(addrs));
      const userMessage = uniqueAddrs.length > 0 ? `Collected explicit tokens for user ${uid}: ${uniqueAddrs.join(', ')}` : `No explicit tokens collected for user ${uid}`;
      result[uid] = { user: String(uid), matched: uniqueAddrs, tokens, userMessage, count: uniqueAddrs.length };
    }catch(e){ result[uid] = { user: String(uid), matched: [], tokens: [], userMessage: `No explicit tokens collected for user ${uid}`, count: 0 }; }
  }

  return result;
}
module.exports.collectFreshMintsPerUser = collectFreshMintsPerUser;
// If script is executed directly, run immediately (CLI usage preserved)
if (require.main === module) {
  startSequentialListener().catch(e => { console.error('Listener failed:', e && e.message || e); process.exit(1); });
}

// Export internal helpers for unit tests
try{
  module.exports.getCanonicalAgeSeconds = getCanonicalAgeSeconds;
  module.exports.isMintFresh = isMintFresh;
  module.exports.getFirstSignatureCached = getFirstSignatureCached;
  module.exports.mintPreviouslySeen = mintPreviouslySeen;
  module.exports.isMintCreatedInThisTx = isMintCreatedInThisTx;
}catch(e){}