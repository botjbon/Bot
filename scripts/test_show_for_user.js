#!/usr/bin/env node
require('dotenv').config();
(async function(){
  try{
    const users = require('../users.json');
    const uid = Object.keys(users)[0];
    if(!uid){ console.error('No users'); process.exit(1); }
    const seq = require('./sequential_10s_per_program.js');
    // collect per-user payload with explicit-only enforced
    const collected = await seq.collectFreshMintsPerUser({ [uid]: users[uid] }, { maxCollect: 3, timeoutMs: 10000, onlyPrintExplicit: true }).catch(e=>{ console.error('collector err', e); return {}; });
    const payload = collected && collected[uid] ? collected[uid] : null;
    console.log('\n--- collector returned payload for user ' + uid + ' ---');
    console.log(JSON.stringify(payload, null, 2));

    // prepare a mock telegram object to capture sendMessage calls
    const sent = [];
    const mockTelegram = {
      sendMessage: async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 123, chat: { id: chatId }, text };
      }
    };

    const guard = require('../src/bot/telegramGuard').sendNotificationIfExplicit;
    // Build html via tokenUtils if available (mirrors bot behavior)
    let html = null, inlineKeyboard = null;
    try{
      const tu = require('../src/utils/tokenUtils');
      if(tu && typeof tu.buildBulletedMessage === 'function' && payload && Array.isArray(payload.tokens) && payload.tokens.length>0){
        const built = tu.buildBulletedMessage(payload.tokens, { cluster: process.env.SOLANA_CLUSTER || 'mainnet', title: 'Live tokens (listener)', maxShow: Math.min(10, payload.tokens.length) });
        if(built && built.text) html = built.text;
        if(built && built.inline_keyboard) inlineKeyboard = built.inline_keyboard;
      }
    }catch(e){}

    // Invoke guard with tokenObjs and userEvent to simulate bot notification
    const userEvent = { time: new Date().toISOString(), program: payload && payload.tokens && payload.tokens[0] ? payload.tokens[0].sourceProgram : undefined, signature: payload && payload.tokens && payload.tokens[0] ? payload.tokens[0].sourceSignature : undefined, kind: 'initialize', freshMints: payload && payload.tokens ? payload.tokens.map(t=> t.mint || t.address || t.tokenAddress) : [] };
    const tokenObjs = payload && payload.tokens ? payload.tokens : [];
    await guard(mockTelegram, uid, { html, inlineKeyboard, tokenObjs, userEvent, fallbackText: 'ℹ️ Notification suppressed (test)' });

    console.log('\n--- Captured sendMessage calls (mock) ---');
    console.log(JSON.stringify(sent, null, 2));
    process.exit(0);
  }catch(e){ console.error('ERR', e && (e.message || e)); process.exit(1); }
})();
