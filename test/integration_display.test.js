const tu = require('../src/utils/tokenUtils');

describe('integration: collector -> builder address consistency', () => {
  test('collector snapshot object produces same displayed address', () => {
    const mint = 'INTEG11111111111111111111111111111111111111';
    // simulate collector object
    const collectedObj = { mint, tokenAddress: mint, address: mint, createdHere: true, collectedAtMs: Date.now(), name: 'IntegToken', symbol: 'IT' };
    // normalize and build
    const norm = tu.normalizeTokenForDisplay(collectedObj);
    const built = tu.buildBulletedMessage([norm], { cluster: 'mainnet', title: 'Integ Test', maxShow: 1 });
    expect(built).toBeDefined();
    const text = built.text || '';
    expect(text).toContain(mint);
  });
});
