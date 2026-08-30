const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

require('dotenv').config();

const app = express();

const PORT = Number(process.env.PORT || 3000);

const DB_PATH = path.resolve(
  process.env.DB_PATH || './database/xeen.db'
);

const SESSION_SECRET = process.env.SESSION_SECRET || '';

const PREDICT_COST = Math.max(
  0,
  Number.parseInt(process.env.PREDICT_COST || '1', 10)
);

const DATASET_SIZE = Math.max(
  1000,
  Number.parseInt(process.env.DATASET_SIZE || '1200', 10)
);

if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error(
    'ERROR: SESSION_SECRET is missing or too short. Set it in .env'
  );
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(
    `ERROR: Database not found: ${DB_PATH}`
  );
  console.error(
    'Run: node database/init.js'
  );
  process.exit(1);
}

/* =========================================================
   SQLITE HELPERS
========================================================= */

const SQLITE_BIN =
  process.env.SQLITE_BIN ||
  '/data/data/com.termux/files/usr/bin/sqlite3';

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function runSQL(sql) {
  try {
    return execFileSync(
      SQLITE_BIN,
      ['-json', DB_PATH],
      {
        input: sql,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      }
    ).trim();
  } catch (error) {
    console.error(
      'SQLite error:',
      error.stderr || error.message
    );

    throw new Error(
      'Database operation failed'
    );
  }
}

function rows(sql) {
  const output = runSQL(sql);

  if (!output) {
    return [];
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    console.error(
      'SQLite JSON parse error:',
      error.message
    );

    return [];
  }
}

function one(sql) {
  return rows(sql)[0] || null;
}

function exec(sql) {
  try {
    return execFileSync(
      SQLITE_BIN,
      [DB_PATH],
      {
        input: sql,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      }
    );
  } catch (error) {
    console.error(
      'SQLite exec error:',
      error.stderr || error.message
    );

    throw new Error(
      'Database operation failed'
    );
  }
}

/* =========================================================
   USER / SESSION
========================================================= */

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

function getOrCreateUser() {
  let user = null;

  for (let i = 0; i < 20; i++) {
    const userId = generateUserId();

    try {
      exec(`
        INSERT INTO users(
          user_id,
          coin
        )
        VALUES(
          '${sqlEscape(userId)}',
          0
        );
      `);

      user = one(`
        SELECT
          id,
          user_id,
          coin,
          telegram_id,
          telegram_username,
          created_at,
          updated_at
        FROM users
        WHERE user_id='${sqlEscape(userId)}'
        LIMIT 1;
      `);

      if (user) {
        break;
      }
    } catch {
      // ID collision - retry
    }
  }

  if (!user) {
    throw new Error(
      'Unable to create user'
    );
  }

  return user;
}

function signUserId(userId) {
  return crypto
    .createHmac(
      'sha256',
      SESSION_SECRET
    )
    .update(userId)
    .digest('hex');
}

function makeSession(userId) {
  return (
    `${Buffer
      .from(userId)
      .toString('base64url')}.${signUserId(userId)}`
  );
}

function verifySession(token) {
  if (
    !token ||
    typeof token !== 'string'
  ) {
    return null;
  }

  const dot =
    token.lastIndexOf('.');

  if (dot === -1) {
    return null;
  }

  const encoded =
    token.slice(0, dot);

  const signature =
    token.slice(dot + 1);

  let userId;

  try {
    userId =
      Buffer
        .from(encoded, 'base64url')
        .toString('utf8');
  } catch {
    return null;
  }

  const expected =
    signUserId(userId);

  if (
    signature.length !==
    expected.length
  ) {
    return null;
  }

  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) {
    return null;
  }

  return userId;
}

/* =========================================================
   NORMALIZATION
========================================================= */

function normalizeGame(game) {
  const value =
    String(game || '')
      .trim()
      .toUpperCase();

  if (
    value === '777' ||
    value === '777_BIG_WIN'
  ) {
    return '777';
  }

  if (
    value === 'MINI' ||
    value === 'MINI_GAME'
  ) {
    return 'MINI';
  }

  return null;
}

function normalizeMode(mode) {
  const value =
    String(mode || '')
      .trim()
      .toUpperCase();

  if (value === 'WINGO') {
    return 'WINGO';
  }

  if (value === 'TRX') {
    return 'TRX';
  }

  return null;
}

