const path = require('path');
const seqPath = path.join(__dirname, '..', 'scripts', 'sequential_10s_per_program.js');

describe('explicit enforcement integration', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('notifyUsers normalizes and filters non-explicit tokens before sending', async () => {
    const tu = require('../src/utils/tokenUtils');
    // Mock a fake bot.telegram with sendMessage spy
    const fakeTelegram = { sendMessage: jest.fn().mockResolvedValue(true) };

    // Use notifyUsers path which should normalize and enforce explicit tokens
    const users = { '42': { strategy: { enabled: true, maxTrades: 5 } } };
    const tokens = [ { mint: 'ExplicitMint1', createdHere: true }, { mint: 'NonExplicitMint', createdHere: false } ];

    // Call notifyUsers and verify only explicit token resulted in a send
    await tu.notifyUsers({ telegram: fakeTelegram } , users, tokens);

    expect(fakeTelegram.sendMessage.mock.calls.length).toBeGreaterThan(0);
    const sentArgs = fakeTelegram.sendMessage.mock.calls.map(c => c.slice(1)).flat();
    const joined = JSON.stringify(sentArgs);
    expect(joined).toMatch(/ExplicitMint1/);
    expect(joined).not.toMatch(/NonExplicitMint/);
  });
});
