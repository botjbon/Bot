// Runtime JS guard for sending notifications to Telegram (CommonJS)
async function sendNotificationIfExplicit(telegram, chatId, opts){
  try{
    const tokenObjs = Array.isArray(opts && opts.tokenObjs) ? opts.tokenObjs : [];
    if(tokenObjs.length > 0){
      const explicit = tokenObjs.filter(t => t && t.createdHere === true);
      if(!explicit || explicit.length === 0){
        try{ await telegram.sendMessage(chatId, 'ℹ️ Notification suppressed: only explicit-created tokens are allowed to be sent.'); }catch(e){}
        return false;
      }
      opts.tokenObjs = explicit;
    }

    if(opts.html && typeof opts.html === 'string' && opts.html.length>0){
      const options = ({ parse_mode: 'HTML', disable_web_page_preview: false });
      if(opts.inlineKeyboard) options.reply_markup = { inline_keyboard: opts.inlineKeyboard };
      try{ await telegram.sendMessage(chatId, opts.html, options); }catch(e){}
      return true;
    }

    if(opts.tokenObjs && opts.tokenObjs.length > 0){
      let text = `🔔 <b>Matched tokens</b>\nProgram: <code>${(opts.userEvent && opts.userEvent.program) || '-'} </code>\nSignature: <code>${(opts.userEvent && opts.userEvent.signature) || '-'} </code>\n\n`;
      text += `Matched (${opts.tokenObjs.length}):\n`;
      for(const t of opts.tokenObjs.slice(0,10)) text += `• <code>${t.mint || t.tokenAddress || t.address}</code>\n`;
      text += `\nTime: ${new Date().toISOString()}`;
      try{ await telegram.sendMessage(chatId, text, ({ parse_mode: 'HTML', disable_web_page_preview: true })); }catch(e){}
      return true;
    }

    if(opts.fallbackText && typeof opts.fallbackText === 'string'){
      try{ await telegram.sendMessage(chatId, opts.fallbackText); }catch(e){}
      return true;
    }
    return false;
  }catch(e){ return false; }
}

module.exports = { sendNotificationIfExplicit };
