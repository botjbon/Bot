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
// in-memory per-user notification queues (temporary background memory)
try{ if(!global.__inMemoryNotifQueues) global.__inMemoryNotifQueues = new Map(); }catch(e){}
const INMEM_NOTIF_MAX = Number(process.env.NOTIF_INMEM_MAX || 50);
// optional helper: attempt to require message builder
let _tokenUtils = null;
try{ _tokenUtils = require('../src/utils/tokenUtils'); }catch(e){}

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
    // common log markers
    if(logs.includes('instruction: initializemint') || logs.includes('initialize mint') || logs.includes('initialize_mint') || logs.includes('createidempotent')) return true;
    // sometimes log messages include the mint address when created
    if(m && logs.includes(m)) return true;
    // inspect parsed instructions for initialize mint
    const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
    const instrs = (msg && msg.instructions) || [];
    for(const ins of instrs){
      try{
        const t = (ins.parsed && ins.parsed.type) || (ins.type || '');
        if(t && String(t).toLowerCase().includes('initializemint')) return true;
        const info = ins.parsed && ins.parsed.info;
        if(info){
          if(info.mint && String(info.mint).toLowerCase() === m) return true;
          if(info.newAccount && String(info.newAccount).toLowerCase() === m) return true;
        }
      }catch(e){}
    }
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
  console.error('Sequential 10s per-program listener starting (daemon mode)');
  const seenMints = new Set();
  let stopped = false;
  process.on('SIGINT', () => { console.error('SIGINT received, stopping listener...'); stopped = true; });
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
  try{ fs.watchFile(usersPath, { interval: 2000 }, () => { loadUsers(); console.error('users.json reloaded'); }); }catch(e){}
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
        console.error(`[${p}] listening (10s)`);
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
                console.error('CAPTURED', filePath);
                // update seen set and collector so consumer won't reprocess the same mints
                for(const m of mints) seenMints.add(m);
                for(const m of mints){ if(LATEST_COLLECTED.length < COLLECT_MAX && !LATEST_COLLECTED.includes(m)) LATEST_COLLECTED.push(m); }
                if(LATEST_COLLECTED.length >= COLLECT_MAX){ try{ console.error('COLLECTED_FINAL', JSON.stringify(LATEST_COLLECTED.slice(0, COLLECT_MAX))); console.log(JSON.stringify({ collected: LATEST_COLLECTED.slice(0, COLLECT_MAX), time: new Date().toISOString() })); if(EXIT_ON_COLLECT){ console.error('Exiting because COLLECT_MAX reached'); process.exit(0); } }catch(e){} }
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
            try{
              if(Array.isArray(fresh) && fresh.length>0){
                const latest = fresh.slice(0,2);
                // header (plain)
                console.log(`FRESH_MINTS [program=${p}] [sig=${sig}] [kind=${kind}]`);
                // colored JSON for the array (yellow)
                try{
                  console.log('\x1b[33m%s\x1b[0m', JSON.stringify(latest, null, 2));
                }catch(e){ console.log('\x1b[33m%s\x1b[0m', String(latest)); }
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
            console.log(JSON.stringify(globalEvent));
            // If capture-only mode is enabled, write a tiny capture file and skip enrichment
            if(CAPTURE_ONLY){
              try{
                const outDir = path.join(process.cwd(), 'out', 'capture_queue');
                try{ fs.mkdirSync(outDir, { recursive: true }); }catch(e){}
                const payload = { time:new Date().toISOString(), program:p, signature:sig, kind:kind, fresh:fresh.slice(0,10), sampleLogs:(tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
                const fileName = Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.json';
                const filePath = path.join(outDir, fileName);
                fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
                console.error('CAPTURED', filePath);
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
                  console.error('COLLECTED_FINAL', JSON.stringify(LATEST_COLLECTED.slice(0, COLLECT_MAX)));
                  console.log(JSON.stringify({ collected: LATEST_COLLECTED.slice(0, COLLECT_MAX), time: new Date().toISOString() }));
                }catch(e){}
                if(EXIT_ON_COLLECT){
                  try{ console.error('Exiting because COLLECT_MAX reached'); }catch(e){}
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
                // include listener source metadata so strategy filters can preserve/inspect realtime origin
                const tok = { address: mintAddr, tokenAddress: mintAddr, mint: mintAddr, sourceProgram: p, sourceSignature: sig, sampleLogs: (tx.meta&&tx.meta.logMessages||[]).slice(0,10), sourceCandidates: true };
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
        for(const uid of Object.keys(usersLocal || {})){
                try{
          const user = usersLocal[uid];
                  if(!user || !user.strategy || user.strategy.enabled === false) continue;
          // run the filter (allow enrichment inside strategy filter for accuracy)
      if(!strategyFilterLocal) continue;
          // If the user's numeric strategy fields are all zero/undefined, treat this user
          // as a listener-only user: accept listener-provided candidateTokens directly
          // (no conditions, no enrichment). Otherwise run the normal strategy filter.
          let matched = [];
          try{
            // Consider market-related numeric constraints when deciding listener bypass.
            // Age-related fields are handled separately and should not prevent listener-only fast-path.
            const numericKeys = ['minMarketCap','minLiquidity','minVolume'];
            const hasNumericConstraint = numericKeys.some(k => {
              const v = user.strategy && user.strategy[k];
              return v !== undefined && v !== null && Number(v) > 0;
            });
            if(!hasNumericConstraint){
              // listener-only: accept raw listener tokens as matches (limit to maxTrades)
              const maxTrades = Number(user.strategy && user.strategy.maxTrades ? user.strategy.maxTrades : 3) || 3;
              matched = (Array.isArray(candidateTokens) ? candidateTokens.slice(0, maxTrades) : []);
              try{ console.error(`MATCH (listener-bypass) user=${uid} matched=${matched.map(t=>t.address||t.tokenAddress||t.mint).slice(0,5)}`); }catch(e){}
            } else {
              // default: run the robust strategy filter (may enrich)
              // DEBUG: print per-candidate diagnostics so we can see why tokens are rejected
              try{
                const tu = require('../src/utils/tokenUtils');
                for(const tok of candidateTokens){
                  try{
                    const pre = tu.autoFilterTokensVerbose([tok], user.strategy);
                    const preCount = Array.isArray(pre) ? (pre.length) : (pre && pre.passed ? (pre.passed.length||0) : 0);
                    const willPass = await strategyFilterLocal([tok], user.strategy, { preserveSources: true }).then(r=> Array.isArray(r) && r.length>0).catch(()=>false);
                    try{ console.error(`STRATEGY_DEBUG user=${uid} token=${tok && (tok.tokenAddress||tok.address||tok.mint)} preCandidates=${preCount} pass=${willPass} age=${tok && (tok._canonicalAgeSeconds || (tok.freshnessDetails && tok.freshnessDetails.firstTxMs)) || 'n/a'} sampleLogs=${(tok && tok.sampleLogs? (tok.sampleLogs||[]).slice(0,3).join('|') : '')}`); }catch(e){}
                  }catch(e){}
                }
              }catch(e){}
              matched = await strategyFilterLocal(candidateTokens, user.strategy, { preserveSources: true }).catch(() => []);
            }
          }catch(e){ matched = []; }
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

                    if(!Array.isArray(matchedFiltered) || matchedFiltered.length === 0) {
                      // nothing left after per-user filtering
                      continue;
                    }

                    // Merge matched tokens into a single compact payload (up to 10 tokens)
                    const matchAddrs = matchedFiltered.map(t => t.address || t.tokenAddress || t.mint).slice(0,10);
                    const userEvent = { time:new Date().toISOString(), program:p, signature:sig, user: uid, matched: matchAddrs, kind: kind, candidateTokens: matchedFiltered.slice(0,10) };
                    console.error('MATCH', JSON.stringify(userEvent));
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
                          const pairAddress = tokenObj.pairAddress || tokenObj.tokenAddress || tokenObj.address || tokenObj.mint || '';
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
                                    try{ await autoExec(user, execTokens, 'buy'); }catch(e){ try{ console.error('[listener:autoExec] error', (e && e.message) || e); }catch(_){} }
                                  })();
                                }
                              }catch(e){ /* ignore auto-exec errors */ }
                            } else if(shouldAuto && hasCredentials && !userConfirmed){
                              try{ console.error(`[listener:autoExec] user=${uid} not in AUTO_EXEC_CONFIRM_USER_IDS - skipping auto-exec`); }catch(e){}
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
        console.error(`[${p}] done`);
      }catch(e){ console.error(`[${p}] err ${String(e)}`); }
    }
    // Print RPC stats summary per full cycle
    try{
      const avg = RPC_STATS.calls ? Math.round(RPC_STATS.totalLatencyMs / RPC_STATS.calls) : 0;
      console.error('RPC_STATS', JSON.stringify({ calls: RPC_STATS.calls, errors: RPC_STATS.errors, rateLimit429: RPC_STATS.rateLimit429, avgLatencyMs: avg }));
    }catch(e){}
    // short delay between cycles to avoid tight looping
    try { await sleep(2000); } catch (e) { }
  }
  console.error('Sequential 10s per-program listener stopped');
}

