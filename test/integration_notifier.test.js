// Integration-style test: simulate listenerNotifier emitting notifications and
// verify telegram sends are suppressed for non-explicit tokens and allowed for explicit tokens.
const path = require('path');

async function run(){
  process.env.ONLY_PRINT_EXPLICIT = 'true';
  // Use the listener notifier directly and register a test handler which calls the guard
  const seq = require('../scripts/sequential_10s_per_program.js');
  const notifier = seq && seq.notifier;
  if(!notifier || typeof notifier.on !== 'function' || typeof notifier.emit !== 'function'){ console.error('FAIL: notifier not available'); process.exit(2); }

  const guard = require('../src/bot/telegramGuard');
  const sends = [];
  const fakeTelegram = { sendMessage: async (chatId, msg, opts) => { sends.push({ chatId, msg, opts }); } };

  // Register test handler that mirrors telegramBot notifier behavior but uses the guard
  const handler = async (userEvent) => {
    try{
      const uid = String(userEvent && userEvent.user);
      if(!uid) return;
      const tokenObjs = Array.isArray(userEvent.tokens) ? userEvent.tokens.slice(0, 10) : [];
      // Call the guard to send (or suppress)
      await guard.sendNotificationIfExplicit(fakeTelegram, uid, { tokenObjs, userEvent, fallbackText: 'suppressed' });
    }catch(e){}
  };
  notifier.on('notification', handler);

  // 1) Emit non-explicit tokens -> expect suppression message
  sends.length = 0;
  notifier.emit('notification', { user: 'test1', program: 'p', signature: 's1', tokens: [{ mint: 'A', createdHere: false }] });
  await new Promise(r=>setTimeout(r, 200));
  if(sends.length === 0 || !String(sends[0].msg).includes('suppressed')){ console.error('FAIL: expected suppression send for non-explicit', JSON.stringify(sends)); process.exit(2); }

  // 2) Emit explicit tokens -> expect a list send
  sends.length = 0;
  notifier.emit('notification', { user: 'test2', program: 'p', signature: 's2', tokens: [{ mint: 'X', createdHere: true }, { mint: 'Y', createdHere: true }] });
  await new Promise(r=>setTimeout(r, 200));
  if(sends.length === 0 || (!String(sends[0].msg).includes('X') && !String(sends[0].msg).includes('Y'))){ console.error('FAIL: expected explicit tokens sent', JSON.stringify(sends)); process.exit(2); }

  // cleanup
  try{ notifier.off('notification', handler); }catch(e){}

  console.log('PASS'); process.exit(0);
}

run();
