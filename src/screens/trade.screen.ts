let TelegramBot: any;
let InlineKeyboardMarkup: any;
// Lightweight type aliases when the actual Telegram types are unavailable at compile time
type TelegramBotType = any;
type TelegramMessage = any;
type ReplyMarkup = any;
try {
  // prefer default import if available
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const _tg = require('node-telegram-bot-api');
  TelegramBot = _tg.default || _tg;
} catch (e) {}
let JupiterService: any;
type QuoteRes = any;
try {
  JupiterService = require('../services/jupiter.service').JupiterService;
} catch (e) {
  JupiterService = null;
}
let TokenService: any;
try { TokenService = require('../services/token.metadata').TokenService; } catch (e) { TokenService = null; }
import {
  closeReplyMarkup,
  deleteDelayMessage,
  sendNoneExistTokenNotification,
} from "./common.screen";
let UserService: any;
try { UserService = require('../services/user.service').UserService; } catch (e) { UserService = null; }
let BUY_XSOL_TEXT: any;
let PRESET_BUY_TEXT: any;
let SELL_XPRO_TEXT: any;
let SET_SLIPPAGE_TEXT: any;
let TradeBotID: any;
try { const _b = require('../bot.opts'); BUY_XSOL_TEXT = _b.BUY_XSOL_TEXT; PRESET_BUY_TEXT = _b.PRESET_BUY_TEXT; SELL_XPRO_TEXT = _b.SELL_XPRO_TEXT; SET_SLIPPAGE_TEXT = _b.SET_SLIPPAGE_TEXT; TradeBotID = _b.TradeBotID; } catch (e) { BUY_XSOL_TEXT = PRESET_BUY_TEXT = SELL_XPRO_TEXT = SET_SLIPPAGE_TEXT = TradeBotID = null; }
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createBurnInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
let GasFeeEnum: any, UserTradeSettingService: any, MsgLogService: any;
try { ({ GasFeeEnum, UserTradeSettingService } = require('../services/user.trade.setting.service')); } catch (e) { GasFeeEnum = null; UserTradeSettingService = null; }
try { MsgLogService = require('../services/msglog.service').MsgLogService; } catch (e) { MsgLogService = null; }
// import { inline_keyboards } from "./contract.info.screen";
import { copytoclipboard, fromWeiToValue } from "../utils";
import bs58 from "bs58";
let RAYDIUM_PASS_TIME: any;
let RESERVE_WALLET: any;
let connection: any;
let private_connection: any;
try {
  const _c = require("../config");
  RAYDIUM_PASS_TIME = _c.RAYDIUM_PASS_TIME;
  RESERVE_WALLET = _c.RESERVE_WALLET;
  connection = _c.connection;
  private_connection = _c.private_connection;
} catch (e) {
  RAYDIUM_PASS_TIME = RESERVE_WALLET = connection = private_connection = null;
}
import { getSignatureStatus, sendTransactionV0 } from "../utils/v0.transaction";
let checkReferralFeeSent: any, get_referral_info: any, PNLService: any;
try { ({ checkReferralFeeSent, get_referral_info } = require('../services/referral.service')); } catch (e) { checkReferralFeeSent = null; get_referral_info = null; }
try { PNLService = require('../services/pnl.service').PNLService; } catch (e) { PNLService = null; }
import { RaydiumSwapService, getPriceInSOL } from "../raydium/raydium.service";
let RaydiumTokenService: any;
try { RaydiumTokenService = require('../services/raydium.token.service').RaydiumTokenService; } catch (e) { RaydiumTokenService = null; }
import { getCoinData } from "../pump/api";
import { pumpFunSwap } from "../pump/swap";
let setFlagForBundleVerify: any;
try { setFlagForBundleVerify = require('../services/redis.service').setFlagForBundleVerify; } catch (e) { setFlagForBundleVerify = null; }
let getReplyOptionsForSettings: any;
try { getReplyOptionsForSettings = require('./settings.screen').getReplyOptionsForSettings; } catch (e) { getReplyOptionsForSettings = null; }
let GenerateReferralCode: any;
try { GenerateReferralCode = require('./referral.link.handler').GenerateReferralCode; } catch (e) { GenerateReferralCode = null; }
let JitoBundleService: any;
try { JitoBundleService = require('../services/jito.bundle').JitoBundleService; } catch (e) { JitoBundleService = null; }

