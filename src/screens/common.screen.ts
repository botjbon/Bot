let TelegramBot: any;
let SendMessageOptions: any;
try { const _tg = require('node-telegram-bot-api'); TelegramBot = _tg.default || _tg; SendMessageOptions = (_tg as any).SendMessageOptions || undefined; } catch (e) {}
type TelegramBotType = any;
type TelegramMessage = any;

export const closeReplyMarkup: any = {
  parse_mode: "HTML",
  disable_web_page_preview: true,
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "❌ Close",
          callback_data: JSON.stringify({
            command: "dismiss_message",
          }),
        },
      ],
    ],
  },
} as SendMessageOptions;

export const closeInlinekeyboardOpts = {
  text: "❌ Close",
  callback_data: JSON.stringify({
    command: "dismiss_message",
  }),
};

export const sendNoneUserNotification = async (
  bot: TelegramBotType,
  msg: TelegramMessage
) => {
  const { id: chat_id } = msg.chat;
    const { sendMessageFiltered } = await import('../bot/screenGuard');
    const sentMsg = await sendMessageFiltered(bot.telegram, chat_id, "⚠︎ Error\n<b>This account does not exist. Please contact support team.</b>", closeReplyMarkup);
  deleteDelayMessage(bot, chat_id, sentMsg.message_id, 5000);
};

export const sendNoneExistTokenNotification = async (
  bot: TelegramBotType,
  msg: TelegramMessage
) => {
  const { id: chat_id } = msg.chat;
    const { sendMessageFiltered } = await import('../bot/screenGuard');
    const sentMsg = await sendMessageFiltered(bot.telegram, chat_id, "⚠︎ Error\n<b>This token does not exist. Please verify the mint address again or try later.</b>", { parse_mode: "HTML" });
  deleteDelayMessage(bot, chat_id, sentMsg.message_id, 5000);
};

export const sendInsufficientNotification = async (
  bot: TelegramBotType,
  msg: TelegramMessage
) => {
  const { id: chat_id } = msg.chat;
    const { sendMessageFiltered } = await import('../bot/screenGuard');
    const sentMsg = await sendMessageFiltered(bot.telegram, chat_id, "⚠︎ Error\n<b>Insufficient amount.</b>", { parse_mode: "HTML" });
  deleteDelayMessage(bot, chat_id, sentMsg.message_id, 5000);
};

export const sendUsernameRequiredNotification = async (
  bot: TelegramBotType,
  msg: TelegramMessage
) => {
  const { id: chat_id } = msg.chat;
    const { sendMessageFiltered } = await import('../bot/screenGuard');
    const sentMsg = await sendMessageFiltered(bot.telegram, chat_id, "⚠︎ Error\n<b>You have no telegram username yourself. Please edit your profile and try it again.</b>", closeReplyMarkup);
};

// delay: ms
export const deleteDelayMessage = (
  bot: TelegramBotType,
  chat_id: number,
  message_id: number,
  delay: number
) => {
  try {
    setTimeout(() => {
      bot.deleteMessage(chat_id, message_id);
    }, delay);
  } catch (e) {}
};
