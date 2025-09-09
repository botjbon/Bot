// portfolioCopyMonitor.ts
// Copy Trading Monitoring logic for Telegram bot


interface TrackerUser {
  userId: string;
  copiedWallets: string[];
  secret: string;
  wallet: string;
}

// Last executed transaction for each copied wallet to prevent duplicates
const lastExecutedTx: { [wallet: string]: string } = {};

/**
 * Monitors copied wallets and executes trades for users as needed.
 * This function should be called periodically from the main bot file.
 * @param trackerUsers - Object mapping userId to TrackerUser info
 */

import fetch from 'node-fetch';

// Use runtime requires for optional modules to avoid type errors
let autoBuy: any; let sellWithOrca: any; let bot: any;
try { autoBuy = require('../utils/autoBuy').autoBuy; } catch (e) { autoBuy = null; }
try { sellWithOrca = require('../sell').sellWithOrca; } catch (e) { sellWithOrca = null; }
try { bot = require('../telegramBot').bot; } catch (e) { bot = null; }

// Helper: Fetch recent trades for a wallet from Birdeye API
async function fetchRecentTrades(wallet: string): Promise<Array<{token: string; amount: number; type: 'buy'|'sell'; tx: string;}>> {
  try {
    const res = await fetch(`https://public-api.birdeye.so/public/wallet/txs?address=${wallet}&limit=5`);
  const data = await res.json() as any;
  if (!Array.isArray(data?.data)) return [];
    // Convert Birdeye transactions to unified model
    return data.data
      .filter((tx: any) => tx.type === 'buy' || tx.type === 'sell')
      .map((tx: any) => ({
        token: tx.token_address,
        amount: tx.token_amount,
        type: tx.type,
        tx: tx.tx_hash
      }));
  } catch {
    return [];
  }
}

// Helper: Execute a copy trade for a user
async function executeCopyTrade(user: TrackerUser, trade: {token: string; amount: number; type: 'buy'|'sell'; tx: string;}): Promise<string> {
  try {
    if (trade.type === 'buy') {
      if (!autoBuy) throw new Error('autoBuy not available');
      return await autoBuy(trade.token, trade.amount, user.secret);
    } else {
      if (!sellWithOrca) throw new Error('sellWithOrca not available');
      const tx = await sellWithOrca(trade.token, trade.amount);
      return typeof tx === 'string' ? tx : 'done';
    }
  } catch (e: any) {
    return 'error: ' + ((e as any)?.message || 'Unknown');
  }
}

// Helper: Notify user via Telegram bot
function notifyUser(userId: string, message: string) {
  if (bot && bot.telegram && typeof bot.telegram.sendMessage === 'function') {
    const onlyExplicit = (process.env.ONLY_PRINT_EXPLICIT === 'true' || process.env.ONLY_PRINT_EXPLICIT === '1');
    if (onlyExplicit) {
      // Do not send copy-trade notifications as discovery messages when explicit-only is enforced.
      // Send a minimal informational stub instead.
      try { bot.telegram.sendMessage(userId, 'ℹ️ Copy-trade notifications suppressed due to explicit-only policy.'); } catch (e) {}
      return;
    }
    bot.telegram.sendMessage(userId, message);
  }
}

// Main monitoring logic
export async function monitorCopiedWallets(trackerUsers: Record<string, TrackerUser>) {
  for (const userId in trackerUsers) {
    const user = trackerUsers[userId];
    for (const copiedWallet of user.copiedWallets) {
      // Fetch recent trades from copied wallet
      const trades = await fetchRecentTrades(copiedWallet);
      for (const trade of trades) {
        // Prevent duplicate execution: only execute if not already done
        if (lastExecutedTx[copiedWallet] === trade.tx) continue;
        const tx = await executeCopyTrade(user, trade);
        notifyUser(user.userId, `Copied ${trade.type} of ${trade.token} (${trade.amount}) from wallet ${copiedWallet}. Tx: ${tx}`);
        lastExecutedTx[copiedWallet] = trade.tx;
      }
    }
  }
}

// You can add more helper functions here as needed for copy trading logic