export const buyCustomAmountScreenHandler = async (
  bot: TelegramBotType,
  msg: TelegramMessage
) => {
  try {
    const chat_id = msg.chat.id;
    const username = msg.chat.username;
    if (!username) return;
    const user = await UserService.findOne({ username });
    if (!user) return;

    const msglog = await MsgLogService.findOne({
      username,
      msg_id: msg.message_id,
    });
    if (!msglog) return;
    const { mint } = msglog;
    if (!mint) return;

  const { sendMessageFiltered } = await import('../bot/screenGuard');
  const sentMessage = await sendMessageFiltered(bot.telegram, chat_id, BUY_XSOL_TEXT, { parse_mode: "HTML", reply_markup: { force_reply: true } });

    await MsgLogService.create({
      username,
      mint,
      wallet_address: user.wallet_address,
      chat_id,
      msg_id: sentMessage.message_id,
      parent_msgid: msg.message_id,
    });
  } catch (e) {
    console.log("~buyCustomAmountScreenHandler~", e);
  }
};

export const sellCustomAmountScreenHandler = async (
  bot: TelegramBotType,
  msg: TelegramMessage
) => {
  try {
    const chat_id = msg.chat.id;
    const caption = msg.text;
    const username = msg.chat.username;
    const user = await UserService.findOne({ username });
    if (!user) return;
    if (!caption || !username) return;
    const mint = getTokenMintFromCallback(caption);
    if (!mint) return;

  const { sendMessageFiltered } = await import('../bot/screenGuard');
  const sentMessage = await sendMessageFiltered(bot.telegram, chat_id, SELL_XPRO_TEXT, { parse_mode: "HTML", reply_markup: { force_reply: true } });

    await MsgLogService.create({
      username,
      mint,
      wallet_address: user.wallet_address,
      chat_id,
      msg_id: sentMessage.message_id,
      parent_msgid: msg.message_id,
    });
  } catch (e) {
    console.log("~sellCustomAmountScreenHandler~", e);
  }
};

export const setSlippageScreenHandler = async (
  bot: TelegramBotType,
  msg: TelegramMessage
) => {
  try {
    const chat_id = msg.chat.id;
    const username = msg.chat.username;
    if (!username) return;
    const user = await UserService.findOne({ username });
    if (!user) return;

    const msglog = await MsgLogService.findOne({
      username,
      msg_id: msg.message_id,
    });
    if (!msglog) return;
    // const { mint } = msglog;

    // if (!mint) return;

  const { sendMessageFiltered } = await import('../bot/screenGuard');
  const sentMessage = await sendMessageFiltered(bot.telegram, chat_id, SET_SLIPPAGE_TEXT, { parse_mode: "HTML", reply_markup: { force_reply: true } });

    await MsgLogService.create({
      username,
      mint: "slippage",
      wallet_address: user.wallet_address,
      chat_id,
      msg_id: sentMessage.message_id,
      parent_msgid: msg.message_id,
    });
  } catch (e) {
    console.log("~buyCustomAmountScreenHandler~", e);
  }
};

