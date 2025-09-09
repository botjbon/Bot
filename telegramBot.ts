// =================== Imports ===================
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
const fsp = fs.promises;
import { Telegraf, Markup } from 'telegraf';
import { loadUsers, loadUsersSync, saveUsers, walletKeyboard, getErrorMessage, limitHistory, hasWallet, writeJsonFile } from './src/bot/helpers';
import { unifiedBuy, unifiedSell } from './src/tradeSources';
import { filterTokensByStrategy, registerBuyWithTarget, monitorAndAutoSellTrades } from './src/bot/strategy';
import { autoExecuteStrategyForUser } from './src/autoStrategyExecutor';
import { STRATEGY_FIELDS, notifyUsers, withTimeout, buildBulletedMessage } from './src/utils/tokenUtils';
import { buildPreviewMessage } from './src/utils/tokenUtils';
// Background enrich/queue disabled: listener-only operation per user requirement.
import { registerBuySellHandlers } from './src/bot/buySellHandlers';
import { normalizeStrategy } from './src/utils/strategyNormalizer';
// fast token fetcher disabled: listener-only operation
import { generateKeypair, exportSecretKey, parseKey } from './src/wallet';

// Install a small console filter to suppress noisy 429/retry messages coming from HTTP libs
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
const _origLog = console.log.bind(console);
const _filterRegex = /(Server responded with 429 Too Many Requests|Retrying after|Too Many Requests|entering cooldown)/i;
console.warn = (...args: any[]) => {
  try {
    const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (_filterRegex.test(s)) return; // drop noisy retry/429 lines
  } catch (e) {}
  _origWarn(...args);
};
console.error = (...args: any[]) => {
  try {
    const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (_filterRegex.test(s)) return;
  } catch (e) {}
  _origError(...args);
};
console.log = (...args: any[]) => {
  try {
    const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (_filterRegex.test(s)) return;
  } catch (e) {}
  _origLog(...args);
};

console.log('--- Bot starting: Imports loaded ---');

dotenv.config();

// Configuration values (can be overridden via .env)
const HELIUS_BATCH_SIZE = Number(process.env.HELIUS_BATCH_SIZE ?? 8);
const HELIUS_BATCH_DELAY_MS = Number(process.env.HELIUS_BATCH_DELAY_MS ?? 250);
const HELIUS_ENRICH_LIMIT = Number(process.env.HELIUS_ENRICH_LIMIT ?? 25);
const ONCHAIN_FRESHNESS_TIMEOUT_MS = Number(process.env.ONCHAIN_FRESHNESS_TIMEOUT_MS ?? 5000);
console.log('--- dotenv loaded ---');
// Global default: show-token and notify should apply age-only filtering by default.
// Can be overridden per-user by setting user.strategy.ageOnly = false
const GLOBAL_AGE_ONLY_DEFAULT = (process.env.GLOBAL_AGE_ONLY_DEFAULT === undefined) ? true : (String(process.env.GLOBAL_AGE_ONLY_DEFAULT).toLowerCase() === 'true');
// Enforce listener-only safe mode: when true, avoid making disk-based reads/writes in active user paths.
// Controlled via env LISTENER_ONLY_MODE or LISTENER_ONLY. Default to true.
const LISTENER_ONLY_MODE = String(process.env.LISTENER_ONLY_MODE ?? process.env.LISTENER_ONLY ?? 'true').toLowerCase() === 'true';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_TOKEN);
if (!TELEGRAM_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not found in .env file. Please add TELEGRAM_BOT_TOKEN=YOUR_TOKEN to .env');
  process.exit(1);
}
const bot = new Telegraf(TELEGRAM_TOKEN);
console.log('--- Telegraf instance created ---');
let users: Record<string, any> = {};
console.log('--- Users placeholder created ---');
let boughtTokens: Record<string, Set<string>> = {};
const restoreStates: Record<string, boolean> = {};
let listenerStarted = false;

async function ensureListenerStarted() {
  try {
    if (listenerStarted) return;
    // start listener in background but do not block caller
    const seq = require('./scripts/sequential_10s_per_program.js');
    if (seq && typeof seq.startSequentialListener === 'function') {
      (async () => {
        try {
          // Request explicit-only terminal behavior when started from the running bot
          await seq.startSequentialListener({ onlyPrintExplicit: true });
        } catch (e) {
          try { console.error('[listener] failed to start (lazy):', e && (e.message || e)); } catch(_){ }
        }
      })();
      listenerStarted = true;
      console.log('[listener] lazy startSequentialListener invoked');
    }
  } catch (e) {
    try { console.warn('ensureListenerStarted error:', e); } catch(_){}
  }
}

// Helper: decide if a given user should operate in listener-only (no enrichment) mode.
function userIsListenerOnly(user: any) {
  try {
    if (LISTENER_ONLY_MODE) return true;
    if (!user) return false;
    const strat = user.strategy || {};
    if (strat && (strat.noEnrich === true || strat.listenerOnly === true)) return true;
    return false;
  } catch (e) { return Boolean(LISTENER_ONLY_MODE); }
}

