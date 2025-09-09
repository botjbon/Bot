// Small helper to enforce explicit-only token notifications to Telegram
export async function sendNotificationIfExplicit(telegram: any, chatId: any, opts: { html?: string, inlineKeyboard?: any, fallbackText?: string, tokenObjs?: any[], userEvent?: any }){
  try{
    const tokenObjs = Array.isArray(opts && opts.tokenObjs) ? opts.tokenObjs : [];
    // If tokenObjs provided, enforce createdHere === true for every token before sending
    if(tokenObjs.length > 0){
      const explicit = tokenObjs.filter(t => t && t.createdHere === true);
      if(!explicit || explicit.length === 0){
        // Suppress discovery-style notifications when tokens are not explicit
        try{ await telegram.sendMessage(chatId, 'ℹ️ Notification suppressed: only explicit-created tokens are allowed to be sent.'); }catch(e){}
        return false;
      }
      // replace tokenObjs with explicit subset for further rendering
      opts.tokenObjs = explicit;
    }

    // If HTML provided, send that (caller should have built HTML for explicit tokens)
    if(opts.html && typeof opts.html === 'string' && opts.html.length>0){
      const options: any = ({ parse_mode: 'HTML', disable_web_page_preview: false } as any);
      if(opts.inlineKeyboard) options.reply_markup = { inline_keyboard: opts.inlineKeyboard };
      await telegram.sendMessage(chatId, opts.html, options).catch(()=>{});
      return true;
    }

    // Fallback: if explicit tokens exist, build a simple list message
    if(opts.tokenObjs && opts.tokenObjs.length > 0){
      let text = `🔔 <b>Matched tokens</b>\nProgram: <code>${(opts.userEvent && opts.userEvent.program) || '-'} </code>\nSignature: <code>${(opts.userEvent && opts.userEvent.signature) || '-'} </code>\n\n`;
      text += `Matched (${opts.tokenObjs.length}):\n`;
      for(const t of opts.tokenObjs.slice(0,10)) text += `• <code>${t.mint || t.tokenAddress || t.address}</code>\n`;
      text += `\nTime: ${new Date().toISOString()}`;
      await telegram.sendMessage(chatId, text, ({ parse_mode: 'HTML', disable_web_page_preview: true } as any)).catch(()=>{});
      return true;
    }

    // Final fallback: send provided fallbackText when no tokens are present
    if(opts.fallbackText && typeof opts.fallbackText === 'string'){
      await telegram.sendMessage(chatId, opts.fallbackText).catch(()=>{});
      return true;
    }
    return false;
  }catch(e){ return false; }
}

export default sendNotificationIfExplicit;