function normalizeInput(input) {
  const value =
    String(input || '').trim();

  if (!/^\d{2}$/.test(value)) {
    return null;
  }

  return value;
}

function classifyDigit(digit) {
  return Number(digit) >= 5
    ? 'BIG'
    : 'SMALL';
}

/* =========================================================
   FAST DATA ANALYSIS
=========================================================

   Input:
      32

   Find:
      ... 3
      ... 2
      ... NEXT

   Then calculate NEXT results.

   IMPORTANT:
   Dataset is always isolated by:
      777 + WINGO
      777 + TRX
      MINI + WINGO
      MINI + TRX
========================================================= */

function analyzeHistory(
  game,
  mode,
  input
) {
  const firstDigit =
    Number(input[0]);

  const secondDigit =
    Number(input[1]);

  /*
   * Get only the selected dataset.
   *
   * ORDER BY id ASC is important because:
   *
   * previous -> current -> next
   */
  const data = rows(`
    SELECT
      id,
      round_id,
      result,
      size,
      created_at
    FROM game_data
    WHERE dataset='${sqlEscape(game)}'
      AND mode='${sqlEscape(mode)}'
    ORDER BY id ASC;
  `);

  let big = 0;
  let small = 0;

  const digitCounts =
    Array.from(
      { length: 10 },
      () => 0
    );

  const matchedHistory = [];

  /*
   * Need:
   *
   * data[i]     = first digit
   * data[i + 1] = second digit
   * data[i + 2] = next result
   */
  for (
    let i = 0;
    i < data.length - 2;
    i++
  ) {
    const first =
      Math.abs(
        Number(data[i].result)
      ) % 10;

    const second =
      Math.abs(
        Number(data[i + 1].result)
      ) % 10;

    if (
      first !== firstDigit ||
      second !== secondDigit
    ) {
      continue;
    }

    const next =
      data[i + 2];

    const nextDigit =
      Math.abs(
        Number(next.result)
      ) % 10;

    digitCounts[nextDigit]++;

    if (
      classifyDigit(nextDigit) ===
      'BIG'
    ) {
      big++;
    } else {
      small++;
    }

    matchedHistory.push({
      first: data[i].result,
      second: data[i + 1].result,
      next: next.result,
      size: next.size,
      round: next.round_id
    });
  }

  const total =
    big + small;

  let prediction =
    'NO DATA';

  let percentage = 0;

  if (total > 0) {
    if (big >= small) {
      prediction = 'BIG';

      percentage =
        (big / total) * 100;
    } else {
      prediction = 'SMALL';

      percentage =
        (small / total) * 100;
    }
  }

  const digits =
    digitCounts.map(
      (count, digit) => ({
        digit,
        count,
        percentage: total
          ? Number(
              (
                (count / total) *
                100
              ).toFixed(2)
            )
          : 0
      })
    );

  return {
    prediction,

    percentage:
      Number(
        percentage.toFixed(2)
      ),

    matched: total,

    big,

    small,

    digits,

    history:
      matchedHistory
        .slice(-20)
        .reverse()
  };
}

/* =========================================================
   USER FROM REQUEST
========================================================= */

function getUserFromRequest(req) {
  const auth =
    req.headers.authorization || '';

  if (
    !auth.startsWith('Bearer ')
  ) {
    return null;
  }

  const token =
    auth.slice(7).trim();

  const userId =
    verifySession(token);

  if (!userId) {
    return null;
  }

  return one(`
    SELECT
      id,
      user_id,
      coin,
      telegram_id,
      telegram_username,
      created_at,
      updated_at
    FROM users
    WHERE user_id='${sqlEscape(userId)}'
    LIMIT 1;
  `);
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  express.json({
    limit: '32kb'
  })
);

app.use(
  express.urlencoded({
    extended: false
  })
);

app.use(
  (req, res, next) => {
    res.setHeader(
      'X-Content-Type-Options',
      'nosniff'
    );

    res.setHeader(
      'X-Frame-Options',
      'SAMEORIGIN'
    );

    res.setHeader(
      'Referrer-Policy',
      'strict-origin-when-cross-origin'
    );

    next();
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (req, res) => {
    try {
      const db =
        one('SELECT 1 AS ok;');

      res.json({
        ok: true,
        server:
          'xeen-ai-mini-predictor',
        node:
          process.version,
        database:
          Boolean(
            db && db.ok === 1
          ),
        time:
          new Date().toISOString()
      });
    } catch (error) {
      console.error(
        'Health error:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          'Database unavailable'
      });
    }
  }
);

