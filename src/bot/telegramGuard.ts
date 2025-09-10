// Small helper to enforce explicit-only token notifications to Telegram
export async function sendNotificationIfExplicit(telegram: any, chatId: any, opts: { html?: string, inlineKeyboard?: any, fallbackText?: string, tokenObjs?: any[], userEvent?: any }){
  try{
    // Feature flag: when true allow full addresses to be shown in Telegram messages.
    const SHOW_FULL = String(process.env.SHOW_FULL_ADDRESSES || '').toLowerCase() === 'true';
    const maskAddr = (s:any) => {
      try{
        if(!s || SHOW_FULL) return String(s);
        const str = String(s);
        if(str.length <= 12) return str;
        return str.slice(0,6) + '...' + str.slice(-6);
      }catch(e){ return String(s); }
    };
    const tokenObjs = Array.isArray(opts && opts.tokenObjs) ? opts.tokenObjs : [];
    // New policy: allow messages only when:
    // 1) caller provided a userEvent with kind==='initialize' and freshMints (we'll use those), OR
    // 2) tokenObjs are present and flagged createdHere === true (explicit-created tokens)
    const userEvent = opts && (opts.userEvent || null);

    // Helper: extract mint/address from token object
    const getMint = (t: any) => (t && (t.mint || t.tokenAddress || t.address)) || null;

    // If userEvent indicates an initialize block, prefer that as the authoritative source
    if (userEvent && userEvent.kind === 'initialize' && Array.isArray(userEvent.freshMints) && userEvent.freshMints.length > 0) {
      try { console.log(`[telegramGuard] userEvent initialize detected to=${chatId} program=${userEvent.program || '<unk>'} signature=${userEvent.signature || '<unk>'} freshCount=${userEvent.freshMints.length}`); } catch (e) {}
      const allowed = new Set((userEvent.freshMints || []).map(String));
      // If tokenObjs provided, filter them to the freshMints set
      if (tokenObjs.length > 0) {
        const intersect = tokenObjs.filter((t:any) => {
          const m = getMint(t);
          return m && allowed.has(String(m));
        });
        if (!intersect || intersect.length === 0) {
          try { console.log(`[telegramGuard] suppressed: none of provided tokenObjs are in initialize.freshMints to=${chatId} provided=${tokenObjs.length}`); } catch(e){}
          try{ await telegram.sendMessage(chatId, 'ℹ️ Notification suppressed: tokens were not from the collector initialize block.'); }catch(e){}
          return false;
        }
        // use intersected tokenObjs for rendering
        opts.tokenObjs = intersect;
        try { const m = intersect.map(getMint).slice(0,10); console.log(`[telegramGuard] allowing notification to=${chatId} reason=initialize-intersect count=${intersect.length} sample=${JSON.stringify(m)}`); } catch(e){}
      } else {
        // No tokenObjs but we have freshMints: populate tokenObjs from freshMints as simple objects so caller can render list
        opts.tokenObjs = (userEvent.freshMints || []).slice(0, 50).map((m: any) => ({ mint: String(m) }));
        try { console.log(`[telegramGuard] allowing notification to=${chatId} reason=initialize-freshMints populated count=${opts.tokenObjs.length}`); } catch(e){}
      }
    } else if (tokenObjs.length > 0) {
      // Fallback rule: require tokenObjs to be explicit-created
      const explicit = tokenObjs.filter(t => t && t.createdHere === true);
      if (!explicit || explicit.length === 0) {
        try {
          const mints = tokenObjs.map(getMint).slice(0, 10);
          console.log(`[telegramGuard] suppressed notification to=${chatId} reason=no-explicit-tokens found=${tokenObjs.length} sample=${JSON.stringify(mints)}`);
        } catch (e) {}
        try{ await telegram.sendMessage(chatId, 'ℹ️ Notification suppressed: only explicit-created tokens are allowed to be sent.'); }catch(e){}
        return false;
      }
      // replace tokenObjs with explicit subset for further rendering
      opts.tokenObjs = explicit;
      try { const m = explicit.map(getMint).slice(0,10); console.log(`[telegramGuard] allowing notification to=${chatId} reason=explicit-tokens count=${explicit.length} sample=${JSON.stringify(m)}`); } catch(e){}
    } else {
      // No userEvent/initialize and no tokenObjs -> messages with addresses are not allowed
      try { console.log(`[telegramGuard] suppressed notification to=${chatId} reason=no-token-source`); } catch(e){}
      // Allow fallbackText only if caller intends a non-token informational message
      // but do not proactively send lists of addresses
    }

    // If HTML provided, send that (caller should have built HTML for explicit tokens)
    if (opts.html && typeof opts.html === 'string' && opts.html.length > 0) {
      try { console.log(`[telegramGuard] sending HTML to=${chatId} html_len=${opts.html.length}`); } catch (e) {}
      // Sanitize HTML by masking any detected base58-like addresses unless SHOW_FULL is enabled
      let safeHtml = opts.html;
      try{
        if(!SHOW_FULL){
          const re = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
          safeHtml = String(safeHtml).replace(re, (m)=> maskAddr(m));
        }
      }catch(e){}
      const options: any = ({ parse_mode: 'HTML', disable_web_page_preview: false } as any);
      if(opts.inlineKeyboard){
        try{
          // sanitize inline keyboard URLs to avoid leaking full addresses
          if(!SHOW_FULL){
            const kb = JSON.parse(JSON.stringify(opts.inlineKeyboard));
            for(const row of kb){
              for(const btn of row){
                try{ if(btn && btn.url){ delete btn.url; btn.callback_data = btn.callback_data || 'share_disabled'; } }catch(e){}
              }
            }
            options.reply_markup = { inline_keyboard: kb };
          } else {
            options.reply_markup = { inline_keyboard: opts.inlineKeyboard };
          }
        }catch(e){ options.reply_markup = { inline_keyboard: opts.inlineKeyboard }; }
      }
      await telegram.sendMessage(chatId, safeHtml, options).catch(()=>{});
      return true;
    }

    // Fallback: if explicit tokens exist, build a simple list message
    if (opts.tokenObjs && opts.tokenObjs.length > 0) {
      try { const mints = opts.tokenObjs.map((t: any) => (t && (t.mint || t.tokenAddress || t.address)) || '<unknown>').slice(0,10); console.log(`[telegramGuard] sending matched-list to=${chatId} count=${opts.tokenObjs.length} sample=${JSON.stringify(mints)}`); } catch(e){}
      let text = `🔔 <b>Matched tokens</b>\nProgram: <code>${(opts.userEvent && opts.userEvent.program) || '-'} </code>\nSignature: <code>${(opts.userEvent && opts.userEvent.signature) || '-'} </code>\n\n`;
      text += `Matched (${opts.tokenObjs.length}):\n`;
      for(const t of opts.tokenObjs.slice(0,10)){
        const raw = (t && (t.mint || t.tokenAddress || t.address)) || '<unknown>';
        text += `• <code>${maskAddr(raw)}</code>\n`;
      }
      text += `\nTime: ${new Date().toISOString()}`;
      const options: any = ({ parse_mode: 'HTML', disable_web_page_preview: true } as any);
      // Remove inline_keyboard URLs that leak addresses unless SHOW_FULL=true
      if(opts.inlineKeyboard){
        try{
          if(!SHOW_FULL){
            const kb = JSON.parse(JSON.stringify(opts.inlineKeyboard));
            for(const row of kb){ for(const btn of row){ try{ if(btn && btn.url){ delete btn.url; btn.callback_data = btn.callback_data || 'share_disabled'; } }catch(e){} } }
            options.reply_markup = { inline_keyboard: kb };
          } else {
            options.reply_markup = { inline_keyboard: opts.inlineKeyboard };
          }
        }catch(e){ /* ignore */ }
      }
      await telegram.sendMessage(chatId, text, options).catch(()=>{});
      return true;
    }

    // Final fallback: send provided fallbackText when no tokens are present
    if (opts.fallbackText && typeof opts.fallbackText === 'string') {
      try { console.log(`[telegramGuard] sending fallbackText to=${chatId} len=${String(opts.fallbackText).length}`); } catch(e){}
      await telegram.sendMessage(chatId, opts.fallbackText).catch(()=>{});
      return true;
    }
    return false;
  }catch(e){ return false; }
}

export default sendNotificationIfExplicit;
