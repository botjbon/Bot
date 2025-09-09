const tu = require('../src/utils/tokenUtils');

describe('collector -> display address consistency', () => {
  test('buildBulletedMessage uses token.mint/tokenAddress', () => {
    const token = { mint: 'AAA111111111111111111111111111111111111111', createdHere: true, collectedAtMs: Date.now() };
    const norm = tu.normalizeTokenForDisplay(token);
    const built = tu.buildBulletedMessage([norm], { cluster: 'mainnet', title: 'Test', maxShow: 1 });
    expect(built).toBeDefined();
    const text = built.text || '';
    expect(text).toContain(token.mint);
  });
});