/* =========================================================
   SESSION
========================================================= */

app.post(
  '/api/session',
  (req, res) => {
    try {
      const existingToken =
        req.headers.authorization
          ?.startsWith('Bearer ')
          ? req.headers.authorization
              .slice(7)
              .trim()
          : null;

      if (existingToken) {
        const existingUserId =
          verifySession(
            existingToken
          );

        if (existingUserId) {
          const existingUser =
            one(`
              SELECT
                id,
                user_id,
                coin,
                telegram_id,
                telegram_username,
                created_at,
                updated_at
              FROM users
              WHERE user_id='${sqlEscape(
                existingUserId
              )}'
              LIMIT 1;
            `);

          if (existingUser) {
            return res.json({
              ok: true,
              session:
                existingToken,
              user:
                existingUser
            });
          }
        }
      }

      const user =
        getOrCreateUser();

      const session =
        makeSession(
          user.user_id
        );

      res.status(201).json({
        ok: true,
        session,
        user
      });
    } catch (error) {
      console.error(
        'Session error:',
        error
      );

      res.status(500).json({
        ok: false,
        error:
          'Unable to create session'
      });
    }
  }
);

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  '/api/me',
  (req, res) => {
    const user =
      getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error:
          'Invalid or missing session'
      });
    }

    res.json({
      ok: true,
      user
    });
  }
);

/* =========================================================
   ANALYZE
========================================================= */

app.post(
  '/api/analyze',
  (req, res) => {
    const started =
      Date.now();

    console.log(
      'ANALYZE REQUEST:',
      {
        game: req.body?.game,
        mode: req.body?.mode,
        input: req.body?.input
      }
    );

    const user =
      getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error:
          'Invalid or missing session'
      });
    }

    const game =
      normalizeGame(
        req.body?.game
      );

    const mode =
      normalizeMode(
        req.body?.mode
      );

    const input =
      normalizeInput(
        req.body?.input
      );

    if (!game) {
      return res.status(400).json({
        ok: false,
        error:
          'Invalid game'
      });
    }

    if (!mode) {
      return res.status(400).json({
        ok: false,
        error:
          'Invalid mode'
      });
    }

    if (!input) {
      return res.status(400).json({
        ok: false,
        error:
          'Input must contain exactly 2 digits'
      });
    }

    /*
     * Check selected dataset only.
     */
    const datasetCount =
      one(`
        SELECT COUNT(*) AS count
        FROM game_data
        WHERE dataset='${sqlEscape(game)}'
          AND mode='${sqlEscape(mode)}';
      `);

    const count =
      Number(
        datasetCount?.count || 0
      );

    console.log(
      `DATASET ${game}/${mode}: ${count} records`
    );

    if (
      count < DATASET_SIZE
    ) {
      return res.status(503).json({
        ok: false,
        error:
          'Selected dataset is not ready',
        dataset:
          game,
        mode,
        available:
          count,
        required:
          DATASET_SIZE
      });
    }

    if (
      Number(user.coin) <
      PREDICT_COST
    ) {
      return res.status(402).json({
        ok: false,
        error:
          'Coin မလုံလောက်ပါ',
        code:
          'INSUFFICIENT_COIN',
        current_coin:
          Number(user.coin),
        cost:
          PREDICT_COST
      });
    }

    try {
      /*
       * FAST ANALYSIS
       */
      const result =
        analyzeHistory(
          game,
          mode,
          input
        );

      /*
       * If there is no historical pair,
       * do not charge the user.
       */
      if (result.matched === 0) {
        console.log(
          `NO MATCH: ${game}/${mode}/${input}`
        );

        return res.json({
          ok: true,
          game,
          mode,
          input,
          result,
          cost: 0,
          user
        });
      }

      const newBalance =
        Number(user.coin) -
        PREDICT_COST;

      /*
       * Save transaction + prediction
       */
      exec(`
        BEGIN TRANSACTION;

        UPDATE users
        SET
          coin=${newBalance},
          updated_at=CURRENT_TIMESTAMP
        WHERE user_id='${sqlEscape(
          user.user_id
        )}';

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
          '${sqlEscape(
            user.user_id
          )}',
          ${-PREDICT_COST},
          ${newBalance},
          'PREDICTION',
          '${sqlEscape(
            `${game}/${mode} input ${input}`
          )}'
        );

        INSERT INTO prediction_history
        (
          user_id,
          game,
          mode,
          input,
          prediction,
          percentage,
          matched_count,
          current_coin
        )
        VALUES
        (
          '${sqlEscape(
            user.user_id
          )}',
          '${sqlEscape(game)}',
          '${sqlEscape(mode)}',
          '${sqlEscape(input)}',
          '${sqlEscape(
            result.prediction
          )}',
          ${result.percentage},
          ${result.matched},
          ${newBalance}
        );

        COMMIT;
      `);

      const updatedUser =
        one(`
          SELECT
            id,
            user_id,
            coin,
            telegram_id,
            telegram_username,
            created_at,
            updated_at
          FROM users
          WHERE user_id='${sqlEscape(
            user.user_id
          )}'
          LIMIT 1;
        `);

      const elapsed =
        Date.now() - started;

      console.log(
        `ANALYZE DONE: ${game}/${mode}/${input} in ${elapsed}ms`
      );

      return res.json({
        ok: true,
        game,
        mode,
        input,
        result,
        cost:
          PREDICT_COST,
        user:
          updatedUser
      });

    } catch (error) {
      console.error(
        'Analyze error:',
        error
      );

      try {
        exec(
          'ROLLBACK;'
        );
      } catch {}

      return res.status(500).json({
        ok: false,
        error:
          'Prediction analysis failed'
      });
    }
  }
);