export const buyHandler = async (
  bot: TelegramBotType,
  msg: TelegramMessage,
  amount: number,
  reply_message_id?: number
) => {
  const chat_id = msg.chat.id;
  const username = msg.chat.username;
  if (!username) return;
  console.log("Buy1:", Date.now());
  const user = await UserService.findOne({ username });
  if (!user) return;
  const { wallet_address } = user;
  const msglog = await MsgLogService.findOne({
    username,
    msg_id: reply_message_id ?? msg.message_id,
  });

  if (!msglog) return;
  const { mint, sol_amount } = msglog;

  const gassetting = await UserTradeSettingService.getGas(username);
  console.log("Buy2:", Date.now());

  const gasvalue = UserTradeSettingService.getGasValue(gassetting);
  if (!mint) return;
  // Insufficient check check if enough includes fee
  if (sol_amount && sol_amount <= amount + gasvalue) {
    bot
      .sendMessage(
        chat_id,
        "<b>⚠️ Insufficient SOL balance!</b>",
        closeReplyMarkup
      )
      .then((sentMessage) => {
        setTimeout(() => {
          bot.deleteMessage(chat_id, sentMessage.message_id);
        }, 5000);
      });
    return;
  }

  let name = "";
  let symbol = "";
  let decimals = 9;
  let isToken2022 = false;
  let isRaydium = true;
  const raydiumPoolInfo = await RaydiumTokenService.findLastOne({ mint });
  const jupiterSerivce = new JupiterService();
  let isJupiterTradable = false;
  let isPumpfunTradable = false;
  if (!raydiumPoolInfo) {
    const jupiterTradeable = await jupiterSerivce.checkTradableOnJupiter(mint);
    if (!jupiterTradeable) {
      isPumpfunTradable = true;
    } else {
      isJupiterTradable = jupiterTradeable;
    }
  } else {
    const { creation_ts } = raydiumPoolInfo;
    const duration = Date.now() - creation_ts;
    // 120minutes
    if (duration < RAYDIUM_PASS_TIME) {
      isJupiterTradable = false;
    } else {
      const jupiterTradeable = await jupiterSerivce.checkTradableOnJupiter(
        mint
      );
      isJupiterTradable = jupiterTradeable;
    }
  }
  console.log("IsJupiterTradeable", isJupiterTradable);
  if (isPumpfunTradable) {
    const coinData = await getCoinData(mint);
    if (!coinData) {
      console.error("Failed to retrieve coin data...");
      return;
    }

    name = coinData["name"];
    symbol = coinData["symbol"];
    const metadata = await TokenService.getMintMetadata(
      private_connection,
      new PublicKey(mint)
    );
    if (!metadata) return;
    decimals = metadata.parsed.info.decimals;
    isToken2022 = metadata.program === "spl-token-2022";
  } else if (raydiumPoolInfo && !isJupiterTradable) {
    // Metadata
    const metadata = await TokenService.getMintMetadata(
      private_connection,
      new PublicKey(mint)
    );
    if (!metadata) return;
    isToken2022 = metadata.program === "spl-token-2022";
    // const tokenDetails = await TokenService.getTokenOverview(mint)
    // name = tokenDetails.name;
    // symbol = tokenDetails.symbol;
    name = raydiumPoolInfo.name;
    symbol = raydiumPoolInfo.symbol;
    decimals = metadata.parsed.info.decimals;
    // }
  } else {
    const mintinfo = await TokenService.getMintInfo(mint);
    if (!mintinfo) return;

    isRaydium = false;
    name = mintinfo.overview.name || "";
    symbol = mintinfo.overview.symbol || "";
    decimals = mintinfo.overview.decimals || 9;
    isToken2022 = mintinfo.secureinfo.isToken2022;
  }

  const solprice = await TokenService.getSOLPrice();

  // send Notification
  const getcaption = (status: string, suffix: string = "") => {
    const securecaption =
      `🌳 Token: <b>${name ?? "undefined"} (${symbol ?? "undefined"})</b> ` +
      `${isToken2022 ? "<i>Token2022</i>" : ""}\n` +
      `<i>${copytoclipboard(mint)}</i>\n` +
      status +
      `💲 <b>Value: ${amount} SOL ($ ${(amount * solprice).toFixed(3)})</b>\n` +
      suffix;

    return securecaption;
  };
  const buycaption = getcaption(`🕒 <b>Buy in progress</b>\n`);

  const { sendMessageFiltered } = await import('../bot/screenGuard');
  const pendingTxMsg = await sendMessageFiltered(bot.telegram, chat_id, buycaption, { parse_mode: "HTML" });
  const pendingTxMsgId = (pendingTxMsg as any)?.message_id;
  console.log("Buy3:", Date.now());

  const { slippage } = await UserTradeSettingService.getSlippage(
    username
    // mint
  );
  console.log("Buy start:", Date.now());
  // buy token
  const raydiumService = new RaydiumSwapService();
  // const jupiterSerivce = new JupiterService();
  console.log("Raydium Swap?", isRaydium, isJupiterTradable);

  const quoteResult = isPumpfunTradable
    ? await pumpFunSwap(
        user.private_key,
        mint,
        decimals,
        true,
        amount,
        gasvalue,
        slippage,
        user.burn_fee ?? true,
        username,
        isToken2022
      )
    : isRaydium
    ? await raydiumService.swapToken(
        user.private_key,
        NATIVE_MINT.toString(),
        mint,
        decimals,
        // 9, // SOL decimal
        amount,
        slippage,
        gasvalue,
        user.burn_fee ?? true,
        username,
        isToken2022
      )
    : await jupiterSerivce.swapToken(
        user.private_key,
        NATIVE_MINT.toString(),
        mint,
        9, // SOL decimal
        amount,
        slippage,
        gasvalue,
        user.burn_fee ?? true,
        username,
        isToken2022
      );

  if (quoteResult) {
    const { signature, total_fee_in_sol, quote, bundleId } = quoteResult;
    // Here, we need to set Flag because of PNL calucation
    // while waiting for bundle verification, "position" collection
    // might be overlapped
    await setFlagForBundleVerify(wallet_address);

    // const status = await getSignatureStatus(signature);
    let resultCaption;
    const jitoBundleInstance = new JitoBundleService();
    const status = await jitoBundleInstance.getBundleStatus(bundleId);
    const suffix = `📈 Txn: <a href="https://solscan.io/tx/${signature}">${signature}</a>\n`;
    if (status) {
      resultCaption = getcaption(`🟢 <b>Buy Success</b>\n`, suffix);
      // Buy with SOL.
      const { inAmount, outAmount } = quote;
      const inAmountNum = fromWeiToValue(inAmount, 9);
      const outAmountNum = fromWeiToValue(outAmount, decimals);
      console.log(inAmountNum, outAmountNum);

      const pnlservice = new PNLService(user.wallet_address, mint);
      await pnlservice.afterBuy(inAmountNum, outAmountNum);

      // Update Referral System
      await checkReferralFeeSent(total_fee_in_sol, username);
    } else {
    try { await bot.deleteMessage(chat_id, pendingTxMsgId); } catch (e) {}
      resultCaption = getcaption(`🔴 <b>Buy Failed</b>\n`, suffix);
    }
    await bot.editMessageText(resultCaption, {
      message_id: pendingTxMsgId,
      chat_id,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: closeReplyMarkup.reply_markup as InlineKeyboardMarkup,
    });
  } else {
    const failedCaption = getcaption(`🔴 <b>Buy Failed</b>\n`);
    try {
      await bot.editMessageText(failedCaption, {
        message_id: pendingTxMsgId,
        chat_id,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: closeReplyMarkup.reply_markup as InlineKeyboardMarkup,
      });
    } catch (e) {}
  }
};

