#!/usr/bin/env node
require('dotenv').config();
(async function(){
  try{
    const seq = require('./sequential_10s_per_program.js');
    const users = require('../users.json');
    // run collector in explicit-only minimal mode
    const res = await seq.collectFreshMintsPerUser(users, { maxCollect: 3, timeoutMs: 15000, onlyPrintExplicit: true });
    // print result for inspection
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }catch(e){
    console.error('RUN_COLLECT_ERR', e && (e.message || e));
    process.exit(1);
  }
})();