async function getTokensForUser(userId: string, strategy: Record<string, any> | undefined) {
  // Listener-only token source: always use the program-listener collector
  try {
    // Convert strategy.maxTrades -> maxCollect
    const maxCollect = Math.max(1, Number(strategy?.maxTrades || 3));
    // Convert strategy age to maxAgeSec (seconds). Prefer normalized field when available.
    let maxAgeSec: number | undefined = undefined;
    try {
      if (strategy && (strategy as any).maxAgeSec !== undefined) {
        const n = Number((strategy as any).maxAgeSec);
        if (!isNaN(n)) maxAgeSec = n;
      } else {
        const ma = strategy && (strategy as any).minAge;
        if (ma !== undefined && ma !== null) {
          const parseDuration = require('./src/utils/tokenUtils').parseDuration;
          const parsed = parseDuration(ma);
          if (!isNaN(Number(parsed)) && parsed !== undefined && parsed !== null) maxAgeSec = Number(parsed);
        }
      }
    } catch (e) {}
    // Require the sequential listener collector and use it as the sole source
    // of tokens. This avoids any external API or cache usage.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const seq = require('./scripts/sequential_10s_per_program.js');
    if (!seq || typeof seq.collectFreshMints !== 'function') return [];
  const strictOverride = (strategy && (strategy as any).collectorStrict !== undefined) ? Boolean((strategy as any).collectorStrict) : undefined;
  // Do not pass per-user age into the centralized collector. Discover explicit mints first,
  // then apply per-user age filtering below. Force collector to run in explicit-only mode
  // so we don't receive non-explicit tokens.
  const items = await seq.collectFreshMints({ maxCollect, strictOverride, onlyPrintExplicit: true }).catch(() => []);
    if (!Array.isArray(items) || items.length === 0) return [];
    // Filter collector results: only include explicit-created mints when available
    const isCreatedHelper = seq && typeof seq.isMintCreatedInThisTx === 'function' ? seq.isMintCreatedInThisTx : null;
    const explicitOnlyFiltered = (items || []).filter((it: any) => {
      try{
        if(!it) return false;
        // Reject simple-string fallbacks: require explicit creation evidence
  if(typeof it === 'string') return false;
  // Only accept items that the collector explicitly marked as createdHere.
  // Do NOT attempt a log-only or heuristic fallback here when explicit-only mode
  // is requested; this enforces the user's requirement that only explicit-created
  // mints appear in the terminal and to users.
  return Boolean(it.createdHere === true);
      }catch(e){ return false; }
    });
  // Respect user's maxTrades (maxCollect) — slice to desired count
  const desiredCount = Math.max(1, Number(strategy?.maxTrades || 3));
  const tokens = (explicitOnlyFiltered || []).slice(0, desiredCount).map((it: any) => {
      if (!it) return null;
      if (typeof it === 'string') return { tokenAddress: it, address: it, mint: it, sourceCandidates: true, __listenerCollected: true };
      const addr = it.tokenAddress || it.address || it.mint || null;
      return Object.assign({ tokenAddress: addr, address: addr, mint: addr, sourceCandidates: true, __listenerCollected: true }, it);
    }).filter(Boolean);
    // If user specified a minAge, enforce it strictly here (same semantics as listener)
    try{
      const parseDuration = require('./src/utils/tokenUtils').parseDuration;
      // prefer normalized maxAgeSec when available, otherwise parse legacy minAge
      let maxAgeSeconds: number | undefined = undefined;
      if (strategy && (strategy as any).maxAgeSec !== undefined) {
        const n = Number((strategy as any).maxAgeSec);
        if (!isNaN(n)) maxAgeSeconds = n;
      } else {
        const ma = strategy && (strategy as any).minAge;
        const parsed = ma !== undefined && ma !== null ? parseDuration(ma) : undefined;
        if (!isNaN(Number(parsed)) && parsed !== undefined && parsed !== null) maxAgeSeconds = Number(parsed);
      }
      if (!isNaN(Number(maxAgeSeconds)) && maxAgeSeconds !== undefined && maxAgeSeconds !== null && Number(maxAgeSeconds) > 0) {
        const accepted = tokens.filter((t: any) => {
          try{
            // prefer _canonicalAgeSeconds (seconds)
            let ageSec: number | undefined = undefined;
            if (t && t._canonicalAgeSeconds !== undefined && t._canonicalAgeSeconds !== null) ageSec = Number(t._canonicalAgeSeconds);
            else if (t && t.ageSeconds !== undefined && t.ageSeconds !== null) ageSec = Number(t.ageSeconds);
            else if (t && t.firstBlockTime) {
              const ftMs = Number(t.firstBlockTime);
              if (!isNaN(ftMs) && ftMs > 0) ageSec = (Date.now() - ftMs) / 1000;
            }
            if (ageSec === undefined || isNaN(ageSec)) return false; // strict: require known on-chain age
            // Accept tokens younger or equal to the max allowed age
            return ageSec <= Number(maxAgeSeconds);
          }catch(e){ return false; }
        });
        return accepted;
      }
    }catch(e){}
    return tokens;
  } catch (e) {
    console.error('[getTokensForUser] listener fetch failed:', e?.message || e);
    return [];
  }
}

// Strategy state machine for interactive setup (single declaration)
const userStrategyStates: Record<string, { step: number, values: Record<string, any>, phase?: string, tradeSettings?: Record<string, any> }> = {};

// buy/sell handlers will be registered after users are loaded in startup sequence

bot.command('auto_execute', async (ctx) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  console.log(`[auto_execute] User: ${userId}`);
  if (!user || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('You must set a strategy first using /strategy');
    return;
  }
  const now = Date.now();
  const tokens = await getTokensForUser(userId, user.strategy);
  await ctx.reply('Executing your strategy on matching tokens...');
  try {
    await autoExecuteStrategyForUser(user, tokens, 'buy');
    await ctx.reply('Strategy executed successfully!');
  } catch (e: any) {
    await ctx.reply('Error during auto execution: ' + getErrorMessage(e));
  }
});

const mainReplyKeyboard = Markup.keyboard([
  ['💼 Wallet', '⚙️ Strategy'],
  ['📊 Show Tokens', '🤝 Invite Friends']
]).resize();

// Add a quick toggle button for collector strictness to main keyboard if desired
function collectorToggleKeyboard(user: any) {
  try{
    const cur = user && user.strategy && (user.strategy as any).collectorStrict;
    const label = cur === false ? 'Collector: Defer' : (cur === true ? 'Collector: Strict' : 'Collector: Default');
    return Markup.keyboard([
      ['💼 Wallet', '⚙️ Strategy'],
      ['📊 Show Tokens', '🤝 Invite Friends'],
      [label]
    ]).resize();
  }catch(e){ return mainReplyKeyboard; }
}

bot.start(async (ctx) => {
  await ctx.reply(
    '👋 Welcome to the Trading Bot!\nPlease choose an option:',
    mainReplyKeyboard
  );
});

bot.hears('💼 Wallet', async (ctx) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  console.log(`[💼 Wallet] User: ${userId}`);
  if (user && hasWallet(user)) {
    const { getSolBalance } = await import('./src/getSolBalance');
    let balance = 0;
    try {
      balance = await getSolBalance(user.wallet);
    } catch {}
    await ctx.reply(
    `💼 Your Wallet:\nAddress: <code>${user.wallet}</code>\nBalance: <b>${balance}</b> SOL`,
      ({
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [ { text: '👁️ Show Private Key', callback_data: 'show_secret' } ]
          ]
        }
      } as any)
    );
  } else {
    await ctx.reply('❌ No wallet found for this user.', walletKeyboard());
  }
});

