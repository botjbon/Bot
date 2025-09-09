import { filterTokensByStrategy } from './bot/strategy';
import { unifiedBuy, unifiedSell } from './tradeSources';

/**
 * Executes auto-trading for a user based on their strategy.
 * @param user - User object containing strategy, wallet, and secret
 * @param tokens - Array of available tokens to filter and trade
 * @param mode - 'buy' or 'sell'
 */
export async function autoExecuteStrategyForUser(user: any, tokens: any[], mode: 'buy' | 'sell' = 'buy') {
  if (!user.strategy || !user.wallet || !user.secret || user.strategy.enabled === false) return;

  // Filter tokens according to user's strategy
    const filteredTokens = await (require('./bot/strategy').filterTokensByStrategy(tokens, user.strategy, { preserveSources: true }));
  if (filteredTokens.length === 0) {
    console.log(`[autoExecute] No tokens matched for user ${user.id || user.username}`);
    return;
  }

  // Limit trades to maxTrades if set
  const maxTrades = user.strategy.maxTrades && user.strategy.maxTrades > 0 ? user.strategy.maxTrades : filteredTokens.length;
  const tokensToTrade = filteredTokens.slice(0, maxTrades);

  // Use getField for robust address extraction
  const { getField } = require('./utils/tokenUtils');

  for (const token of tokensToTrade) {
    try {
  // Get token address (mint/address/tokenAddress)
  const tokenAddress = getField(token, 'mint', 'address', 'tokenAddress');
      if (!tokenAddress) {
        console.warn(`[autoExecute] No valid address for token`, token);
        continue;
      }

      let result;
      const buyAmount = user.strategy.buyAmount || 0.01;
      if (mode === 'buy') {
        result = await unifiedBuy(tokenAddress, buyAmount, user.secret);
      } else {
        // Calculate sell amount based on percent and balance if available
        let balance = token.balance || buyAmount || 0.01;
        let sellPercent = user.strategy.sellPercent1 || 100;
        let sellAmount = (balance * sellPercent) / 100;
        result = await unifiedSell(tokenAddress, sellAmount, user.secret);
      }
      console.log(`[autoExecute] ${mode} for user ${user.id || user.username} on token ${tokenAddress}:`, result);
      // Optionally: log, notify user, update history, etc.
    } catch (err) {
      console.error(`[autoExecute] Failed to ${mode} token for user ${user.id || user.username}:`, err);
    }
  }
}