export const autoBuyHandler = async (
  bot: TelegramBotType,
  msg: TelegramMessage,
  user: any,
  mint: string,
  amount: number,
  sol_amount: number,
  gasvalue: number,
  slippage: number
) => {
  const chat_id = msg.chat.id;
  const username = msg.chat.username;
  if (!username) return;
  // Insufficient check check if enough includes fee
  if (sol_amount && sol_amount <= amount + gasvalue) {
    bot
      .sendMessage(
        chat_id,
        "<b>⚠️ Insufficient SOL balance!</b>",
        closeReplyMarkup
      )
      .then((sentMessage) => {
        setTimeout(() => {
          bot.deleteMessage(chat_id, sentMessage.message_id);
        }, 5000);
      });
    return;
  }

  let name = "";
  let symbol = "";
  let decimals = 9;
  let isToken2022 = false;
  let isRaydium = true;
  const raydiumPoolInfo = await RaydiumTokenService.findLastOne({ mint });

  let isJupiterTradable = false;
  let isPumpfunTradable = false;

  const jupiterSerivce = new JupiterService();
  if (!raydiumPoolInfo) {
    const jupiterTradeable = await jupiterSerivce.checkTradableOnJupiter(mint);
    if (!jupiterTradeable) {
      isPumpfunTradable = true;
    } else {
      isJupiterTradable = jupiterTradeable;
    }
  } else {
    const { creation_ts } = raydiumPoolInfo;
    const duration = Date.now() - creation_ts;
    // 120minutes
    if (duration < RAYDIUM_PASS_TIME) {
      isJupiterTradable = false;
    } else {
      const jupiterTradeable = await jupiterSerivce.checkTradableOnJupiter(
        mint
      );
      isJupiterTradable = jupiterTradeable;
    }
  }
  console.log("IsJupiterTradeable", isJupiterTradable);

  if (isPumpfunTradable) {
    const coinData = await getCoinData(mint);
    if (!coinData) {
      console.error("Failed to retrieve coin data...");
      return;
    }

    name = coinData["name"];
    symbol = coinData["symbol"];
    const metadata = await TokenService.getMintMetadata(
      private_connection,
      new PublicKey(mint)
    );
    if (!metadata) return;
    decimals = metadata.parsed.info.decimals;
    isToken2022 = metadata.program === "spl-token-2022";
  } else if (raydiumPoolInfo && !isJupiterTradable) {
    const metadata = await TokenService.getMintMetadata(
      private_connection,
      new PublicKey(mint)
    );
    if (!metadata) return;
    isToken2022 = metadata.program === "spl-token-2022";
    name = raydiumPoolInfo.name;
    symbol = raydiumPoolInfo.symbol;
    decimals = metadata.parsed.info.decimals;
    // }
  } else {
    const mintinfo = await TokenService.getMintInfo(mint);
    if (!mintinfo) return;
    isRaydium = false;
    name = mintinfo.overview.name || "";
    symbol = mintinfo.overview.symbol || "";
    decimals = mintinfo.overview.decimals || 9;
    isToken2022 = mintinfo.secureinfo.isToken2022;
  }

  const solprice = await TokenService.getSOLPrice();
  console.log("AutoBuy1:", Date.now());

  // send Notification
  const getcaption = (status: string, suffix: string = "") => {
    const securecaption =
      `<b>AutoBuy</b>\n\n🌳 Token: <b>${name ?? "undefined"} (${
        symbol ?? "undefined"
      })</b> ` +
      `${isToken2022 ? "<i>Token2022</i>" : ""}\n` +
      `<i>${copytoclipboard(mint)}</i>\n` +
      status +
      `💲 <b>Value: ${amount} SOL ($ ${(amount * solprice).toFixed(3)})</b>\n` +
      suffix;

    return securecaption;
  };
  const buycaption = getcaption(`🕒 <b>Buy in progress</b>\n`);

  const { sendMessageFiltered } = await import('../bot/screenGuard');
  const pendingTxMsg = await sendMessageFiltered(bot.telegram, chat_id, buycaption, { parse_mode: "HTML" });
  const pendingTxMsgId = (pendingTxMsg as any)?.message_id;
  console.log("Buy start:", Date.now());

  // buy token
  const raydiumService = new RaydiumSwapService();
  // const jupiterSerivce = new JupiterService();
  const quoteResult = isPumpfunTradable
    ? await pumpFunSwap(
        user.private_key,
        mint,
        decimals,
        true,
        amount,
        gasvalue,
        slippage,
        user.burn_fee ?? true,
        username,
        isToken2022
      )
    : isRaydium
    ? await raydiumService.swapToken(
        user.private_key,
        NATIVE_MINT.toString(),
        mint,
        decimals, // SOL decimal
        amount,
        slippage,
        gasvalue,
        user.burn_fee ?? true,
        username,
        isToken2022
      )
    : await jupiterSerivce.swapToken(
        user.private_key,
        NATIVE_MINT.toString(),
        mint,
        9, // SOL decimal
        amount,
        slippage,
        gasvalue,
        user.burn_fee ?? true,
        username,
        isToken2022
      );

  if (quoteResult) {
    const { signature, total_fee_in_sol, quote, bundleId } = quoteResult;
    const suffix = `📈 Txn: <a href="https://solscan.io/tx/${signature}">${signature}</a>\n`;

    // Here, we need to set Flag because of PNL calucation
    // while waiting for bundle verification, "position" collection
    // might be overlapped
    await setFlagForBundleVerify(user.wallet_address);

    // const status = await getSignatureStatus(signature);
    const jitoBundleInstance = new JitoBundleService();
    const status = await jitoBundleInstance.getBundleStatus(bundleId);
    let resultCaption;
    if (status) {
      resultCaption = getcaption(`🟢 <b>Buy Success</b>\n`, suffix);

      // Buy with SOL.
      const { inAmount, outAmount } = quote;
      const inAmountNum = fromWeiToValue(inAmount, 9);
      const outAmountNum = fromWeiToValue(outAmount, decimals);

      const pnlservice = new PNLService(user.wallet_address, mint);
      await pnlservice.afterBuy(inAmountNum, outAmountNum);

      // Update Referral System
      await checkReferralFeeSent(total_fee_in_sol, username);
    } else {
      resultCaption = getcaption(`🔴 <b>Buy Failed</b>\n`, suffix);
    }

    await bot.editMessageText(resultCaption, {
      message_id: pendingTxMsgId,
      chat_id,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: closeReplyMarkup.reply_markup as InlineKeyboardMarkup,
    });
  } else {
    const failedCaption = getcaption(`🔴 <b>Buy Failed</b>\n`);
    await bot.editMessageText(failedCaption, {
      message_id: pendingTxMsgId,
      chat_id,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: closeReplyMarkup.reply_markup as InlineKeyboardMarkup,
    });
  }
};