bot.action('show_secret', async (ctx) => {
  console.log(`[show_secret] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (user && hasWallet(user)) {
    // For security, do not send the private key in chat. Prompt the user to restore or view locally.
    await ctx.reply('🔒 For your safety the private key is not shown in chat. Use /restore_wallet to restore from your key or manage your wallet locally.');
  } else {
    await ctx.reply('❌ No wallet found for this user.');
  }
});

bot.hears('⚙️ Strategy', async (ctx) => {
  console.log(`[⚙️ Strategy] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  userStrategyStates[userId] = { step: 0, values: {} };
  await ctx.reply('🚦 Strategy Setup:\nPlease enter the required value for each field. Send "skip" to skip any optional field.');
  const field = STRATEGY_FIELDS[0];
  await ctx.reply(`📝 ${field.label}${field.optional ? ' (optional)' : ''}`);
});

bot.hears('📊 Show Tokens', async (ctx) => {
  console.log(`[📊 Show Tokens] User: ${String(ctx.from?.id)}`);
  // Use the sequential listener's per-user collector to return an authoritative merged payload.
  try {
  // Ensure the background listener is running (lazy start on first demand)
  try { await ensureListenerStarted(); } catch (e) { /* ignore */ }
    const userId = String(ctx.from?.id);
    const user = users[userId] || {};
  // Determine effective age-only mode: per-user override or global default
  const ageOnlyMode = (user && user.strategy && (user.strategy as any).ageOnly !== undefined) ? Boolean((user.strategy as any).ageOnly) : GLOBAL_AGE_ONLY_DEFAULT;
    // Build options for collector from user's strategy
    const maxCollect = Math.max(1, Number(user.strategy?.maxTrades || 3));
    const strictOverride = (user && user.strategy && (user.strategy as any).collectorStrict !== undefined) ? Boolean((user.strategy as any).collectorStrict) : undefined;
    // Require the sequential listener module and its per-user helper
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const seq = require('./scripts/sequential_10s_per_program.js');
    if (!seq || typeof seq.collectFreshMintsPerUser !== 'function') {
      await ctx.reply('⚠️ Live listener not available right now; please try again later.');
      return;
    }
    // Run a single collection pass and get the merged payload for this user only
    const usersObj: Record<string, any> = {};
    usersObj[userId] = user;
  const collected = await seq.collectFreshMintsPerUser(usersObj, { maxCollect, timeoutMs: Number(process.env.COLLECT_TIMEOUT_MS || 20000), strictOverride, ageOnly: ageOnlyMode, onlyPrintExplicit: true }).catch(() => ({}));
    const payload = collected && collected[userId] ? collected[userId] : null;
    if (!payload || !Array.isArray(payload.tokens) || payload.tokens.length === 0) {
      await ctx.reply('No live tokens found right now. Try again in a few seconds.');
      return;
    }
  // Only show tokens that the collector marked as createdHere (explicit-created)
  const explicitTokens = (payload.tokens || []).filter((t:any) => t && t.createdHere === true);
  if (!explicitTokens || explicitTokens.length === 0) {
    await ctx.reply('No explicit-created live tokens found right now. Try again in a few seconds.');
    return;
  }
  // Render the merged tokens payload (up to user's maxTrades) using the bulleted template
  const tokens = explicitTokens.slice(0, Math.max(1, Number(user.strategy?.maxTrades || 3)));
  const { text, inline_keyboard } = buildBulletedMessage(tokens, { cluster: process.env.SOLANA_CLUSTER, title: 'Live tokens (listener)', maxShow: tokens.length });
  // Log the bulleted message and keyboard for offline review/debugging before replying
  try {
    const tag = `[SHOW_TOKENS_MSG user=${userId}]`;
    console.log(tag, text);
    try { console.log(tag + ' inline_keyboard:', JSON.stringify(inline_keyboard, null, 2)); } catch (e) { console.log(tag + ' inline_keyboard (stringify failed)'); }
  } catch (e) { /* ignore logging errors */ }
  await ctx.reply(text, ({ parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard } } as any));
  } catch (e) {
    console.error('[show_tokens] error', e && (e.message || e));
    try { await ctx.reply('Error fetching live tokens.'); } catch(_){}
  }
});