/* =========================================================
   PREDICTION HISTORY
========================================================= */

app.get(
  '/api/history',
  (req, res) => {
    const user =
      getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error:
          'Invalid or missing session'
      });
    }

    const history =
      rows(`
        SELECT
          id,
          game,
          mode,
          input,
          prediction,
          percentage,
          matched_count,
          current_coin,
          created_at
        FROM prediction_history
        WHERE user_id='${sqlEscape(
          user.user_id
        )}'
        ORDER BY id DESC
        LIMIT 50;
      `);

    res.json({
      ok: true,
      history
    });
  }
);

/* =========================================================
   CONFIG
========================================================= */

app.get(
  '/api/config',
  (req, res) => {
    res.json({
      ok: true,

      prediction_cost:
        PREDICT_COST,

      games: {
        '777': {
          WINGO:
            process.env
              .BIGWIN_WINGO_URL || '',

          TRX:
            process.env
              .BIGWIN_TRX_URL || ''
        },

        MINI: {
          WINGO:
            process.env
              .MINI_WINGO_URL || '',

          TRX:
            process.env
              .MINI_TRX_URL || ''
        }
      },

      contacts: {
        admin:
          process.env
            .ADMIN_CONTACT || '',

        developer:
          process.env
            .DEVELOPER_CONTACT || ''
      }
    });
  }
);

/* =========================================================
   STATIC WEBSITE
========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        'Not found'
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      '======================================'
    );

    console.log(
      ' XEEN AI MINI PREDICTOR'
    );

    console.log(
      ' Server started successfully'
    );

    console.log(
      '======================================'
    );

    console.log(
      `Local:   http://127.0.0.1:${PORT}`
    );

    console.log(
      `Network: http://0.0.0.0:${PORT}`
    );

    console.log(
      `Node:    ${process.version}`
    );

    console.log(
      `Database: ${DB_PATH}`
    );

    console.log(
      '======================================'
    );
  }
);

// =========================================================
// TELEGRAM BOT
// Run Bot + Web Server in ONE Railway Service
// =========================================================

if (process.env.BOT_TOKEN) {
  try {
    require('./bot.js');

    console.log('======================================');
    console.log(' TELEGRAM BOT: ENABLED');
    console.log(' SERVER + BOT: ONE PROCESS');
    console.log('======================================');

  } catch (error) {
    console.error('❌ Telegram Bot failed to start:');
    console.error(error);
  }
} else {
  console.log('⚠️ BOT_TOKEN not found - Telegram Bot disabled');
}