export const sellHandler = async (
  bot: TelegramBotType,
  msg: TelegramMessage,
  percent: number,
  reply_message_id?: number
) => {
  const chat_id = msg.chat.id;
  const username = msg.chat.username;
  if (!username) return;

  const user = await UserService.findOne({ username });
  if (!user) return;

  const msglog = await MsgLogService.findOne({
    username,
    msg_id: reply_message_id ?? msg.message_id,
  });

  if (!msglog) return;
  const { mint, spl_amount, sol_amount } = msglog;

  if (!mint) return;
  // check if enough includes fee
  if (sol_amount && sol_amount <= 0.0005) {
    bot
      .sendMessage(
        chat_id,
        "<b>⚠️ Insufficient SOL balance for gas fee!</b>",
        closeReplyMarkup
      )
      .then((sentMessage) => {
        setTimeout(() => {
          bot.deleteMessage(chat_id, sentMessage.message_id);
        }, 10000);
      });
    return;
  }

  let name = "";
  let symbol = "";
  let decimals = 9;
  let price = 0;
  let isToken2022 = false;
  let isRaydium = true;
  const raydiumPoolInfo = await RaydiumTokenService.findLastOne({ mint });
  const jupiterSerivce = new JupiterService();

  let isJupiterTradable = false;
  let isPumpfunTradable = false;
  if (!raydiumPoolInfo) {
    const jupiterTradeable = await jupiterSerivce.checkTradableOnJupiter(mint);
    if (!jupiterTradeable) {
      isPumpfunTradable = true;
    } else {
      isJupiterTradable = jupiterTradeable;
    }
  } else {
    const { creation_ts } = raydiumPoolInfo;
    const duration = Date.now() - creation_ts;
    // 120minutes
    if (duration < RAYDIUM_PASS_TIME) {
      isJupiterTradable = false;
    } else {
      const jupiterTradeable = await jupiterSerivce.checkTradableOnJupiter(
        mint
      );
      isJupiterTradable = jupiterTradeable;
    }
  }
  console.log("IsJupiterTradeable", isJupiterTradable);

  if (isPumpfunTradable) {
    const coinData = await getCoinData(mint);
    if (!coinData) {
      console.error("Failed to retrieve coin data...");
      return;
    }

    name = coinData["name"];
    symbol = coinData["symbol"];
    const metadata = await TokenService.getMintMetadata(
      private_connection,
      new PublicKey(mint)
    );
    if (!metadata) return;
    decimals = metadata.parsed.info.decimals;
    isToken2022 = metadata.program === "spl-token-2022";
  } else if (raydiumPoolInfo && !isJupiterTradable) {
    const metadata = await TokenService.getMintMetadata(
      private_connection,
      new PublicKey(mint)
    );
    if (!metadata) return;
    isToken2022 = metadata.program === "spl-token-2022";

    name = raydiumPoolInfo.name;
    symbol = raydiumPoolInfo.symbol;
    decimals = metadata.parsed.info.decimals;

    const priceInSOL = await getPriceInSOL(mint);

    const solprice = await TokenService.getSOLPrice();
    price = priceInSOL * solprice;
    // }
  } else {
    const mintinfo = await TokenService.getMintInfo(mint);
    if (!mintinfo) return;
    isRaydium = false;
    name = mintinfo.overview.name || "";
    symbol = mintinfo.overview.symbol || "";
    decimals = mintinfo.overview.decimals || 9;
    isToken2022 = mintinfo.secureinfo.isToken2022;
    price = mintinfo.overview.price || 0;
  }

  const splbalance = await TokenService.getSPLBalance(
    mint,
    user.wallet_address,
    isToken2022
  );
  const sellAmount = (splbalance * percent) / 100;

  // send Notification
  const getcaption = (status: string, suffix: string = "") => {
    const securecaption =
      `🌳 Token: <b>${name ?? "undefined"} (${symbol ?? "undefined"})</b> ` +
      `${isToken2022 ? "<i>Token2022</i>" : ""}\n` +
      `<i>${copytoclipboard(mint)}</i>\n` +
      status +
      `💲 <b>Value: ${sellAmount} ${symbol} ($ ${(sellAmount * price).toFixed(
        3
      )})</b>\n` +
      suffix;
    return securecaption;
  };

  const buycaption = getcaption(`🕒 <b>Sell in progress</b>\n`);
  const { sendMessageFiltered } = await import('../bot/screenGuard');
  const pendingMessage = await sendMessageFiltered(bot.telegram, chat_id, buycaption, { parse_mode: "HTML" });

  // sell token
  const { slippage } = await UserTradeSettingService.getSlippage(
    username
    // mint
  );
  const gassetting = await UserTradeSettingService.getGas(username);
  const gasvalue = UserTradeSettingService.getGasValue(gassetting);
  const raydiumService = new RaydiumSwapService();
  // const jupiterSerivce = new JupiterService();
  const quoteResult = isPumpfunTradable
    ? await pumpFunSwap(
        user.private_key,
        mint,
        decimals,
        false,
        sellAmount,
        gasvalue,
        slippage,
        user.burn_fee ?? true,
        username,
        isToken2022
      )
    : isRaydium
    ? await raydiumService.swapToken(
        user.private_key,
        mint,
        NATIVE_MINT.toString(),
        decimals,
        sellAmount,
        slippage,
        gasvalue,
        user.burn_fee ?? true,
        username,
        isToken2022
      )
    : await jupiterSerivce.swapToken(
        user.private_key,
        mint,
        NATIVE_MINT.toString(),
        decimals,
        sellAmount,
        slippage,
        gasvalue,
        user.burn_fee ?? true,
        username,
        isToken2022
      );

  if (quoteResult) {
    const { signature, total_fee_in_sol, quote, bundleId } = quoteResult;
    const suffix = `📈 Txn: <a href="https://solscan.io/tx/${signature}">${signature}</a>\n`;

    // Here, we need to set Flag because of PNL calucation
    // while waiting for bundle verification, "position" collection
    // might be overlapped
    await setFlagForBundleVerify(user.wallet_address);
    // const status = await getSignatureStatus(signature);
    const jitoBundleInstance = new JitoBundleService();
    const status = await jitoBundleInstance.getBundleStatus(bundleId);
    let resultCaption;
    if (status) {
      resultCaption = getcaption(`🟢 <b>Sell Success</b>\n`, suffix);
      // Sell token for SOL.
      const { inAmount, outAmount } = quote;
      const inAmountNum = fromWeiToValue(inAmount, decimals);
      const outAmountNum = fromWeiToValue(outAmount, 9);
      const quoteValue = {
        inAmount: inAmountNum,
        outAmount: outAmountNum,
      } as QuoteRes;

      const pnlService = new PNLService(user.wallet_address, mint, quoteValue);
      await pnlService.initialize();
      const pnldata = await pnlService.getPNLInfo();

      //send pnl Card
      let profitInSOL = 0;
      let pnlPercent = 0;
      const boughtInSOL = (await pnlService.getBoughtAmount()) as number;
      const boughtAmount = Number((boughtInSOL * percent) / 100).toFixed(2);
      if (pnldata) {
        const { profitInSOL: profitSol, percent } = pnldata;
        profitInSOL = profitSol;
        pnlPercent = percent;
      }
      const solPrice = await TokenService.getSOLPrice();
      const profitInUSD = profitInSOL * Number(solPrice);
      const referrerCode = await GenerateReferralCode(user.username);
      const pnlData = {
        chatId: chat_id,
        pairTitle: `${symbol}/SOL`,
        boughtAmount,
        pnlValue: profitInSOL.toFixed(2),
        worth: Math.abs(profitInUSD).toFixed(2),
        profitPercent: pnlPercent.toFixed(2),
        burnAmount: Number(0).toFixed(2),
        isBuy: false,
        referralLink: `https://t.me/${TradeBotID}?start=${referrerCode}`,
      };
      const { pnlUrl } = await pnlService.getPNLCard(pnlData);
      await bot.sendPhoto(msg.chat.id, pnlUrl, {
        parse_mode: "HTML",
      });
      await pnlService.afterSell(outAmountNum, percent);
      // Update Referral System
      await checkReferralFeeSent(total_fee_in_sol, username);
    } else {
      resultCaption = getcaption(`🔴 <b>Sell Failed</b>\n`, suffix);
    }
    await bot.editMessageText(resultCaption, {
      message_id: pendingMessage.message_id,
      chat_id,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: closeReplyMarkup.reply_markup as InlineKeyboardMarkup,
    });
  } else {
    const failedCaption = getcaption(`🔴 <b>Sell Failed</b>\n`);
    try {
      await bot.editMessageText(failedCaption, {
        message_id: pendingMessage.message_id,
        chat_id,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: closeReplyMarkup.reply_markup as InlineKeyboardMarkup,
      });
    } catch (e) {}
  }
};

