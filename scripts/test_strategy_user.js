// Simple test runner: load captures from out/capture_queue and run filterTokensByStrategy
const fs = require('fs');
const path = require('path');
const users = require('../users.json');
const { filterTokensByStrategy } = require('../dist/src/bot/strategy');
(async function(){
  const outdir = path.join(process.cwd(), 'users', 'id');
  const files = (fs.existsSync(outdir) ? fs.readdirSync(outdir).filter(f=>f.endsWith('.json')) : []);
  if (!files.length) { console.log(' files found in', outdir); process.exit(0); }
  const tokens = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(outdir,f),'utf8'));
      // captures may be arrays or single tokens
      if (Array.isArray(j)) tokens.push(...j);
      else if (j && j.tokenAddress) tokens.push(j);
      else if (j && Array.isArray(j.tokens)) tokens.push(...j.tokens);
      else if (j && Array.isArray(j.mints)) {
        for (const m of j.mints) {
          tokens.push({ tokenAddress: m, mint: m, address: m, sourceCapture: path.basename(f) });
        }
      }
    } catch(e){ console.warn('failed to parse',f,e && e.message); }
  }
  console.log('loaded', tokens.length, 'tokens from capture_queue');
  const user = users['7948630771'];
  if (!user) { console.error('user not found'); process.exit(1); }
  const filtered = await filterTokensByStrategy(tokens, user.strategy, { preserveSources: true });
  console.log('filtered tokens count:', filtered.length);
  const addrs = filtered.map(t=>t.tokenAddress || t.address || t.mint || t.token).filter(Boolean).slice(0,20);
  console.log('addresses:', addrs);
})();