module.exports.startSequentialListener = startSequentialListener;
// Lightweight one-shot collector: run the minimal discovery loop until we collect
// `maxCollect` fresh mints or `timeoutMs` elapses. Returns an array of mint addresses.
// Collector: try to give enough time to iterate all configured programs by default
async function collectFreshMints({ maxCollect = 3, timeoutMs = (Number(process.env.COLLECT_TIMEOUT_MS) || Math.max(20000, PER_PROGRAM_DURATION_MS * (PROGRAMS.length || 1) + 5000)), maxAgeSec = undefined, strictOverride = false, ageOnly = false } = {}){
  const collected = [];
  const seenMintsLocal = new Set();
  const stopAt = Date.now() + (Number(timeoutMs) || 20000);
  try{
    for(const p of PROGRAMS){
      if(Date.now() > stopAt) break;
      try{
    const sigs = await heliusRpc('getSignaturesForAddress', [p, { limit: SIG_BATCH_LIMIT }]);
    try{ console.error(`[LISTENER_DEBUG prog=${p}] signatures=${Array.isArray(sigs)?sigs.length:0}`); }catch(e){}
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
            // Use centralized freshness policy for collector: require isMintFresh true
            const accept = await isMintFresh(m, tx, txBlock, sig, kind, maxAgeSec, ageOnly).catch(()=>false);
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
                console.error(`COLLECT_DEBUG reject program=${p} kind=${kind} mint=${m} age=${ageSec} threshold=${threshold} reason=${reason} sig=${sig}`);
              }catch(e){ console.error(`COLLECT_DEBUG reject program=${p} mint=${m} reason=debug-failed`); }
            }
            if(accept){
              try{
                // compute lightweight on-chain age fields for downstream consumers
                const firstCached = await getFirstSignatureCached(m).catch(()=>null);
                const ft = firstCached && firstCached.blockTime ? firstCached.blockTime : null;
                const ageSec = getCanonicalAgeSeconds(ft, txBlock);
                console.error(`COLLECT_DEBUG accept program=${p} kind=${kind} mint=${m} age=${ageSec} firstBlock=${ft} txBlock=${txBlock} sig=${sig}`);
                const tok = {
                  tokenAddress: m,
                  address: m,
                  mint: m,
                  firstBlockTime: ft ? Number(ft) * 1000 : null, // ms epoch when available
                  _canonicalAgeSeconds: ageSec,
                  sourceProgram: p,
                  sourceSignature: sig,
                  kind: kind,
                  txBlock: txBlock,
                  sampleLogs: (tx.meta && tx.meta.logMessages || []).slice(0,6),
                  __listenerCollected: true,
                };
                collected.push(tok);
                seenMintsLocal.add(m);
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
  }catch(e){}
  return Array.from(new Set(collected)).slice(0, maxCollect);
}
module.exports.collectFreshMints = collectFreshMints;
// Helper: collect once and return per-user merged payloads filtered by each user's strategy
async function collectFreshMintsPerUser(usersObj = {}, { maxCollect = 10, timeoutMs = (Number(process.env.COLLECT_TIMEOUT_MS) || 20000), strictOverride = false, ageOnly = false } = {}){
  // Determine the maximal per-user age threshold (seconds) to pass into the collector
  // so the centralized freshness checks honor user-configured age windows.
  let maxUserAge = undefined;
  try{
    for(const uid of Object.keys(usersObj || {})){
      try{
        const user = usersObj[uid] || {};
        let rawAge = (user && user.strategy && (user.strategy.maxAgeSec !== undefined)) ? user.strategy.maxAgeSec : (user && user.strategy ? user.strategy.minAge : undefined);
        if(rawAge === undefined || rawAge === null){
          // try parse legacy durations if tokenUtils available
          if(_tokenUtils && typeof _tokenUtils.parseDuration === 'function' && rawAge !== undefined && rawAge !== null){
            rawAge = _tokenUtils.parseDuration(rawAge);
          }
        }
        const num = (rawAge !== undefined && rawAge !== null && !Number.isNaN(Number(rawAge))) ? Number(rawAge) : undefined;
        if(typeof num === 'number' && !isNaN(num)){
          if(maxUserAge === undefined || num > maxUserAge) maxUserAge = num;
        }
      }catch(e){}
    }
  }catch(e){}

  try{ console.error(`[LISTENER_DEBUG] collectFreshMintsPerUser using maxUserAge=${String(maxUserAge)} for users=${Object.keys(usersObj||{}).length}`); }catch(e){}
  // Run a single collector pass with maxAgeSec set to the largest per-user threshold found
  const collected = await collectFreshMints({ maxCollect, timeoutMs, maxAgeSec: maxUserAge, strictOverride, ageOnly });
  try{ console.error(`[LISTENER_DEBUG] collected candidates=${Array.isArray(collected)?collected.length:0} for users=${Object.keys(usersObj||{}).length}`); }catch(e){}
  const result = {};
  for(const uid of Object.keys(usersObj || {})){
    try{
      const user = usersObj[uid] || {};
  // ...production: no test-injection hooks here (inject test tokens only during local dev/debug runs)
      // Allow both `maxAgeSec` (preferred) and legacy `minAge` as the user's age threshold
      const rawAge = (user && user.strategy && (user.strategy.maxAgeSec !== undefined)) ? user.strategy.maxAgeSec : (user && user.strategy ? user.strategy.minAge : undefined);
      let userAgeThreshold = null;
      try{
        if(rawAge !== undefined && rawAge !== null && !Number.isNaN(Number(rawAge))){
          userAgeThreshold = Number(rawAge);
        } else if(_tokenUtils && typeof _tokenUtils.parseDuration === 'function' && rawAge !== undefined && rawAge !== null){
          const parsed = _tokenUtils.parseDuration(rawAge);
          if(parsed !== undefined && parsed !== null && !Number.isNaN(Number(parsed))) userAgeThreshold = Number(parsed);
        }
      }catch(e){}
      try{ console.error(`[LISTENER_DEBUG] user=${uid} rawAge=${String(rawAge)} userAgeThreshold=${String(userAgeThreshold)}`); }catch(e){}
      const tokens = (Array.isArray(collected) ? collected : []).filter(t => {
        try{
          const age = (t && t._canonicalAgeSeconds != null) ? Number(t._canonicalAgeSeconds) : null;
          if(userAgeThreshold !== null){
            return (age !== null && !isNaN(age) && age <= userAgeThreshold);
          }
          return true;
        }catch(e){ return false; }
      }).slice(0, 10);
      try{ console.error(`[LISTENER_DEBUG] user=${uid} matched_after_age_filter=${tokens.length}`); }catch(e){}
      result[uid] = { user: String(uid), matched: tokens.map(t => t.mint), tokens };
      // If there are accepted tokens for this user, print them immediately using the bulleted message template
      try{
        if(Array.isArray(tokens) && tokens.length > 0){
          if(_tokenUtils && typeof _tokenUtils.buildBulletedMessage === 'function'){
            try{
              const cluster = process.env.SOLANA_CLUSTER || 'mainnet';
              const title = `Live tokens (listener) for ${uid}`;
              const { text, inline_keyboard } = _tokenUtils.buildBulletedMessage(tokens, { cluster, title, maxShow: tokens.length });
              // Print formatted HTML message to stderr (so logs and collectors can capture it)
              console.error(`[LISTENER_MSG user=${uid}]`);
              console.error(text);
              try{ console.error('[LISTENER_MSG inline_keyboard]', JSON.stringify(inline_keyboard)); }catch(e){}
            }catch(e){ console.error(`[LISTENER_MSG user=${uid}] buildBulletedMessage failed: ${String(e)}`); }
          } else {
            // fallback: simple list output
            try{ console.error(`[LISTENER_MSG user=${uid}] accepted tokens: ${tokens.map(t => (t && (t.mint || t.tokenAddress || t.address)) || String(t)).join(', ')}`); }catch(e){}
          }
        }
      }catch(e){}
    }catch(e){ result[uid] = { user: String(uid), matched: [], tokens: [] }; }
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
}catch(e){}