export const setSlippageHandler = async (
  bot: TelegramBotType,
  msg: TelegramMessage,
  percent: number,
  reply_message_id: number
) => {
  const chat_id = msg.chat.id;
  const username = msg.chat.username;
  if (!username) return;

  const msglog = await MsgLogService.findOne({
    username,
    msg_id: reply_message_id,
  });
  if (!msglog) return;
  const { mint, parent_msgid, msg_id } = msglog;

  if (!mint) return;
  // mint,
  await UserTradeSettingService.setSlippage(username, {
    slippage: percent,
    slippagebps: percent * 100,
  });

  const user = await UserService.findOne({ username });
  if (!user) return;
  const { auto_buy, auto_buy_amount } = user;

  const reply_markup = await getReplyOptionsForSettings(
    username,
    auto_buy,
    auto_buy_amount
  );

  await bot.editMessageReplyMarkup(reply_markup, {
    message_id: parent_msgid,
    chat_id,
  });
  bot.deleteMessage(chat_id, msg_id);
  bot.deleteMessage(chat_id, msg.message_id);
};

const getTokenMintFromCallback = (caption: string | undefined) => {
  if (caption === undefined || caption === "") return null;
  const data = caption.split("\n")[1];
  if (data === undefined) return null;
  return data as string;
};

