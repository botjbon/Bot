const seq = require('../scripts/sequential_10s_per_program');

async function run(){
  process.env.ONLY_PRINT_EXPLICIT = 'true';
  // We'll call collectFreshMints with a tiny timeout and maxCollect=0 to avoid network calls.
  try{
    const res = await seq.collectFreshMints({ maxCollect: 0, timeoutMs: 100 });
    console.log('collector returned length:', Array.isArray(res) ? res.length : typeof res);
    // Expect an array; we assert that every returned item (if any) has createdHere===true
    if(!Array.isArray(res)) { console.error('FAIL: not array'); process.exit(2); }
    for(const t of res){ if(!t || typeof t !== 'object' || t.createdHere !== true){ console.error('FAIL: non-explicit token returned', t); process.exit(2); } }
    console.log('PASS'); process.exit(0);
  }catch(e){ console.error('ERR', e); process.exit(3); }
}
run();
