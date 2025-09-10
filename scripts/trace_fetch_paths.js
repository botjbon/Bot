#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GLOB = ['.js', '.ts', '.jsx', '.tsx'].map(ext => `**/*${ext}`);

// Patterns to detect fetch/enrich/collector points
const PATTERNS = [
  { name: 'http_fetch', re: /\bfetch\s*\(/g },
  { name: 'axios', re: /\baxios\b/g },
  { name: 'node_fetch_require', re: /require\(['"]node-fetch['"]/g },
  { name: 'collector_collectFreshMints', re: /collectFreshMintsPerUser|collectFreshMints\b/g },
  { name: 'fastTokenFetcher', re: /fastTokenFetcher|fetchFirstSignatureForMint|fetchLatest5FromAllSources/g },
  { name: 'enrich', re: /enrichTokenTimestamps|officialEnrich|officialEnrich\b|autoFilterTokensVerbose|autoFilterTokens/g },
  { name: 'rpc_helius', re: /HELIUS|helius|Helius/g },
  { name: 'redis', re: /\bcreateClient\(|rc\.get\(|rc\.rPop\(|redis/g },
  { name: 'db_mongo', re: /mongoose\b|MongoClient/g },
  { name: 'unified_trade', re: /unifiedBuy|unifiedSell/g },
  { name: 'dextools/dexscreener', re: /dexscreener|DexScreener|dexTop|dexTop/g },
  { name: 'ws_listener', re: /WsListener|heliusWsListener|wsListener|notifier/g },
];

function walk(dir, fileList = []){
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for(const e of entries){
    const full = path.join(dir, e.name);
    if(e.isDirectory()){
      if(['node_modules','.git','dist'].includes(e.name)) continue;
      walk(full, fileList);
    } else {
      if(/\.(js|ts|jsx|tsx)$/.test(e.name)) fileList.push(full);
    }
  }
  return fileList;
}

function findNearestFunction(lines, idx){
  // scan backwards for function or export lines
  for(let i=idx; i>=0 && i>idx-40; i--){
    const l = lines[i];
    if(/function\s+\w+\s*\(/.test(l)) return lines[i].trim();
    if(/const\s+\w+\s*=\s*\(?\s*\w*\s*=>/.test(l)) return lines[i].trim();
    if(/export\s+function\s+\w+\s*\(/.test(l)) return lines[i].trim();
    if(/class\s+\w+/.test(l)) return lines[i].trim();
  }
  return null;
}

function scanFile(file){
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split(/\r?\n/);
  const results = [];
  for(const p of PATTERNS){
    let m;
    const re = new RegExp(p.re.source, 'g');
    while((m = re.exec(txt)) !== null){
      // compute line number
      const before = txt.slice(0, m.index);
      const line = before.split(/\r?\n/).length - 1;
      const snippet = (lines[line] || '').trim();
      const func = findNearestFunction(lines, line);
      results.push({ file, line: line+1, snippet, pattern: p.name, func: func || null });
    }
  }
  return results;
}

function main(){
  const files = walk(ROOT);
  const report = [];
  for(const f of files){
    try{
      const r = scanFile(f);
      if(r && r.length) report.push(...r);
    }catch(e){ /* ignore read errors */ }
  }
  // Consolidate by file + function
  const out = {};
  for(const e of report){
    const key = `${path.relative(ROOT, e.file)}::${e.func||'<top>'}`;
    if(!out[key]) out[key] = { file: path.relative(ROOT, e.file), func: e.func||'<top>', hits: [] };
    out[key].hits.push({ line: e.line, snippet: e.snippet, pattern: e.pattern });
  }

  const arr = Object.values(out).sort((a,b)=> a.file.localeCompare(b.file));
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), findings: arr }, null, 2));
}

main();