// Deprecated: Don't use this
export const feeHandler = async (
  total_fee_in_sol: number,
  total_fee_in_token: number,
  username: string,
  pk: string,
  mint: string,
  isToken2022: boolean
) => {
  if (username) return;
  try {
    const wallet = Keypair.fromSecretKey(bs58.decode(pk));
    // Route all fees to BOT_WALLET_ADDRESS per new policy
    const botWalletAddr = process.env.BOT_WALLET_ADDRESS;
    if (!botWalletAddr) {
      console.warn('BOT_WALLET_ADDRESS not set; feeHandler will not route fees to bot.');
    }
    const referralFee = 0;
    const reserverStakingFee = Number(total_fee_in_sol || 0);

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 10000,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 50000,
      }),
    ];
    if (reserverStakingFee > 0 && botWalletAddr) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(botWalletAddr),
          lamports: reserverStakingFee,
        })
      );
    }

    if (total_fee_in_token && botWalletAddr) {
      try {
        const botPub = new PublicKey(botWalletAddr);
        const botAta = getAssociatedTokenAddressSync(new PublicKey(mint), botPub, true);
        const ownerAta = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey, true);
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, botAta, botPub, new PublicKey(mint)));
        instructions.push(createTransferInstruction(ownerAta, botAta, wallet.publicKey, Number(total_fee_in_token), [], isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID));
      } catch (e) {
        console.warn('Failed to route token fees to bot ATA in feeHandler:', e?.message || e);
      }
    }
  } catch (e) {
    console.log("- Fee handler has issue", e);
  }
};
