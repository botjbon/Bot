



import { fetchDexScreenerTokens } from './src/utils/tokenUtils';
import { saveUsers } from './src/bot/helpers';
import { unifiedBuy, unifiedSell } from './src/tradeSources';

/**
 * Entry point for market monitoring and user notifications
 */
function registerWsNotifications(bot: any, users: Record<string, any>) {
  // Collector batch limit for per-user collector requests
  const collectorBatchLimit = Number(process.env.COLLECTOR_BATCH_LIMIT || 10);

  // Wrap bot.telegram.sendMessage to emit detailed logs for every outgoing message.
  try {
    if (bot && bot.telegram && !bot.telegram.__logging_wrapped) {
      const origSend = bot.telegram.sendMessage.bind(bot.telegram);
      bot.telegram.sendMessage = async function(chatId: any, text: string, opts?: any) {
        try {
          const snippet = (typeof text === 'string') ? text.slice(0, 240) : JSON.stringify(text).slice(0, 240);
          console.log(`[OUTGOING_MESSAGE] to=${chatId} snippet=${snippet.replace(/\n/g,' ')} opts=${opts ? JSON.stringify({ parse_mode: opts.parse_mode, disable_web_page_preview: opts.disable_web_page_preview }) : '{}'} `);
        } catch(e) {}
        try {
          const res = await origSend(chatId, text, opts);
          try { console.log(`[SENT_MESSAGE_OK] to=${chatId} message_id=${res && (res as any).message_id}`); } catch(e){}
          return res;
        } catch (err) {
          try { console.error(`[SENT_MESSAGE_FAIL] to=${chatId} error=${err && (err.message||err)}`); } catch(e){}
          throw err;
        }
      };
      // mark wrapped so we don't double-wrap
      bot.telegram.__logging_wrapped = true;
    }
  } catch (e) {}
  async function pollAndNotify() {
    try {
      // Fetch only Solana tokens, limit to 100, and filter by min liquidity at API level if supported
      const tokens = await fetchDexScreenerTokens('solana', { limit: '100' });
      // Filter tokens: exclude tokens with low liquidity or marked as scam
      // Still filter for scam tokens locally
      const filteredTokens = tokens.filter((token: any) => {
        const notScam = !(token.baseToken?.symbol?.toLowerCase().includes('scam') || token.baseToken?.name?.toLowerCase().includes('scam'));
        return notScam;
      });

      // Import required functions
  const { buildTokenMessage } = await import('./src/utils/tokenUtils');
  const { filterTokensByStrategy } = await import('./src/bot/strategy');
  const { normalizeStrategy } = await import('./src/utils/strategyNormalizer');
      const { extractTradeMeta } = await import('./src/utils/tradeMeta');

      // Import hash and sent-tokens helpers from fastTokenFetcher
      const { hashTokenAddress, readSentHashes, appendSentHash } = await import('./src/fastTokenFetcher');

      for (const userId of Object.keys(users)) {
        const user = users[userId];
        // Robustly check user, wallet, and strategy
        if (!user || !user.wallet || !user.secret || !user.strategy || !user.strategy.enabled) continue;
        // === New behavior: authoritative collector per-user tokens (explicit-only) ===
        // Instead of applying per-user strategy filters up-front, always request the
        // collector's merged payload for this user and only consider tokens the
        // collector marked as explicitly created (createdHere === true).
        let userTokens: any[] = [];
        try {
          const seq = require('./scripts/sequential_10s_per_program.js');
          if (seq && typeof seq.collectFreshMintsPerUser === 'function') {
            const usersObj: Record<string, any> = {};
            usersObj[userId] = user;
            const collected = await seq.collectFreshMintsPerUser(usersObj, { maxCollect: collectorBatchLimit, timeoutMs: Number(process.env.COLLECT_TIMEOUT_MS || 20000), strictOverride: undefined, ageOnly: true, onlyPrintExplicit: true }).catch(() => ({}));
            const payload = collected && collected[userId] ? collected[userId] : null;
            if (payload && Array.isArray(payload.tokens)) {
              userTokens = payload.tokens.slice();
            }
          }
        } catch (e) {
          console.error('[listener] failed to fetch per-user collector tokens:', e && (e.message || e));
          userTokens = [];
        }
        // Enforce explicit-only regardless of per-user strategy differences.
        try{
          const { enforceExplicitTokens } = require('./src/explicit');
          userTokens = enforceExplicitTokens(userTokens || []);
        }catch(e){ userTokens = (userTokens || []).filter((t: any) => Boolean(t && t.createdHere === true)); }
        // Normalize tokens for display and debug-snapshot what we'll send
        try{
          const { normalizeTokenForDisplay } = require('./src/utils/tokenUtils');
          userTokens = userTokens.map((t:any)=> normalizeTokenForDisplay(t));
        }catch(e){}
        // Exclude tokens already sent to this user
        const sentHashes = await readSentHashes(userId);
        userTokens = userTokens.filter(token => {
          const addr = token.mint || token.tokenAddress || token.address || '';
          const hash = hashTokenAddress(addr);
          return addr && !sentHashes.has(hash);
        });
        if (!userTokens || userTokens.length === 0) continue;
        // Limit number of tokens sent per user (respect user's maxTrades if set, else batchLimit)
  const limit = Math.max(1, Number(user.strategy?.maxTrades || collectorBatchLimit));
        const limitedTokens = userTokens.slice(0, limit);
        const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || 'YourBotUsername';
        for (const token of limitedTokens) {
          // Wrap the entire per-token processing in a single block so variables remain in scope
            try {
            // Prefer canonical on-chain mint/address fields and avoid pairAddress when possible
            const addr = token.mint || token.tokenAddress || token.address || '';
            const onlyExplicit = (process.env.ONLY_PRINT_EXPLICIT === 'true' || process.env.ONLY_PRINT_EXPLICIT === '1');
            // If explicit-only mode is enabled, skip any token not explicitly created here
            if (onlyExplicit && !(token && token.createdHere === true)) {
              continue;
            }
            const hash = hashTokenAddress(addr);
            const built = buildTokenMessage(token, botUsername, addr);
            const msg = built && built.msg;
            const inlineKeyboard = built && built.inlineKeyboard;

            // --- AUTO-BUY/SELL/STOP-LOSS LOGIC ---
            try {
              const buyAmount = Number(user.strategy.buyAmount);
              if (!isNaN(buyAmount) && buyAmount > 0 && user.strategy.autoBuy !== false) {
                // Only buy if not already bought (not in sentHashes)
                // Final hard-check against normalized strategy before autoBuy
                const finalStrategy = normalizeStrategy(user.strategy);
                // If strategy requires Jupiter or pump info, attempt lightweight enrichment for this token
                const mint = token.tokenAddress || token.address || token.mint;
                try {
                  const needJupiter = typeof finalStrategy.minJupiterUsd === 'number' || finalStrategy.requireJupiterRoute === true;
                  // pump.fun will be used for enrichment/metadata only; do not require it as a hard filter
                  const needPump = false;
                  if (needJupiter) {
                    const { JUPITER_QUOTE_API } = await import('./src/config');
                    const { getCoinData } = await import('./src/pump/api');
                    const mintLocal = token.tokenAddress || token.address || token.mint;
                    if (needJupiter && JUPITER_QUOTE_API && mintLocal) {
                      try {
                        // default to $50 for quick check if min not set
                        const amountUsd = finalStrategy.minJupiterUsd || 50;
                        const lamports = Math.floor((amountUsd / 1) * 1e9);
                        const url = `${JUPITER_QUOTE_API}?inputMint=So11111111111111111111111111111111111111112&outputMint=${mintLocal}&amount=${lamports}&slippage=1`;
                        const axios = (await import('axios')).default;
                        const r = await axios.get(url, { timeout: 5000 });
                        token.jupiter = r.data;
                      } catch (e) { /* ignore */ }
                    }
                    // optional pump enrichment (non-blocking)
                    try { token.pump = await getCoinData(mint); } catch (e) {}
                  }
                } catch (e) {}
                const finalOk = await filterTokensByStrategy([token], finalStrategy);
                if (!finalOk || finalOk.length === 0) {
                  // skip buy - token does not meet user's strategy anymore
                } else {
                  // Final Jupiter simulation check before executing actual buy
                  try {
                    const { finalJupiterCheck } = await import('./src/utils/tokenUtils');
                    const buyAmt = Number(user.strategy.buyAmount) || 0.01;
                    const jres = await finalJupiterCheck(mint, buyAmt, { minJupiterUsd: finalStrategy.minJupiterUsd, requireRoute: finalStrategy.requireJupiterRoute, timeoutMs: 3000 });
                    if (!jres.ok) {
                      await bot.telegram.sendMessage(userId, `⚠️ Skipped AutoBuy for ${mint}: Jupiter check failed (${jres.reason})`, { parse_mode: 'HTML' });
                    } else {
                      const result = await unifiedBuy(addr, buyAmount, user.secret);
                      const { fee, slippage } = extractTradeMeta(result, 'buy');
                      const resSource = (result as any)?.source ?? 'unknown';
                      const resTx = (result as any)?.tx ?? '';
                      if (!user.history) user.history = [];
                      user.history.push(`AutoBuy: ${addr} | Amount: ${buyAmount} SOL | Source: ${resSource} | Tx: ${resTx} | Fee: ${fee ?? 'N/A'} | Slippage: ${slippage ?? 'N/A'}`);
                      saveUsers(users);
                      let buyMsg = `✅ <b>AutoBuy Executed</b>\nToken: <code>${addr}</code>\nAmount: <b>${buyAmount}</b> SOL\nSource: <b>${resSource}</b>`;
                      if (resTx) buyMsg += `\n<a href='https://solscan.io/tx/${resTx}'>View Tx</a>`;
                      if (fee != null) buyMsg += `\nFee: <b>${fee}</b>`;
                      if (slippage != null) buyMsg += `\nSlippage: <b>${slippage}</b>`;
                      await bot.telegram.sendMessage(userId, buyMsg, { parse_mode: 'HTML', disable_web_page_preview: false });

                      // --- AUTO-SELL/STOP-LOSS LOGIC ---
                      const buyPrice = Number(token.priceUsd || token.price || 0);
                      const profitTargetPercent = Number(user.strategy.profitTargetPercent || user.strategy.sellPercent1 || 0);
                      const stopLossPercent = Number(user.strategy.stopLossPercent || 0);
                      let sold = false;
                      let pollCount = 0;
                      const maxPolls = 60; // e.g. check for 1 hour (60 min)
                      while (!sold && pollCount < maxPolls) {
                        await new Promise(res => setTimeout(res, 60 * 1000)); // 1 min
                        pollCount++;
                        // Fetch latest price
                        const freshTokens = await fetchDexScreenerTokens('solana', { limit: '100' });
                        const fresh = freshTokens.find((t: any) => (t.address || t.tokenAddress || t.mint || '') === addr);
                        if (!fresh) continue;
                        const currentPrice = Number(fresh.priceUsd || fresh.price || 0);
                        if (!currentPrice || !buyPrice) continue;
                        const changePercent = ((currentPrice - buyPrice) / buyPrice) * 100;
                        // Check profit target
                        if (profitTargetPercent && changePercent >= profitTargetPercent) {
                          try {
                            const sellResult = await unifiedSell(addr, buyAmount, user.secret);
                            const { fee: sellFee, slippage: sellSlippage } = extractTradeMeta(sellResult, 'sell');
                            const sellSource = (sellResult as any)?.source ?? 'unknown';
                            const sellTx = (sellResult as any)?.tx ?? '';
                            user.history.push(`AutoSell: ${addr} | Amount: ${buyAmount} SOL | Source: ${sellSource} | Tx: ${sellTx} | Fee: ${sellFee ?? 'N/A'} | Slippage: ${sellSlippage ?? 'N/A'}`);
                            saveUsers(users);
                            let sellMsg = `💰 <b>AutoSell (Profit Target) Executed</b>\nToken: <code>${addr}</code>\nProfit: <b>${changePercent.toFixed(2)}%</b>`;
                            if (sellTx) sellMsg += `\n<a href='https://solscan.io/tx/${sellTx}'>View Tx</a>`;
                            if (sellFee != null) sellMsg += `\nFee: <b>${sellFee}</b>`;
                            if (sellSlippage != null) sellMsg += `\nSlippage: <b>${sellSlippage}</b>`;
                            await bot.telegram.sendMessage(userId, sellMsg, { parse_mode: 'HTML', disable_web_page_preview: false });
                            sold = true;
                            break;
                          } catch (err) {
                            await bot.telegram.sendMessage(userId, `❌ <b>AutoSell Failed</b>\nToken: <code>${addr}</code>\nError: ${(err as Error).message || err}`, { parse_mode: 'HTML' });
                          }
                        }
                        // Check stop loss
                        if (stopLossPercent && changePercent <= -Math.abs(stopLossPercent)) {
                          try {
                            const sellResult = await unifiedSell(addr, buyAmount, user.secret);
                            const { fee: sellFee, slippage: sellSlippage } = extractTradeMeta(sellResult, 'sell');
                            const sellSource = (sellResult as any)?.source ?? 'unknown';
                            const sellTx = (sellResult as any)?.tx ?? '';
                            user.history.push(`AutoSell (StopLoss): ${addr} | Amount: ${buyAmount} SOL | Source: ${sellSource} | Tx: ${sellTx} | Fee: ${sellFee ?? 'N/A'} | Slippage: ${sellSlippage ?? 'N/A'}`);
                            saveUsers(users);
                            let sellMsg = `🛑 <b>AutoSell (Stop Loss) Executed</b>\nToken: <code>${addr}</code>\nLoss: <b>${changePercent.toFixed(2)}%</b>`;
                            if (sellTx) sellMsg += `\n<a href='https://solscan.io/tx/${sellTx}'>View Tx</a>`;
                            if (sellFee != null) sellMsg += `\nFee: <b>${sellFee}</b>`;
                            if (sellSlippage != null) sellMsg += `\nSlippage: <b>${sellSlippage}</b>`;
                            await bot.telegram.sendMessage(userId, sellMsg, { parse_mode: 'HTML', disable_web_page_preview: false });
                            sold = true;
                            break;
                          } catch (err) {
                            await bot.telegram.sendMessage(userId, `❌ <b>AutoSell (Stop Loss) Failed</b>\nToken: <code>${addr}</code>\nError: ${(err as Error).message || err}`, { parse_mode: 'HTML' });
                          }
                        }
                      }
                    }
                  } catch (e) {}
                }
              }
            } catch (err) {
              await bot.telegram.sendMessage(userId, `❌ <b>AutoBuy Failed</b>\nToken: <code>${addr}</code>\nError: ${(err as Error).message || err}`, { parse_mode: 'HTML' });
            }
            // --- END AUTO-BUY/SELL/STOP-LOSS LOGIC ---
            if (msg && typeof msg === 'string') {
              try {
                await bot.telegram.sendMessage(userId, msg, {
                  parse_mode: 'HTML',
                  disable_web_page_preview: false,
                  reply_markup: { inline_keyboard: inlineKeyboard }
                });
                await appendSentHash(userId, hash);
              } catch (err) {
                console.error(`Failed to send message to user ${userId}:`, err);
              }
            }
          } catch (e) {
            console.error('Error processing token in wsListener loop:', e);
            continue;
          }
        }
      }
    } catch (err) {
      console.error('Error in pollAndNotify:', err);
    }
  }
  setInterval(pollAndNotify, 60 * 1000);
  pollAndNotify();
}

export { registerWsNotifications };