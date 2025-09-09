const seq = require('../scripts/sequential_10s_per_program');

async function run(){
  // Force explicit-only behavior for deterministic test
  process.env.ONLY_PRINT_EXPLICIT = 'true';

  // Save original function to restore later
  const origCollect = seq.collectFreshMints;
  try{
    // Mock collector to return three explicit token objects
    const now = Date.now();
    const mockTokens = [
      { mint: 'MintA', tokenAddress: 'MintA', address: 'MintA', createdHere: true, collectedAtMs: now - 500 },
      { mint: 'MintB', tokenAddress: 'MintB', address: 'MintB', createdHere: true, collectedAtMs: now - 600 },
      { mint: 'MintC', tokenAddress: 'MintC', address: 'MintC', createdHere: true, collectedAtMs: now - 700 }
    ];
    seq.collectFreshMints = async function mockCollect(opts){
      // return up to opts.maxCollect or all
      const max = (opts && opts.maxCollect) ? Number(opts.maxCollect) : mockTokens.length;
      return mockTokens.slice(0, Math.max(0, Math.min(mockTokens.length, max)));
    };

  // Prepare users: user1 wants 2 tokens, user2 wants 1 token
    const users = {
      'user1': { strategy: { requiredMints: 2 } },
      'user2': { strategy: { requiredMints: 1 } }
    };

  // Quick sanity: call collectFreshMints directly to ensure mock returns tokens
  await seq.collectFreshMints({ maxCollect: 3, timeoutMs: 2000 });
  const res = await seq.collectFreshMintsPerUser(users, { maxCollect: 3, timeoutMs: 2000 });

    // Assertions
    if(!res || typeof res !== 'object') { console.error('FAIL: result not object'); process.exit(2); }
    // user1 should get 2 unique addresses
    const u1 = res['user1'];
    if(!u1 || !Array.isArray(u1.matched) || u1.matched.length !== 2){ console.error('FAIL: user1 did not receive 2 tokens', JSON.stringify(u1)); process.exit(2); }
    // userMessage should contain both addresses
    if(typeof u1.userMessage !== 'string' || !u1.userMessage.includes('MintA') || !u1.userMessage.includes('MintB')){ console.error('FAIL: user1 message missing addresses', u1.userMessage); process.exit(2); }

    const u2 = res['user2'];
    if(!u2 || !Array.isArray(u2.matched) || u2.matched.length !== 1){ console.error('FAIL: user2 did not receive 1 token', JSON.stringify(u2)); process.exit(2); }
    if(typeof u2.userMessage !== 'string' || !u2.userMessage.includes('MintA') && !u2.userMessage.includes('MintB') && !u2.userMessage.includes('MintC')){ console.error('FAIL: user2 message missing address', u2.userMessage); process.exit(2); }

    console.log('PASS'); process.exit(0);
  }catch(e){ console.error('ERR', e && e.stack || e); process.exit(3); }
  finally{
    // restore original
    try{ seq.collectFreshMints = origCollect; }catch(e){}
  }
}

run();
