const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '').trim();
const DB_PATH = path.resolve(
  process.env.DB_PATH || './database/xeen.db'
);

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN မတွေ့ပါ။ .env ကိုစစ်ပါ။');
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error('❌ ADMIN_ID မတွေ့ပါ။ .env ကိုစစ်ပါ။');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ Database မတွေ့ပါ: ${DB_PATH}`);
  console.error('အရင် run: node database/init.js');
  process.exit(1);
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function exec(sql) {
  return execFileSync('sqlite3', [DB_PATH], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
}

function rows(sql) {
  const output = execFileSync(
    'sqlite3',
    ['-json', DB_PATH],
    {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    }
  ).trim();

  if (!output) return [];

  try {
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function one(sql) {
  return rows(sql)[0] || null;
}

function isAdmin(msg) {
  return String(msg.from.id) === ADMIN_ID;
}

function generateUserId() {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function part(length) {
    let result = '';

    for (let i = 0; i < length; i++) {
      result += chars[
        crypto.randomInt(chars.length)
      ];
    }

    return result;
  }

  return `${part(5)} ${part(3)}`;
}

function createUser() {
  for (let i = 0; i < 20; i++) {
    const userId = generateUserId();

    try {
      exec(`
        INSERT INTO users(user_id, coin)
        VALUES(
          '${sqlEscape(userId)}',
          0
        );
      `);

      return one(`
        SELECT *
        FROM users
        WHERE user_id='${sqlEscape(userId)}'
        LIMIT 1;
      `);
    } catch {
      // ID collision হলে retry
    }
  }

  throw new Error('User ID generate failed');
}

function getOrCreateTelegramUser(msg) {
  const telegramId = String(msg.from.id);
  const username = msg.from.username || '';

  let user = one(`
    SELECT *
    FROM users
    WHERE telegram_id='${sqlEscape(telegramId)}'
    LIMIT 1;
  `);

  if (user) {
    exec(`
      UPDATE users
      SET telegram_username='${sqlEscape(username)}',
          updated_at=CURRENT_TIMESTAMP
      WHERE telegram_id='${sqlEscape(telegramId)}';
    `);

    return one(`
      SELECT *
      FROM users
      WHERE telegram_id='${sqlEscape(telegramId)}'
      LIMIT 1;
    `);
  }

  user = createUser();

  exec(`
    UPDATE users
    SET telegram_id='${sqlEscape(telegramId)}',
        telegram_username='${sqlEscape(username)}',
        updated_at=CURRENT_TIMESTAMP
    WHERE user_id='${sqlEscape(user.user_id)}';
  `);

  return one(`
    SELECT *
    FROM users
    WHERE user_id='${sqlEscape(user.user_id)}'
    LIMIT 1;
  `);
}

function normalizeUserId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function findUser(identifier) {
  const value = normalizeUserId(identifier);

  if (!value) return null;

  return one(`
    SELECT *
    FROM users
    WHERE
      REPLACE(
        UPPER(user_id),
        ' ',
        ''
      )='${sqlEscape(value)}'
    OR
      telegram_id='${sqlEscape(value)}'
    LIMIT 1;
  `);
}

function formatDate(value) {
  if (!value) return '-';

  const date = new Date(
    String(value).replace(' ', 'T') + 'Z'
  );

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(
    'en-GB',
    {
      timeZone: 'Asia/Yangon',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }
  ).format(date);
}

function formatUserInfo(user) {
  return [
    '👤 User Information',
    '',
    `🆔 User ID: ${user.user_id}`,
    `🪙 Coin: ${Number(user.coin)}`,
    `📅 Created: ${formatDate(user.created_at)}`,
    `🔄 Updated: ${formatDate(user.updated_at)}`
  ].join('\n');
}

function adminKeyboard() {
  return {
    keyboard: [
      [
        {
          text: 'Add Coin 🪙'
        },
        {
          text: 'Remove Coin 🪙'
        }
      ],
      [
        {
          text: 'User info'
        }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function userKeyboard() {
  return {
    keyboard: [
      [
        {
          text: '🆔 My ID'
        },
        {
          text: '🪙 My Coin'
        }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function sendAdminPanel(chatId) {
  return bot.sendMessage(
    chatId,
    '⚙️ Xeen AI Admin Panel\n\nလုပ်ဆောင်လိုသော Action ကိုရွေးပါ။',
    {
      reply_markup: adminKeyboard()
    }
  );
}

function sendUserPanel(chatId) {
  return bot.sendMessage(
    chatId,
    '🚀 Xeen AI Mini Predictor\n\nMenu ကိုရွေးပါ။',
    {
      reply_markup: userKeyboard()
    }
  );
}

function addCoins(user, amount, adminId) {
  const current = Number(user.coin);
  const newBalance = current + amount;

  exec(`
    BEGIN TRANSACTION;

    UPDATE users
    SET
      coin=${newBalance},
      updated_at=CURRENT_TIMESTAMP
    WHERE user_id='${sqlEscape(user.user_id)}';

    INSERT INTO coin_transactions
    (
      user_id,
      amount,
      balance_after,
      type,
      note
    )
    VALUES
    (
      '${sqlEscape(user.user_id)}',
      ${amount},
      ${newBalance},
      'ADMIN_ADD',
      '${sqlEscape(
        `Admin ${adminId} added ${amount} coins`
      )}'
    );

    COMMIT;
  `);

  return newBalance;
}

function removeCoins(user, amount, adminId) {
  const current = Number(user.coin);

  if (amount > current) {
    return null;
  }

  const newBalance = current - amount;

  exec(`
    BEGIN TRANSACTION;

    UPDATE users
    SET
      coin=${newBalance},
      updated_at=CURRENT_TIMESTAMP
    WHERE user_id='${sqlEscape(user.user_id)}';

    INSERT INTO coin_transactions
    (
      user_id,
      amount,
      balance_after,
      type,
      note
    )
    VALUES
    (
      '${sqlEscape(user.user_id)}',
      ${-amount},
      ${newBalance},
      'ADMIN_REMOVE',
      '${sqlEscape(
        `Admin ${adminId} removed ${amount} coins`
      )}'
    );

    COMMIT;
  `);

  return newBalance;
}

const bot = new TelegramBot(
  BOT_TOKEN,
  {
    polling: true
  }
);

console.log('======================================');
console.log(' XEEN AI MINI PREDICTOR BOT');
console.log(' Telegram Bot Started');
console.log('======================================');

const adminState = new Map();

function setState(telegramId, state) {
  adminState.set(String(telegramId), state);
}

function getState(telegramId) {
  return adminState.get(String(telegramId));
}

function clearState(telegramId) {
  adminState.delete(String(telegramId));
}

/* =========================
   START
========================= */

bot.onText(
  /^\/start(?:\s+.*)?$/i,
  async (msg) => {
    try {
      const user =
        getOrCreateTelegramUser(msg);

      if (isAdmin(msg)) {
        await bot.sendMessage(
          msg.chat.id,
          [
            '👑 Admin Account',
            '',
            `🆔 User ID: ${user.user_id}`,
            `🪙 Coin: ${Number(user.coin)}`
          ].join('\n'),
          {
            reply_markup: adminKeyboard()
          }
        );
      } else {
        await bot.sendMessage(
          msg.chat.id,
          [
            '🚀 Xeen AI Mini Predictor',
            '',
            `🆔 User ID: ${user.user_id}`,
            `🪙 Coin: ${Number(user.coin)}`
          ].join('\n'),
          {
            reply_markup: userKeyboard()
          }
        );
      }
    } catch (error) {
      console.error('/start:', error);

      bot.sendMessage(
        msg.chat.id,
        '❌ Account setup failed.'
      );
    }
  }
);

/* =========================
   ID
========================= */

bot.onText(
  /^\/id$/i,
  (msg) => {
    try {
      const user =
        getOrCreateTelegramUser(msg);

      bot.sendMessage(
        msg.chat.id,
        [
          '🆔 Your Website User ID',
          '',
          user.user_id,
          '',
          `🪙 Coin: ${Number(user.coin)}`
        ].join('\n')
      );
    } catch (error) {
      console.error('/id:', error);

      bot.sendMessage(
        msg.chat.id,
        '❌ Error ဖြစ်သွားပါတယ်။'
      );
    }
  }
);

/* =========================
   ADD COIN BUTTON
========================= */

bot.on(
  'message',
  async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    const text = msg.text.trim();

    if (!isAdmin(msg)) {
      if (text === '🆔 My ID') {
        const user =
          getOrCreateTelegramUser(msg);

        return bot.sendMessage(
          msg.chat.id,
          [
            '🆔 Your Website User ID',
            '',
            user.user_id,
            '',
            `🪙 Coin: ${Number(user.coin)}`
          ].join('\n')
        );
      }

      if (text === '🪙 My Coin') {
        const user =
          getOrCreateTelegramUser(msg);

        return bot.sendMessage(
          msg.chat.id,
          `🪙 Your Coin: ${Number(user.coin)}`
        );
      }

      return;
    }

    /* -------------------------
       ADMIN: ADD COIN
    ------------------------- */

    if (text === 'Add Coin 🪙') {
      clearState(msg.from.id);

      setState(
        msg.from.id,
        {
          action: 'add',
          step: 'user'
        }
      );

      return bot.sendMessage(
        msg.chat.id,
        [
          '🪙 Coin ဖြည့်ရန်',
          '',
          'User ID ပို့ပါ။',
          '',
          'ဥပမာ:',
          'ASYZW LPN'
        ].join('\n'),
        {
          reply_markup: {
            keyboard: [
              [
                {
                  text: '❌ Cancel'
                }
              ]
            ],
            resize_keyboard: true
          }
        }
      );
    }

    /* -------------------------
       ADMIN: REMOVE COIN
    ------------------------- */

    if (text === 'Remove Coin 🪙') {
      clearState(msg.from.id);

      setState(
        msg.from.id,
        {
          action: 'remove',
          step: 'user'
        }
      );

      return bot.sendMessage(
        msg.chat.id,
        [
          '🪙 Coin ဖြုတ်ရန်',
          '',
          'User ID ပို့ပါ။',
          '',
          'ဥပမာ:',
          'ASYZW LPN'
        ].join('\n'),
        {
          reply_markup: {
            keyboard: [
              [
                {
                  text: '❌ Cancel'
                }
              ]
            ],
            resize_keyboard: true
          }
        }
      );
    }

    /* -------------------------
       ADMIN: USER INFO
    ------------------------- */

    if (text === 'User info') {
      clearState(msg.from.id);

      setState(
        msg.from.id,
        {
          action: 'info',
          step: 'user'
        }
      );

      return bot.sendMessage(
        msg.chat.id,
        [
          '👤 User Information',
          '',
          'User ID ပို့ပါ။',
          '',
          'ဥပမာ:',
          'ASYZW LPN'
        ].join('\n'),
        {
          reply_markup: {
            keyboard: [
              [
                {
                  text: '❌ Cancel'
                }
              ]
            ],
            resize_keyboard: true
          }
        }
      );
    }

    /* -------------------------
       CANCEL
    ------------------------- */

    if (text === '❌ Cancel') {
      clearState(msg.from.id);

      return sendAdminPanel(
        msg.chat.id
      );
    }

    /* -------------------------
       STATE HANDLER
    ------------------------- */

    const state =
      getState(msg.from.id);

    if (!state) return;

    /* USER ID STEP */

    if (
      state.step === 'user'
    ) {
      const user =
        findUser(text);

      if (!user) {
        return bot.sendMessage(
          msg.chat.id,
          [
            '❌ User မတွေ့ပါ',
            '',
            `User ID: ${text}`,
            '',
            'မှန်ကန်သော User ID ပြန်ပို့ပါ။'
          ].join('\n')
        );
      }

      if (state.action === 'info') {
        clearState(msg.from.id);

        await bot.sendMessage(
          msg.chat.id,
          formatUserInfo(user),
          {
            reply_markup:
              adminKeyboard()
          }
        );

        return;
      }

      state.userId =
        user.user_id;

      state.step = 'amount';

      setState(
        msg.from.id,
        state
      );

      return bot.sendMessage(
        msg.chat.id,
        [
          state.action === 'add'
            ? '🪙 Coin ဖြည့်ရန်'
            : '🪙 Coin ဖြုတ်ရန်',
          '',
          `User ID: ${user.user_id}`,
          `Current Coin: ${Number(user.coin)}`,
          '',
          'Amount ပို့ပါ။',
          '',
          'ဥပမာ:',
          '100'
        ].join('\n'),
        {
          reply_markup: {
            keyboard: [
              [
                {
                  text: '❌ Cancel'
                }
              ]
            ],
            resize_keyboard: true
          }
        }
      );
    }

    /* AMOUNT STEP */

    if (
      state.step === 'amount'
    ) {
      if (!/^\d+$/.test(text)) {
        return bot.sendMessage(
          msg.chat.id,
          '❌ Amount မှာ နံပါတ်ပဲ ထည့်ပါ။\nဥပမာ: 100'
        );
      }

      const amount =
        Number(text);

      if (
        !Number.isSafeInteger(amount) ||
        amount <= 0
      ) {
        return bot.sendMessage(
          msg.chat.id,
          '❌ Amount မမှန်ပါ။'
        );
      }

      const user =
        findUser(state.userId);

      if (!user) {
        clearState(msg.from.id);

        return bot.sendMessage(
          msg.chat.id,
          '❌ User မတွေ့တော့ပါ။'
        );
      }

      if (state.action === 'add') {
        const balance =
          addCoins(
            user,
            amount,
            msg.from.id
          );

        clearState(msg.from.id);

        return bot.sendMessage(
          msg.chat.id,
          [
            '✅ Coin ဖြည့်ပြီးပါပြီ',
            '',
            `🆔 User ID: ${user.user_id}`,
            `➕ Added: 🪙 ${amount}`,
            `🪙 Balance: ${balance}`
          ].join('\n'),
          {
            reply_markup:
              adminKeyboard()
          }
        );
      }

      if (state.action === 'remove') {
        const balance =
          removeCoins(
            user,
            amount,
            msg.from.id
          );

        if (balance === null) {
          return bot.sendMessage(
            msg.chat.id,
            [
              '❌ Coin မလုံလောက်ပါ',
              '',
              `🆔 User ID: ${user.user_id}`,
              `🪙 Current: ${Number(user.coin)}`,
              `➖ Requested: ${amount}`
            ].join('\n')
          );
        }

        clearState(msg.from.id);

        return bot.sendMessage(
          msg.chat.id,
          [
            '✅ Coin ဖြုတ်ပြီးပါပြီ',
            '',
            `🆔 User ID: ${user.user_id}`,
            `➖ Removed: 🪙 ${amount}`,
            `🪙 Balance: ${balance}`
          ].join('\n'),
          {
            reply_markup:
              adminKeyboard()
          }
        );
      }
    }
  }
);

bot.on(
  'polling_error',
  (error) => {
    console.error(
      'Telegram polling error:',
      error.message
    );
  }
);

process.on(
  'uncaughtException',
  (error) => {
    console.error(
      'Uncaught Exception:',
      error
    );
  }
);

process.on(
  'unhandledRejection',
  (error) => {
    console.error(
      'Unhandled Rejection:',
      error
    );
  }
);

