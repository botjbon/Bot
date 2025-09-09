(async () => {
  try {
    process.env.ONLY_PRINT_EXPLICIT = '1';
    const seq = require('./scripts/sequential_10s_per_program.js');
    const tu = require('./src/utils/tokenUtils');
    const users = { '5766632997': require('./users.json')['5766632997'] };
    console.log('Starting collectFreshMintsPerUser for user 5766632997...');
    const res = await seq.collectFreshMintsPerUser(users, { maxCollect: 5, timeoutMs: 20000, strictOverride: false, ageOnly: false }).catch(e => { console.error('collect err', e && e.message || e); return {}; });
    console.log('Collector result:', JSON.stringify(res, null, 2));
    const payload = res && res['5766632997'] ? res['5766632997'] : null;
    if (!payload) { console.log('No payload returned'); return; }
    console.log('\n--- payload.tokens ---');
    console.log(JSON.stringify(payload.tokens, null, 2));
    const tokens = payload.tokens || [];
    if (tokens.length > 0) {
      const { text, inline_keyboard } = tu.buildBulletedMessage(tokens, { cluster: process.env.SOLANA_CLUSTER || 'mainnet', title: 'Live tokens (listener)', maxShow: tokens.length });
      console.log('\n--- HTML message ---\n' + text);
      console.log('\n--- inline_keyboard ---\n' + JSON.stringify(inline_keyboard, null, 2));
    } else console.log('No tokens to build message');
  } catch (e) {
    console.error('Script failed:', e && e.stack || e);
  }
})();
