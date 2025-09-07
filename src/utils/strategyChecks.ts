/**
 * Simple strategy validation helpers.
 * Exports a function that checks a normalized strategy for common mistakes and
 * returns an array of human-readable warnings/errors.
 */
export function validateStrategy(strategy: any): string[] {
  const issues: string[] = [];
  if (!strategy || typeof strategy !== 'object') {
    issues.push('Strategy is missing or not an object.');
    return issues;
  }
  // Basic numeric sanity
  if (strategy.buyAmount !== undefined && (typeof strategy.buyAmount !== 'number' || isNaN(strategy.buyAmount) || strategy.buyAmount <= 0)) {
    issues.push('buyAmount should be a positive number.');
  }
  // Accept either normalized maxAgeSec (seconds) or legacy minAge (seconds or duration string)
  if (strategy.maxAgeSec !== undefined) {
    if (isNaN(Number(strategy.maxAgeSec)) || Number(strategy.maxAgeSec) < 0) issues.push('maxAgeSec should be a non-negative number (seconds).');
  } else if (strategy.minAge !== undefined) {
    const v = strategy.minAge;
    const parsed = (typeof v === 'number') ? v : (isNaN(Number(v)) ? null : Number(v));
    if (parsed === null && typeof v !== 'string') {
      issues.push('minAge should be a non-negative number (seconds) or a duration string like "30s" or "2m".');
    } else if (parsed !== null && Number(parsed) < 0) {
      issues.push('minAge should be non-negative.');
    }
  }
  if (strategy.minVolume !== undefined && (isNaN(Number(strategy.minVolume)) || Number(strategy.minVolume) < 0)) {
    issues.push('minVolume should be a non-negative number (USD).');
  }
  // Logical checks
  if (strategy.enabled === false && strategy.autoBuy === true) {
    issues.push('Strategy is disabled but autoBuy is enabled; autoBuy will not run while disabled.');
  }
  if (strategy.target1 !== undefined && strategy.target2 !== undefined && Number(strategy.target1) >= Number(strategy.target2)) {
    issues.push('target1 should be less than target2 for progressive sells.');
  }
  // Warn on missing trade params when autoBuy enabled
  if (strategy.autoBuy !== false && (strategy.buyAmount === undefined || Number(strategy.buyAmount) <= 0)) {
    issues.push('autoBuy is enabled but buyAmount is missing or not positive.');
  }
  return issues;
}

export default { validateStrategy };
