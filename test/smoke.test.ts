const seq = require('../scripts/sequential_10s_per_program.js');
const tokenUtils = require('../src/utils/tokenUtils');

describe('smoke exports', () => {
  test('sequential collector exports', () => {
    expect(seq).toBeDefined();
    const hasCollector = typeof seq.collectFreshMintsPerUser === 'function' || typeof seq.collectFreshMints === 'function';
    expect(hasCollector).toBeTruthy();
  });

  test('tokenUtils exports', () => {
    expect(tokenUtils).toBeDefined();
    expect(typeof tokenUtils.buildBulletedMessage === 'function' || typeof tokenUtils.buildTokenMessage === 'function').toBeTruthy();
  });
});
