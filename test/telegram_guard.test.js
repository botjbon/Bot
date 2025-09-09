const guard = require('../src/bot/telegramGuard');

async function run(){
  const calls = [];
  const telegram = {
    sendMessage: async (chatId, msg, opts) => { calls.push({ chatId, msg, opts }); }
  };

  // 1) When tokenObjs are non-explicit, should send suppression message and return false
  calls.length = 0;
  const res1 = await guard.sendNotificationIfExplicit(telegram, 'user1', { tokenObjs: [{ mint: 'A', createdHere: false }] });
  if(res1 !== false) { console.error('FAIL: expected false for non-explicit tokens'); process.exit(2); }
  if(calls.length !== 1 || !String(calls[0].msg).includes('suppressed')){ console.error('FAIL: suppression message not sent', JSON.stringify(calls)); process.exit(2); }

  // 2) When HTML provided, send HTML and return true (even without tokenObjs)
  calls.length = 0;
  const res2 = await guard.sendNotificationIfExplicit(telegram, 'user2', { html: '<b>hello</b>' });
  if(res2 !== true) { console.error('FAIL: expected true for HTML send'); process.exit(2); }
  if(calls.length !== 1 || !String(calls[0].msg).includes('<b>hello</b>')){ console.error('FAIL: html not sent', JSON.stringify(calls)); process.exit(2); }

  // 3) When tokenObjs explicit, should send list fallback and return true
  calls.length = 0;
  const tokens = [{ mint: 'MintX', createdHere: true }, { mint: 'MintY', createdHere: true }];
  const res3 = await guard.sendNotificationIfExplicit(telegram, 'user3', { tokenObjs: tokens });
  if(res3 !== true) { console.error('FAIL: expected true for explicit tokenObjs'); process.exit(2); }
  if(calls.length !== 1 || !String(calls[0].msg).includes('MintX')){ console.error('FAIL: token list not sent', JSON.stringify(calls)); process.exit(2); }

  console.log('PASS'); process.exit(0);
}

run();
