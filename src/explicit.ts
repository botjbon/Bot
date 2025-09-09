// Central explicit-only guard utilities
export const EXPLICIT_ONLY_MODE = true;

export function enforceExplicitTokens(tokens: any[]) {
  try {
    if (!Array.isArray(tokens)) return [];
    return tokens.filter(t => Boolean(t && t.createdHere === true));
  } catch (e) { return []; }
}

export function isExplicitOnly() { return EXPLICIT_ONLY_MODE; }
