// Helper to prevent screens from sending token addresses or performing fetches
export async function sendMessageFiltered(telegram: any, chatId: any, text: string, opts?: any) {
  try {
    // If text contains base58-like addresses, block and log
    const re = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    const found: string[] = [];
    try { let m; while((m = re.exec(String(text))) !== null) { if(m && m[0]) found.push(m[0]); } } catch(e){}
    if (found.length > 0) {
      try { console.warn('[SCREEN_GUARD] blocked sendMessage from screen to=' + String(chatId) + ' found_addrs=' + JSON.stringify(found.slice(0,5))); } catch(e){}
      // send a safe fallback message to the user
      const safe = '⚠️ هذه الرسالة محجوبة لأسباب تتعلق بالأمان. لا تظهر عناوين التوكن من شاشات الواجهة.';
      try { return await telegram.sendMessage(chatId, safe); } catch(e) { return null; }
    }
    return await telegram.sendMessage(chatId, text, opts);
  } catch (e) {
    try { return await telegram.sendMessage(chatId, text, opts); } catch(_) { return null; }
  }
}

export default sendMessageFiltered;