bot.hears('🤝 Invite Friends', async (ctx) => {
  console.log(`[🤝 Invite Friends] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const inviteLink = `https://t.me/${ctx.me}?start=${userId}`;
  await ctx.reply(`🤝 Share this link to invite your friends:\n${inviteLink}`);
});

bot.hears(/Collector:\s*(Strict|Defer|Default)/i, async (ctx) => {
  const userId = String(ctx.from?.id);
  const user = users[userId] || {};
  const cur = user.strategy && (user.strategy as any).collectorStrict;
  // cycle: undefined -> false -> true -> undefined
  let next: any = undefined;
  if (cur === undefined) next = false;
  else if (cur === false) next = true;
  else next = undefined;
  if (!user.strategy) user.strategy = {};
  (user.strategy as any).collectorStrict = next;
  users[userId] = user;
  try { saveUsers(users); } catch (e) {}
  const label = next === false ? 'Collector: Defer' : (next === true ? 'Collector: Strict' : 'Collector: Default');
  await ctx.reply(`Collector strictness set to: ${label}`);
  try { await ctx.reply('Keyboard updated', collectorToggleKeyboard(user)); } catch (e) {}
});

bot.command('toggle_collector_strict', async (ctx) => {
  const userId = String(ctx.from?.id);
  const user = users[userId] || {};
  const cur = user.strategy && (user.strategy as any).collectorStrict;
  let next: any = undefined;
  if (cur === undefined) next = false;
  else if (cur === false) next = true;
  else next = undefined;
  if (!user.strategy) user.strategy = {};
  (user.strategy as any).collectorStrict = next;
  users[userId] = user;
  try { saveUsers(users); } catch (e) {}
  const label = next === false ? 'Defer' : (next === true ? 'Strict' : 'Default');
  await ctx.reply(`collectorStrict toggled to: ${label}`);
});

bot.command('notify_tokens', async (ctx) => {
  console.log(`[notify_tokens] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  // effective age-only mode (per-user override or global default)
  const ageOnlyMode = (user && user.strategy && (user.strategy as any).ageOnly !== undefined) ? Boolean((user.strategy as any).ageOnly) : GLOBAL_AGE_ONLY_DEFAULT;
  if (!user || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ You must set a strategy first using /strategy');
    return;
  }
  const now = Date.now();
  const tokens = await getTokensForUser(userId, user.strategy);
    let filteredTokens: any[] = [];
    try {
      if (ageOnlyMode) {
        // Age-only mode: accept listener candidates and skip heavy filtering
        filteredTokens = tokens.slice(0, Math.max(1, Number(user.strategy?.maxTrades || 3)));
      } else if (userIsListenerOnly(user)) {
        // Preserve the listener-provided candidates without background enrichment
        filteredTokens = tokens.slice(0, Math.max(1, Number(user.strategy?.maxTrades || 3)));
      } else {
        filteredTokens = await (require('./src/bot/strategy').filterTokensByStrategy(tokens, user.strategy, { preserveSources: true }));
      }
    } catch (e) {
      console.error('[notify_tokens] filtering failed:', e);
      filteredTokens = [];
    }
  if (!filteredTokens.length) {
    await ctx.reply('No tokens currently match your strategy.');
    return;
  }
  await notifyUsers(ctx.telegram, { [userId]: user }, filteredTokens);
  await ctx.reply('✅ Notification sent for tokens matching your strategy.');
});



// buy/sell handlers are centralized in src/bot/buySellHandlers.ts via registerBuySellHandlers


bot.command('wallet', async (ctx) => {
  console.log(`[wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (user && hasWallet(user)) {
  await ctx.reply('� You have a wallet configured. For security the private key is not displayed. Use the inline button "Show Private Key" if absolutely needed, or /restore_wallet to restore from your secret.');
  } else {
    await ctx.reply('❌ No wallet found for this user.', walletKeyboard());
  }
});


bot.command(['create_wallet', 'restore_wallet'], async (ctx) => {
  console.log(`[${ctx.message.text.startsWith('/restore_wallet') ? 'restore_wallet' : 'create_wallet'}] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  let user = users[userId];
  if (!user) {
    user = {};
    users[userId] = user;
  }
  let keypair, secret;
  if (ctx.message.text.startsWith('/restore_wallet')) {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
      await ctx.reply('❗ Please provide the private key after the command. Example: /restore_wallet <secret>');
      return;
    }
    try {
      keypair = parseKey(parts[1]);
      secret = exportSecretKey(keypair);
    } catch (e) {
      await ctx.reply('❌ Failed to restore wallet. Invalid key.');
      return;
    }
  } else {
    keypair = generateKeypair();
    secret = exportSecretKey(keypair);
  }
  user.secret = secret;
  user.wallet = keypair.publicKey?.toBase58?.() || keypair.publicKey;
  saveUsers(users);
  await ctx.reply('✅ Wallet ' + (ctx.message.text.startsWith('/restore_wallet') ? 'restored' : 'created') + ' successfully!\nAddress: <code>' + user.wallet + '</code>\nPrivate key (keep it safe): <code>' + user.secret + '</code>', { parse_mode: 'HTML' });
});


async function notifyAutoSell(user: any, sellOrder: any) {
  console.log(`[notifyAutoSell] User: ${user?.id || user?.userId || user?.telegramId}, Token: ${sellOrder.token}, Amount: ${sellOrder.amount}, Status: ${sellOrder.status}`);
  try {
    const chatId = user.id || user.userId || user.telegramId;
    let msg = `✅ Auto-sell order executed:\n`;
    msg += `Token: ${sellOrder.token}\nAmount: ${sellOrder.amount}\nTarget price: ${sellOrder.targetPrice}\n`;
    msg += sellOrder.tx ? `Transaction: ${sellOrder.tx}\n` : '';
    msg += sellOrder.status === 'success' ? 'Executed successfully.' : 'Execution failed.';
    await bot.telegram.sendMessage(chatId, msg);
  } catch {}
}

setInterval(async () => {
  console.log(`[monitorAndAutoSellTrades] Interval triggered`);
  if (!users || typeof users !== 'object') return;
  for (const userId in users) {
    if (!userId || userId === 'undefined') {
      console.warn('[monitorAndAutoSellTrades] Invalid userId, skipping.');
      continue;
    }
  const user = users[userId];
  const tokensForUser = await getTokensForUser(userId, user?.strategy);
  await monitorAndAutoSellTrades(user, tokensForUser);
    const sentTokensDir = process.cwd() + '/sent_tokens';
    const userFile = `${sentTokensDir}/${userId}.json`;
    try {
      if (LISTENER_ONLY_MODE) {
        // In listener-only mode avoid reading user sent_tokens files on disk.
        // Assume in-memory/Redis suppression is handled elsewhere.
      } else {
        if (!(await fsp.stat(userFile).catch(() => false))) continue;
      }
    } catch {
      continue;
    }
    let userTrades: any[] = [];
    try {
      if (!LISTENER_ONLY_MODE) {
        const data = await fsp.readFile(userFile, 'utf8');
        userTrades = JSON.parse(data || '[]');
      } else {
        userTrades = [];
      }
    } catch {}
    const executed = userTrades.filter((t: any) => t.mode === 'sell' && t.status === 'success' && t.auto && !t.notified);
    for (const sellOrder of executed) {
      await notifyAutoSell(user, sellOrder);
      (sellOrder as any).notified = true;
    }
    try {
  if (!LISTENER_ONLY_MODE) await writeJsonFile(userFile, userTrades);
    } catch (e) {
      console.error('[monitorAndAutoSellTrades] Failed to write user trades for', userFile, e);
    }
  }
}, 5 * 60 * 1000);


// ========== Interactive wallet buttons ==========
bot.action('create_wallet', async (ctx) => {
  console.log(`[create_wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  let user = users[userId];
  if (!user) {
    user = {};
    users[userId] = user;
  }
    // Prevent creating a wallet if one already exists
    if (user.secret && user.wallet) {
      await ctx.reply('You already have a wallet! You can view it from the menu.');
      return;
  }
  const keypair = generateKeypair();
  const secret = exportSecretKey(keypair);
  user.secret = secret;
  user.wallet = keypair.publicKey?.toBase58?.() || keypair.publicKey;
  saveUsers(users);
  await ctx.reply(`✅ Wallet created successfully!\nAddress: <code>${user.wallet}</code>\nPrivate key (keep it safe): <code>${user.secret}</code>`, ({ parse_mode: 'HTML' } as any));
});

bot.action('restore_wallet', async (ctx) => {
  console.log(`[restore_wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  restoreStates[userId] = true;
  await ctx.reply('🔑 Please send your wallet private key in a private message now:');
});

bot.on('text', async (ctx, next) => {
  console.log(`[text] User: ${String(ctx.from?.id)}, Message: ${ctx.message.text}`);
  const userId = String(ctx.from?.id);

  // 1) Wallet restore flow
  if (restoreStates[userId]) {
    const secret = ctx.message.text.trim();
    try {
      const keypair = parseKey(secret);
      let user = users[userId] || {};
      user.secret = exportSecretKey(keypair);
      user.wallet = keypair.publicKey?.toBase58?.() || keypair.publicKey;
      users[userId] = user;
      saveUsers(users);
      delete restoreStates[userId];

  await ctx.reply(`✅ Wallet restored successfully!\nAddress: <code>${user.wallet}</code>\nPrivate key stored securely.`, ({ parse_mode: 'HTML' } as any));
    } catch {
      await ctx.reply('❌ Failed to restore wallet. Invalid key. Try again or create a new wallet.');
    }
    return;
  }

  // 2) Interactive strategy setup flow
  if (userStrategyStates[userId]) {
    const state = userStrategyStates[userId];
    // Trade settings phase
    if (state.phase === 'tradeSettings') {
      const tradeFields = [
        { key: 'buyAmount', label: 'Buy amount per trade (SOL)', type: 'number' },
        { key: 'sellPercent1', label: 'Sell percent for first target (%)', type: 'number' },
        { key: 'target1', label: 'Profit target 1 (%)', type: 'number' },
        { key: 'sellPercent2', label: 'Sell percent for second target (%)', type: 'number' },
        { key: 'target2', label: 'Profit target 2 (%)', type: 'number' },
        { key: 'stopLoss', label: 'Stop loss (%)', type: 'number' },
        { key: 'maxTrades', label: 'Max concurrent trades', type: 'number' }
      ];
      if (state.step >= tradeFields.length) {
        delete userStrategyStates[userId];
        return;
      }
      const current = tradeFields[state.step];
      let value: any = ctx.message.text.trim();
      const numValue = Number(value);
      if (isNaN(numValue)) {
        await ctx.reply('❗ Please enter a valid number.');
        return;
      }
      value = numValue;
      if (!state.tradeSettings) state.tradeSettings = {};
      state.tradeSettings[current.key] = value;
      state.step++;
      if (state.step < tradeFields.length) {
        await ctx.reply(`📝 ${tradeFields[state.step].label}`);
      } else {
        if (!users[userId]) users[userId] = {};
        users[userId].strategy = normalizeStrategy({ ...state.values, ...state.tradeSettings, enabled: true });
        saveUsers(users);
        delete userStrategyStates[userId];
        await ctx.reply('✅ Strategy and trade settings saved successfully! You can now press "📊 Show Tokens" to see matching tokens and trades.');
      }
      return;
    }

    // Main strategy fields phase
    if (state.step >= STRATEGY_FIELDS.length) {
      delete userStrategyStates[userId];
      return;
    }
    const field = STRATEGY_FIELDS[state.step];
    let value: any = ctx.message.text.trim();
    if (value === 'skip' && field.optional) {
      value = undefined;
    } else if (field.type === 'number') {
      const numValue = Number(value);
      if (isNaN(numValue)) {
        await ctx.reply('❗ Please enter a valid number.');
        return;
      }
      value = numValue;
    }
    state.values[field.key] = value;
    state.step++;
    if (state.step < STRATEGY_FIELDS.length) {
      const nextField = STRATEGY_FIELDS[state.step];
      await ctx.reply(`📝 ${nextField.label}${nextField.optional ? ' (optional)' : ''}`);
    } else {
      state.step = 0;
      state.phase = 'tradeSettings';
      state.tradeSettings = {};
      await ctx.reply('⚙️ Trade settings:\nPlease enter the buy amount per trade (SOL):');
    }
    return;
  }

  if (typeof next === 'function') return next();
});

  // Note: strategy state handlers are registered earlier to avoid duplicate registrations


// =================== Bot Launch ===================
console.log('--- About to launch bot ---');
(async () => {
  try {
    // Load users from disk before registering handlers and launching
    try {
      users = await loadUsers();
      console.log('--- Users loaded (async) ---');
      // If running in listener-only mode or SKIP_BOT_LAUNCH, start the sequential listener immediately
      try{
        if (LISTENER_ONLY_MODE || process.env.SKIP_BOT_LAUNCH === 'true') {
          console.log('[startup] listener-only mode detected; starting sequential listener now');
          try { await ensureListenerStarted(); } catch(e){ console.error('[startup] ensureListenerStarted failed:', e && (e.message||e)); }
        }
      }catch(e){}
  // startEnrichQueue disabled: listener is the only allowed source

      // Disable background file/redis polling notification pump. Instead listen to
      // in-process notifier events emitted by the listener and deliver messages
      // immediately to users (no central caches or disk reads).
      try {
  // in-memory suppression map (userId -> Map(addr -> lastSentTs))
  const sentNotifications: Record<string, Map<string, number>> = {};
        const suppressionMinutes = Number(process.env.NOTIF_SUPPRESSION_MINUTES ?? 1);
        const suppressionMs = Math.max(0, suppressionMinutes) * 60 * 1000;
        // require the exported notifier from the listener script (if it's loaded in-process)
        let listenerNotifier: any = null;
        try{ const seqMod = require('./scripts/sequential_10s_per_program.js'); listenerNotifier = seqMod && seqMod.notifier ? seqMod.notifier : null; }catch(e){}
        // register handler on the exported notifier if present
        if(listenerNotifier && typeof listenerNotifier.on === 'function'){
          listenerNotifier.on('notification', async (userEvent:any) => {
            try{
              const uid = String(userEvent && userEvent.user);
              if(!uid) return;
              const user = users[uid]; if(!user || !user.strategy || user.strategy.enabled === false) return;
              if(!sentNotifications[uid]) sentNotifications[uid] = new Map();
              // Use authoritative tokens provided by the collector (userEvent.tokens).
              // These should be the canonical, filtered set; enforce defensive checks here.
              const maxTrades = Number(user.strategy?.maxTrades || 3) || 3;
              // Always prefer only explicit-created tokens from the collector for listener notifications.
              let tokenObjs = Array.isArray(userEvent.tokens) ? userEvent.tokens.slice(0, maxTrades) : [];
              try { tokenObjs = (tokenObjs || []).filter((t:any)=> t && t.createdHere === true); } catch(e){}
              // Log the incoming notification payload for debugging
              try { console.log(`[NOTIF_IN] user=${uid} program=${userEvent && userEvent.program} signature=${userEvent && userEvent.signature} tokens=${tokenObjs.length}`); } catch(e){}
              const matchAddrs = tokenObjs.map((t:any) => t && (t.tokenAddress || t.address || t.mint)).filter(Boolean);
              const toSend = [] as string[];
              for (const a of matchAddrs) {
                const last = sentNotifications[uid].get(a) || 0;
                if (suppressionMs > 0 && (Date.now() - last) < suppressionMs) continue;
                toSend.push(a);
              }
              if(toSend.length===0) return;
              // prefer pre-built HTML payload if present; otherwise build a bulleted message here
              try{
                const chatId = uid;
                let html = userEvent && userEvent.html;
                let inlineKeyboard = userEvent && userEvent.inlineKeyboard;
                // If HTML missing, try to build a bulleted message from tokens using tokenUtils
        if((!html || typeof html !== 'string' || html.length===0) && tokenObjs && tokenObjs.length > 0){
                  try{
                    const tu = require('./src/utils/tokenUtils');
                    if(tu && typeof tu.buildBulletedMessage === 'function'){
                      const cluster = process.env.SOLANA_CLUSTER || 'mainnet';
                      const title = `Live tokens (listener)`;
          const built = tu.buildBulletedMessage(tokenObjs, { cluster, title, maxShow: Math.min(10, tokenObjs.length) });
          if(built && built.text) html = built.text;
          if(built && built.inline_keyboard) inlineKeyboard = built.inline_keyboard;
                    }
                  }catch(e){}
                }
                if(html && typeof html === 'string' && html.length>0){
                  const options: any = ({ parse_mode: 'HTML', disable_web_page_preview: false } as any);
                  if(inlineKeyboard) options.reply_markup = { inline_keyboard: inlineKeyboard };
                  // Log outgoing built payload for review
                  try { console.log(`[NOTIF_OUT] user=${uid} html_len=${html.length} inline_kb=${inlineKeyboard ? JSON.stringify(inlineKeyboard).slice(0,200) : 'none'}`); } catch(e){}
                  await (bot.telegram as any).sendMessage(chatId, html, options).catch((err:any)=>{ console.error('[NOTIF_SEND_ERR]', err && (err.message||err)); });
                } else {
                  // fallback: simple list message
                  let text = `🔔 <b>Matched tokens for your strategy</b>\nProgram: <code>${userEvent.program}</code>\nSignature: <code>${userEvent.signature}</code>\n\n`;
                  text += `Matched (${toSend.length}):\n`;
                  for(const a of toSend.slice(0,10)) text += `• <code>${a}</code>\n`;
                  text += `\nTime: ${new Date().toISOString()}`;
                  try { console.log(`[NOTIF_OUT_FALLBACK] user=${uid} text_snippet=${text.slice(0,200).replace(/\n/g,' ')}`); } catch(e){}
                  await (bot.telegram as any).sendMessage(chatId, text, ({ parse_mode: 'HTML', disable_web_page_preview: true } as any)).catch((err:any)=>{ console.error('[NOTIF_SEND_ERR]', err && (err.message||err)); });
                }
                for(const a of toSend) sentNotifications[uid].set(a, Date.now());
              }catch(e){ /* swallow */ }
            }catch(e){ /* swallow per-event errors */ }
          });
        }
        // also drain in-memory queues (if listener and bot are same process) at startup
        try{
          const q = (global as any).__inMemoryNotifQueues;
          if(q && q instanceof Map){
            for(const [k, arr] of q.entries()){
              try{
                const items = Array.isArray(arr) ? arr.slice(0) : [];
                for(const it of items.reverse()){
                  try{ listenerNotifier && listenerNotifier.emit && listenerNotifier.emit('notification', it); }catch(e){}
                }
                // clear after drain
                q.set(k, []);
              }catch(e){}
            }
          }
        }catch(e){}
        // Optionally start a Redis consumer loop if REDIS_URL provided (cross-process delivery)
        try{
          const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_URI || null;
          if(REDIS_URL){
            (async function startRedisConsumer(){
              try{
                const { createClient } = require('redis');
                const rc = createClient({ url: REDIS_URL });
                rc.on && rc.on('error', ()=>{});
                await rc.connect().catch(()=>{});
                const pollInterval = Number(process.env.NOTIF_REDIS_POLL_MS || 1000);
                while(true){
                  try{
                    // iterate users map keys and BRPOP each list with 1s timeout
                    for(const uid of Object.keys(users || {})){
                      try{
                        const key = `listener:notifications:${uid}`;
                        const res = await rc.rPop(key).catch(()=>null);
                        if(res){
                          try{ const payload = JSON.parse(res); listenerNotifier && listenerNotifier.emit && listenerNotifier.emit('notification', payload); }catch(e){}
                        }
                      }catch(e){}
                    }
                    await new Promise(r=>setTimeout(r, pollInterval));
                  }catch(e){ await new Promise(r=>setTimeout(r, 1000)); }
                }
              }catch(e){ console.error('[redisNotifConsumer] failed', e && e.message || e); }
            })();
          }
        }catch(e){}
      } catch (e) { console.error('[notificationPump] replacement handler failed', e); }
    } catch (e) { console.error('Failed to load users async:', e); users = loadUsersSync(); }

    // Register centralized buy/sell handlers now that users are loaded
    try { registerBuySellHandlers(bot, users, boughtTokens); } catch (e) { console.error('Failed to register buy/sell handlers:', e); }

    console.log('--- performing pre-launch connectivity check (getMe) ---');
    try {
      const me = await withTimeout(bot.telegram.getMe(), 5000, 'getMe');
      try { const mm: any = me; console.log('--- Telegram getMe OK ---', (mm && mm.username) ? `@${mm.username}` : JSON.stringify(mm)); } catch(e) { console.log('--- Telegram getMe OK (username unknown) ---'); }
    } catch (e) {
      console.error('❌ Telegram getMe failed or timed out:', e && (e.message || e));
      throw e;
    }

    // Decide whether to start Telegram polling (bot.launch).
    // Default behavior: launch the bot so Telegram users can interact unless the
    // operator explicitly sets SKIP_BOT_LAUNCH=true. LISTENER_ONLY_MODE controls
    // internal behavior (no-disk/no-enrich) but SHOULD NOT silently disable the
    // Telegram polling loop unless SKIP_BOT_LAUNCH is set. This makes the bot
    // usable for Telegram users by default while preserving listener-only safety
    // semantics for in-process operations.
    const skipLaunch = (process.env.SKIP_BOT_LAUNCH === 'true');
    if (skipLaunch) {
      console.log('--- Skipping bot.launch() because SKIP_BOT_LAUNCH=true.');
      console.log('--- The bot will still register handlers and start the in-process listener if available.');
    } else {
      if (LISTENER_ONLY_MODE) {
        console.log('--- LISTENER_ONLY_MODE is active but SKIP_BOT_LAUNCH is not set; proceeding to launch the Telegram bot so users can interact.');
        console.log('--- To run in pure listener-only mode (no polling), set SKIP_BOT_LAUNCH=true in the environment.');
      } else {
        console.log('--- launching bot: calling bot.launch() (will timeout after 15s for diagnostics) ---');
      }
      try {
        // configurable timeout for bot.launch (ms)
        const launchTimeout = Number(process.env.BOT_LAUNCH_TIMEOUT_MS || process.env.BOT_LAUNCH_TIMEOUT || 60000);
        const retryTimeout = Math.min(launchTimeout * 2, 120000);
        try {
          // primary attempt with timeout
          await withTimeout(bot.launch(), launchTimeout, 'bot-launch');
          console.log('✅ Bot launched successfully (polling)');
        } catch (err1) {
          console.error('❌ Bot.launch attempt 1 failed or timed out:', err1 && (err1.message || err1));
          try {
            console.log(`--- Retrying bot.launch() with a longer timeout (${retryTimeout}ms) ---`);
            await withTimeout(bot.launch(), retryTimeout, 'bot-launch-retry');
            console.log('✅ Bot launched successfully on retry (polling)');
          } catch (err2) {
            console.error('❌ Bot.launch retry failed or timed out:', err2 && (err2.message || err2));
            // Do not crash the whole process for transient Telegram/polling issues.
            // Continue running the rest of the app (listener) so operator can diagnose.
            console.warn('--- Continuing without active Telegram polling. Set SKIP_BOT_LAUNCH=true to run in pure listener-only mode.');
          }
        }
      } catch (e) {
        // Log any unexpected errors but continue so listener can run in-process
        console.error('❌ Unexpected error during bot.launch sequence:', e && (e.message || e));
      }
    }
      try {
        // Start fast token fetcher to prioritize some users (1s polling)
  // Do NOT start fast token fetcher or enrich queue - listener is the single source of truth per requirement.
      // Start the sequential listener in-process so users receive live pushes from the listener
  // listener will be started lazily on user demand (first Show Tokens press)
      } catch (e) {
        console.warn('Failed to start fast token fetcher:', e);
      }
  // Note: background disk/redis notification pump disabled — using in-process notifier for immediate delivery.
  } catch (err: any) {
    if (err?.response?.error_code === 409) {
      console.error('❌ Bot launch failed: Conflict 409. Make sure the bot is not running elsewhere or stop all other sessions.');
      process.exit(1);
    } else {
      console.error('❌ Bot launch failed:', err);
      process.exit(1);
    }
  }
})();
console.log('--- End of file reached ---');

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Lightweight show_token handler: enqueue background job and return immediately
bot.command('show_token', async (ctx) => {
  console.log(`[show_token] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  // Allow preview even if the user has not configured a strategy yet.
  // For users without a strategy we'll show live listener candidates (fast preview)
  // and invite them to configure a strategy for filtered results.
  if (!user || !user.strategy || user.strategy.enabled === false) {
    try { await ctx.reply('🔎 Showing latest live mints (you have no strategy set). Use /strategy to configure filters.'); } catch(e){}
  }
  try {
    // If user's numeric strategy fields are all zero/undefined, present listener/live candidates immediately
  const strategyRef = (user && user.strategy) ? user.strategy : {};
  // For listener fast-path: consider only market-related numeric constraints.
  // Age fields (minAge/maxAgeSec) do NOT count as blocking constraints — listener uses them uniquely.
  const numericKeys = ['minMarketCap','minLiquidity','minVolume'];
    const hasNumericConstraint = numericKeys.some(k => {
      const v = strategyRef && (strategyRef as any)[k];
      return v !== undefined && v !== null && Number(v) > 0;
    });
  // If user requests age-only behavior, prefer the fast listener-produced candidates
  if (((user && user.strategy && (user.strategy as any).ageOnly !== undefined) ? Boolean((user.strategy as any).ageOnly) : GLOBAL_AGE_ONLY_DEFAULT) || !hasNumericConstraint) {
      // Fast path: return listener-produced candidates (or fastFetcher) without heavy enrichment
      try { await ctx.reply('🔎 Fetching latest live mints from listener — fast preview...'); } catch(e){}
      // Try to use the sequential listener's one-shot collector when available.
      // If the listener module exists but returns no fresh mints, DO NOT fallback to DexScreener
      // to avoid showing older tokens — queue a background enrich instead and inform the user.
      let tokens: any[] = [];
      let listenerAvailable = false;
      try{
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const seq = require('./scripts/sequential_10s_per_program.js');
          if(seq && typeof seq.collectFreshMintsPerUser === 'function'){
          listenerAvailable = true;
          const strictOverride = (user && user.strategy && (user.strategy as any).collectorStrict !== undefined) ? Boolean((user.strategy as any).collectorStrict) : undefined;
          const usersObj: Record<string, any> = {};
          usersObj[userId] = user;
          // Use per-user collector so user's strategy fields (minAge/maxAge) are applied at collection time
          const collected = await seq.collectFreshMintsPerUser(usersObj, { maxCollect: Math.max(1, Number(user.strategy?.maxTrades || 3)), timeoutMs: Number(process.env.COLLECT_TIMEOUT_MS || 20000), strictOverride, ageOnly: true, onlyPrintExplicit: true }).catch(()=>({}));
          const entry = collected && collected[userId] ? collected[userId] : null;
          tokens = (entry && Array.isArray(entry.tokens)) ? entry.tokens.map((it:any)=> Object.assign({ tokenAddress: it.mint || it.tokenAddress || it.address, address: it.mint || it.tokenAddress || it.address, mint: it.mint || it.tokenAddress || it.address, sourceCandidates: true, __listenerCollected: true }, it)) : [];
          // Only retain explicit-created tokens
          tokens = (tokens || []).filter((t:any) => t && t.createdHere === true).slice(0, Math.max(1, Number(user.strategy?.maxTrades || 3)));
        }
      }catch(e){ listenerAvailable = false; }
      if(listenerAvailable){
        if(!tokens || tokens.length===0){
          // Per listener-only mode, do not enqueue external enrich jobs. Inform the user to wait for listener events.
          await ctx.reply('🔔 لا توجد نتائج مستمع حديثة الآن؛ يرجى الانتظار بينما يستمر مصدر الاستماع بجمع النتائج.');
          return;
        }
      } else {
        // Listener not available: per requirement do NOT fallback to external fetchers or caches.
        await ctx.reply('⚠️ مستمع البرامج غير متاح حالياً؛ لا يمكن جلب البيانات من مصادر خارجية وفق سياسة التشغيل. برجاء التأكد من تشغيل مصدر الاستماع أو حاول لاحقاً.');
        return;
      }
      console.log('[show_token] fast-path tokens:', (tokens || []).length);
      // If these tokens are live candidates (from listener/fastFetcher), present immediately
      if (Array.isArray(tokens) && tokens.length && tokens.every(t => (t as any).sourceCandidates || (t as any).matched || (t as any).tokenAddress)) {
        console.log('[show_token] presenting live/sourceCandidates without heavy filter');
        // debug: print token provenance & freshness hints
        try{
          for(const t of tokens){
            try{
              console.error('[show_token-debug] token', { addr: t.tokenAddress||t.address||t.mint, listenerCollected: !!t.__listenerCollected, freshness: t._canonicalAgeSeconds || t.ageSeconds || t.ageMinutes || null });
            }catch(e){}
          }
        }catch(e){}
        // proceed to render below as live results
      } else {
        // no tokens to show
      }
      if (!tokens || tokens.length === 0) {
        // Listener-only: no background enrichment queued. Inform the user to wait for fresh listener events.
        await ctx.reply('🔔 No recent listener results found; please wait for the listener to collect fresh mints.');
        return;
      }
      const maxTrades = Math.max(1, Number(user.strategy?.maxTrades || 3));
      const maxShow = Math.min(maxTrades, 10, tokens.length);
      let msg = `✅ Live results: <b>${tokens.length}</b> token(s) available (showing up to ${maxShow}):\n`;
      for (const t of tokens.slice(0, maxShow)) {
        try {
          const preview = buildPreviewMessage(t);
          const addr = t.tokenAddress || t.address || t.mint || '<unknown>';
          msg += `\n<b>${preview.title || addr}</b> (<code>${addr}</code>)\n${preview.shortMsg}\n`;
        } catch (e) {
          const addr = t.tokenAddress || t.address || t.mint || '<unknown>';
          msg += `\n<code>${addr}</code>\n`;
        }
      }
      try { await ctx.reply(msg, { parse_mode: 'HTML' }); } catch (e) { try { await ctx.reply('✅ Found live matching tokens.'); } catch {} }
      return;
    }

    // Deep, accurate check path: fetch user-tailored tokens (may include on-chain enrichment) and apply strategy filter
    // If the user prefers listener-only/no-enrich, skip heavy enrichment and present listener candidates
    if (userIsListenerOnly(user)) {
      try { await ctx.reply('🔎 You are in listener-only mode (no enrichment). Presenting live listener candidates...'); } catch(e){}
      const tokens = await getTokensForUser(userId, user.strategy);
      if (tokens && tokens.length) {
        const maxTrades = Math.max(1, Number(user.strategy?.maxTrades || 3));
        const maxShow = Math.min(maxTrades, 10, tokens.length);
        let msg = `✅ Live listener-only results: <b>${tokens.length}</b> token(s) available (showing up to ${maxShow}):\n`;
        for (const t of tokens.slice(0, maxShow)) {
    try { const preview = buildPreviewMessage(t); const addr = t.tokenAddress || t.address || t.mint || '<unknown>'; msg += `\n<b>${preview.title || addr}</b> (<code>${addr}</code>)\n${preview.shortMsg}\n`; try{ if(t && (t.sourceProgram || t.sourceSignature)) msg += `<i>من البرنامج: ${t.sourceProgram || '-'} sig: ${t.sourceSignature || '-'}</i>\n`; }catch(e){} } catch (e) { const addr = t.tokenAddress || t.address || t.mint || '<unknown>'; msg += `\n<code>${addr}</code>\n`; }
        }
        try { await ctx.reply(msg, { parse_mode: 'HTML' }); } catch(e) { try { await ctx.reply('✅ Found live listener-only tokens.'); } catch(_){} }
        return;
      }
      // If no tokens from getTokensForUser, try collector one-shot raw addresses as a last resort
      try{
        const seq = require('./scripts/sequential_10s_per_program.js');
        if(seq && typeof seq.collectFreshMints === 'function'){
          const maxCollect = Math.max(1, Number(user.strategy?.maxTrades || 3));
          let maxAgeSec: number | undefined = undefined;
          try{
            if (user.strategy && (user.strategy as any).maxAgeSec !== undefined) {
              const n = Number((user.strategy as any).maxAgeSec);
              if (!isNaN(n)) maxAgeSec = n;
            } else {
              const parseDuration = require('./src/utils/tokenUtils').parseDuration;
              const ma = user.strategy && (user.strategy as any).minAge;
              if(ma !== undefined && ma !== null){
                const parsed = parseDuration(ma);
                if(!isNaN(Number(parsed)) && parsed !== undefined && parsed !== null) maxAgeSec = Number(parsed);
              }
            }
          }catch(e){}
          const strictOverride = (user && user.strategy && (user.strategy as any).collectorStrict !== undefined) ? Boolean((user.strategy as any).collectorStrict) : undefined;
          const addrs = await seq.collectFreshMints({ maxCollect, maxAgeSec, strictOverride, onlyPrintExplicit: true }).catch(()=>[]);
          if(Array.isArray(addrs) && addrs.length > 0){ try{ await ctx.reply('🔔 Live listener results (raw):\n' + JSON.stringify(addrs.slice(0, Math.max(10, addrs.length)), null, 2)); }catch(e){ try{ await ctx.reply('🔔 Live listener results: ' + addrs.join(', ')); }catch(e){} } return; }
        }
      }catch(e){}
      await ctx.reply('🔔 No live listener results available at the moment; please wait.');
      return;
    }

    // perform accurate filtering for non-listener-only users
    await ctx.reply('🔎 Performing an accurate strategy check — this may take a few seconds. Please wait...');
    const tokens = await getTokensForUser(userId, user.strategy);
    let accurate: any[] = [];
    try {
      accurate = await withTimeout(filterTokensByStrategy(tokens, user.strategy, { fastOnly: false }), 7000, 'show_token-filter');
    } catch (e) {
      console.error('[show_token] accurate filter failed or timed out', e?.message || e);
      accurate = [];
    }

    if (!accurate || accurate.length === 0) {
      // Nothing matched after the deeper check — as a last-resort try the listener one-shot collector
      try{
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const seq = require('./scripts/sequential_10s_per_program.js');
        if(seq && typeof seq.collectFreshMints === 'function'){
          const maxCollect = Math.max(1, Number(user.strategy?.maxTrades || 3));
          // derive maxAgeSec from user's minAge
          let maxAgeSec: number | undefined = undefined;
          try{
            const parseDuration = require('./src/utils/tokenUtils').parseDuration;
            const ma = user.strategy && (user.strategy as any).minAge;
            if(ma !== undefined && ma !== null){
              const parsed = parseDuration(ma);
              if(!isNaN(Number(parsed)) && parsed !== undefined && parsed !== null) maxAgeSec = Number(parsed);
            }
          }catch(e){}
          const strictOverride = (user && user.strategy && (user.strategy as any).collectorStrict !== undefined) ? Boolean((user.strategy as any).collectorStrict) : undefined;
          const addrs = await seq.collectFreshMints({ maxCollect, maxAgeSec, strictOverride, onlyPrintExplicit: true }).catch(()=>[]);
          // Ensure raw addrs are explicit-created when collector returned token objects
          const explicitAddrs = Array.isArray(addrs) ? addrs.filter(a => { try{ if(!a) return false; if(typeof a === 'string') return false; return Boolean(a.createdHere === true); }catch(e){return false;} }).map(a => (a.tokenAddress||a.address||a.mint||String(a))) : [];
          if(Array.isArray(explicitAddrs) && explicitAddrs.length > 0){
            // Return raw payload so user sees actual live mints discovered
            try{ await ctx.reply('🔔 Live listener results (raw):\n' + JSON.stringify(explicitAddrs.slice(0, Math.max(10, explicitAddrs.length)), null, 2)); }catch(e){ try{ await ctx.reply('🔔 Live listener results: ' + explicitAddrs.join(', ')); }catch(e){} }
            return;
          }
        }
      }catch(e){ /* ignore collector errors */ }
      // Listener-only: no background enrich queued. Inform the user to wait for listener events.
      await ctx.reply('🔔 No matches found after a deeper check; please wait for the listener to produce fresh results.');
      return;
    }

    // Respect user's maxTrades and present a professional list
    const maxTrades = Math.max(1, Number(user.strategy?.maxTrades || 3));
    const maxShow = Math.min(maxTrades, 10, accurate.length);
    let msg = `✅ Accurate results: <b>${accurate.length}</b> token(s) match your strategy (showing up to ${maxShow}):\n`;
    for (const t of accurate.slice(0, maxShow)) {
      try {
  const preview = buildPreviewMessage(t);
        const addr = t.tokenAddress || t.address || t.mint || '<unknown>';
  msg += `\n<b>${preview.title || addr}</b> (<code>${addr}</code>)\n${preview.shortMsg}\n`;
  try{ if(t && (t.sourceProgram || t.sourceSignature)) msg += `<i>من البرنامج: ${t.sourceProgram || '-'} sig: ${t.sourceSignature || '-'}</i>\n`; }catch(e){}
      } catch (e) {
        const addr = t.tokenAddress || t.address || t.mint || '<unknown>';
        msg += `\n<code>${addr}</code>\n`;
      }
    }
    try { await ctx.reply(msg, { parse_mode: 'HTML' }); } catch (e) { try { await ctx.reply('✅ Found matching tokens (accurate results).'); } catch {} }
    return;
  } catch (e) {
    console.error('[show_token] fast-preview error:', e?.stack || e);
  await ctx.reply('❗ Internal error while producing a fast preview; please try again later or wait for listener events.');
  }
});