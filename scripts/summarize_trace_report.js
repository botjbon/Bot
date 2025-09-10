#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const infile = path.join(__dirname, '..', 'trace_fetch_report.json');
const outfile = path.join(__dirname, '..', 'trace_fetch_summary.json');
if(!fs.existsSync(infile)){
  console.error('Input report not found:', infile);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(infile, 'utf8'));
const findings = data.findings || [];
const summary = findings.map(f => {
  const methods = Array.from(new Set((f.hits||[]).map(h=>h.pattern).filter(Boolean)));
  const snippets = Array.from(new Set((f.hits||[]).map(h=>h.snippet).filter(Boolean))).slice(0,5);
  return { file: f.file, func: f.func, methods, snippets };
});
fs.writeFileSync(outfile, JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 2));
console.log('wrote', outfile);
