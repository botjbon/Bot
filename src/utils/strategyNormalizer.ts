/**
 * Normalize strategy object: map synonyms, set defaults, and ensure consistent field names
 * Returns a new object and does not mutate the original.
 */
import { parseDuration } from './tokenUtils';

export function normalizeStrategy(orig: any) {
  const s = Object.assign({}, orig || {});
  // map synonyms
  if (s.profitTargetPercent && !s.target1) s.target1 = s.profitTargetPercent;
  if (s.targetPercent && !s.target1) s.target1 = s.targetPercent;
  if (s.sellPercent && !s.sellPercent1) s.sellPercent1 = s.sellPercent;
  // defaults for trade settings
  s.buyAmount = typeof s.buyAmount === 'number' ? s.buyAmount : (s.buyAmount ? Number(s.buyAmount) : undefined);
  s.sellPercent1 = typeof s.sellPercent1 === 'number' ? s.sellPercent1 : (s.sellPercent1 ? Number(s.sellPercent1) : undefined);
  s.sellPercent2 = typeof s.sellPercent2 === 'number' ? s.sellPercent2 : (s.sellPercent2 ? Number(s.sellPercent2) : undefined);
  s.target1 = typeof s.target1 === 'number' ? s.target1 : (s.target1 ? Number(s.target1) : undefined);
  s.target2 = typeof s.target2 === 'number' ? s.target2 : (s.target2 ? Number(s.target2) : undefined);
  s.stopLoss = typeof s.stopLoss === 'number' ? s.stopLoss : (s.stopLoss ? Number(s.stopLoss) : undefined);
  s.maxTrades = typeof s.maxTrades === 'number' ? s.maxTrades : (s.maxTrades ? Number(s.maxTrades) : undefined);
  s.enabled = typeof s.enabled === 'boolean' ? s.enabled : (s.enabled === undefined ? true : Boolean(s.enabled));
  s.autoBuy = s.autoBuy === false ? false : true;
  // priority flags
  s.priority = s.priority === true ? true : false;
  s.priorityRank = typeof s.priorityRank === 'number' ? s.priorityRank : (s.priorityRank ? Number(s.priorityRank) : 0);
  // numeric filters
  s.minMarketCap = s.minMarketCap !== undefined ? Number(s.minMarketCap) : undefined;
  s.minLiquidity = s.minLiquidity !== undefined ? Number(s.minLiquidity) : undefined;
  s.minVolume = s.minVolume !== undefined ? Number(s.minVolume) : undefined;
  // Normalize minAge: accept numbers (seconds) or duration strings like '30s','2m'
  // Normalize age field: interpret user's age setting as a maximum allowed age
  // and expose it as `maxAgeSec` (seconds). Keep `minAge` undefined for
  // backward compatibility but prefer `maxAgeSec` throughout the codebase.
  if (s.minAge !== undefined && s.minAge !== null) {
    try {
      const parsed = typeof s.minAge === 'string' ? parseDuration(s.minAge) : Number(s.minAge);
      const secs = (parsed === undefined || isNaN(Number(parsed))) ? undefined : Number(parsed);
      s.maxAgeSec = secs; // unified max age in seconds
    } catch (e) { s.maxAgeSec = undefined; }
  } else {
    s.maxAgeSec = undefined;
  }
  // clear old field to avoid ambiguity
  s.minAge = undefined;
  return s;
}
