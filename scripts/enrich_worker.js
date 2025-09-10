#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const OUT_DIR = path.join(process.cwd(), 'out');
const QUEUE_DIR = path.join(OUT_DIR, 'capture_queue');
const NOTIF_DIR = path.join(OUT_DIR, 'notifications');
try{ fs.mkdirSync(QUEUE_DIR, { recursive: true }); }catch(e){}
try{ fs.mkdirSync(NOTIF_DIR, { recursive: true }); }catch(e){}

const _HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.HELIUS_RPC || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
if(_HELIUS_KEYS.length===0){ const k = process.env.HELIUS_API_KEY || ''; if(k) _HELIUS_KEYS.push(k); }
if(HELIUS_RPC_URLS.length===0){ HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/'); }
let heliusCallCounter = 0;
// Collector guard: only allow active enrichment/RPCs when FORCE_ENRICH=true
const ALLOW_ENRICH = String(process.env.FORCE_ENRICH || '').toLowerCase() === 'true';
if(!ALLOW_ENRICH){ console.error('[COLLECTOR-GUARD] enrich_worker: Helius RPCs disabled (FORCE_ENRICH not set). To enable set FORCE_ENRICH=true in the environment.'); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function heliusRpc(method, params){
  // Respect collector-only policy: if enrichment is not allowed, return a sentinel error
  if(!ALLOW_ENRICH){ return { __error: 'collector-guard-disabled' }; }
  try{
    const keyIdx = heliusCallCounter % Math.max(1, _HELIUS_KEYS.length);
    const urlIdx = heliusCallCounter % Math.max(1, HELIUS_RPC_URLS.length);
    heliusCallCounter = (heliusCallCounter + 1) >>> 0;
    const url = HELIUS_RPC_URLS[urlIdx];
    const hdrs = Object.assign({ 'Content-Type': 'application/json' }, _HELIUS_KEYS[keyIdx] ? { 'x-api-key': _HELIUS_KEYS[keyIdx] } : {});
    const res = await axios.post(url, { jsonrpc:'2.0', id:1, method, params }, { headers: hdrs, timeout:15000 });
    return res.data && (res.data.result || res.data);
  }catch(e){ return { __error: e.message || String(e), status: e.response && e.response.status }; }
}

async function processOne(file){
  const filePath = path.join(QUEUE_DIR, file);
  try{
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    const { mints, signature, program, kind, sampleLogs } = obj;
    const enriched = [];
  for(const m of (mints||[])){
      try{
        // fetch first signature for mint and include blockTime
        const sigs = await heliusRpc('getSignaturesForAddress', [m, { limit: 1 }]);
        if(Array.isArray(sigs) && sigs.length>0){ const s0 = sigs[0]; enriched.push({ mint: m, firstSig: s0.signature||s0.sig||s0.txHash, blockTime: s0.blockTime||s0.block_time||null }); }
        else enriched.push({ mint: m, firstSig: null, blockTime: null });
      }catch(e){ enriched.push({ mint: m, firstSig: null, blockTime: null }); }
    }
    // Normalize blockTime values in the enriched output to milliseconds epoch when possible
    try{
      for(const ent of enriched){
        try{
          const bt = ent && (ent.blockTime || ent.block_time || ent.blocktime || null);
          if(bt === null || bt === undefined) { ent.blockTime = null; continue; }
          const n = Number(bt);
          if(!n || Number.isNaN(n)) { ent.blockTime = null; continue; }
          // if value looks like ms epoch (> 1e12) keep, if looks like seconds (>1e9) convert to ms
          if(n > 1e12) ent.blockTime = Math.floor(n);
          else if(n > 1e9) ent.blockTime = Math.floor(n * 1000);
          else ent.blockTime = null;
        }catch(e){}
      }
    }catch(e){}

    const notif = { time: new Date().toISOString(), program, signature, kind, enriched, sampleLogs };
    const outFile = path.join(NOTIF_DIR, Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.json');
    fs.writeFileSync(outFile, JSON.stringify(notif, null, 2), 'utf8');
    // remove processed capture file
    try{ fs.unlinkSync(filePath); }catch(e){}
    console.error('ENRICHED', outFile);
  }catch(e){ console.error('PROCESS_ERR', file, e && e.message); }
}

async function runWorker(){
  console.error('enrich_worker starting');
  while(true){
    try{
      const files = fs.readdirSync(QUEUE_DIR).filter(f => !f.startsWith('.')).sort();
      if(files.length===0){ await sleep(250); continue; }
      // process up to N files per loop to limit bursts
      const batch = files.slice(0, 5);
      for(const f of batch) await processOne(f);
    }catch(e){ console.error('WORKER_ERR', e && e.message); }
    await sleep(200);
  }
}

if(require.main === module){ runWorker().catch(e=>{ console.error('fatal', e && e.message); process.exit(1); }); }
