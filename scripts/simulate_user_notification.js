#!/usr/bin/env node
require('dotenv').config();
(async function(){
  try{
    const users = require('../users.json');
    const uid = Object.keys(users)[0];
    const mint = 'GxUJu5AMbApxVBNos1ZRr1GB3M3oyAAt5TMojE4tpump';
    const program = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
    const signature = 'SIMULATED_SIGNATURE_1234567890';
    const sampleLogs = ['Program ComputeBudget... invoke [1]','Program log: Instruction: Create'];
    const tokenObj = {
      tokenAddress: mint,
      address: mint,
      mint: mint,
      createdHere: true,
      sampleLogs,
      sourceProgram: program,
      sourceSignature: signature,
      collectedAtMs: Date.now(),
      __listenerCollected: true
    };
    const perUser = {};
    perUser[uid] = {
      user: String(uid),
      matched: [mint],
      tokens: [tokenObj],
      userMessage: `Collected explicit tokens for user ${uid}: ${mint}`,
      count: 1
    };
    // Print per-user collector payload
    console.log('\n--- PER-USER COLLECTOR PAYLOAD ---');
    console.log(JSON.stringify(perUser, null, 2));

    // Print canonical two-line output that the collector emits for this discovery
    console.log('\n--- CANONICAL LISTENER OUTPUT (2 LINES) ---');
    console.log(JSON.stringify([mint]));
    console.log(JSON.stringify({ time: new Date().toISOString(), program, signature, kind: 'initialize', freshMints: [mint], sampleLogs }));

    // Build telegram payload using tokenUtils if present
    console.log('\n--- TELEGRAM PAYLOAD (what would be sent to user) ---');
    try{
      const tu = require('../src/utils/tokenUtils');
      let built = null;
      if(tu && typeof tu.buildBulletedMessage === 'function'){
        built = tu.buildBulletedMessage([tokenObj], { cluster: process.env.SOLANA_CLUSTER || 'mainnet', title: 'Live tokens (listener)', maxShow: 5 });
      }
      if(built && built.text){
        console.log('html:\n' + built.text);
        try{ console.log('inline_keyboard:\n' + JSON.stringify(built.inline_keyboard, null, 2)); }catch(e){}
      } else {
        // fallback simple message
        const html = `✅ Found explicit token:\n<b>${mint}</b> (<code>${mint}</code>)\nSource: ${program} | Sig: ${signature}`;
        console.log('html:\n' + html);
      }
    }catch(e){
      const html = `✅ Found explicit token:\n<b>${mint}</b> (<code>${mint}</code>)\nSource: ${program} | Sig: ${signature}`;
      console.log('html:\n' + html);
    }

    process.exit(0);
  }catch(e){ console.error('SIM_ERR', e && (e.message || e)); process.exit(1); }
})();
