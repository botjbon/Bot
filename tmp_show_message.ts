const { buildTokenMessage, buildBulletedMessage } = require('./src/utils/tokenUtils');

(async ()=>{
  const sample = {
    mint: 'HExAMPLEmintAddr1111111111111111111111111',
    name: 'Test Token',
    symbol: 'TST',
    createdHere: true,
    url: 'https://dexscreener.com/solana/somepairid',
    imageUrl: 'https://example.com/logo.png',
    priceUsd: 0.00012345,
    marketCap: 50000,
    liquidity: 2000,
    volume: 1000,
    holders: 123,
    _canonicalAgeSeconds: 30,
    description: 'A test token created for smoke rendering',
    links: [{ type: 'twitter', url: 'https://twitter.com/testtoken' }]
  };
  const botUsername = process.env.BOT_USERNAME || 'YourBotUsername';
  const pairAddress = sample.pairAddress || sample.tokenAddress || sample.address || sample.mint || '';
  const msgObj = buildTokenMessage(sample, botUsername, pairAddress, '5766632997');
  console.log('=== Single token HTML ===');
  console.log(msgObj.msg);
  console.log('\n=== Inline keyboard ===');
  console.log(JSON.stringify(msgObj.inlineKeyboard, null, 2));

  console.log('\n=== Bulleted message ===');
  const bul = buildBulletedMessage([sample], { title: 'Tokens matching your strategy', maxShow: 1 });
  console.log(bul.text);
  console.log('\n=== Bulleted inline_keyboard ===');
  console.log(JSON.stringify(bul.inline_keyboard, null, 2));
})();
