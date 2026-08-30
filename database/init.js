const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config();

const dbPath = path.resolve(process.env.DB_PATH || './database/xeen.db');
const dbDir = path.dirname(dbPath);

fs.mkdirSync(dbDir, { recursive: true });

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function runSQL(sql) {
  return execFileSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
}

function randomDigit() {
  return Math.floor(Math.random() * 10);
}

function randomNumber() {
  return randomDigit() * 100 + randomDigit() * 10 + randomDigit();
}

function sizeOf(number) {
  return number >= 5 ? 'BIG' : 'SMALL';
}

console.log('======================================');
console.log(' XEEN AI MINI PREDICTOR');
console.log(' Database Initializer');
console.log('======================================');

if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, '');
}

const schema = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  coin INTEGER NOT NULL DEFAULT 0,
  telegram_id TEXT UNIQUE,
  telegram_username TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prediction_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  game TEXT NOT NULL,
  mode TEXT NOT NULL,
  input TEXT NOT NULL,
  prediction TEXT,
  percentage REAL,
  matched_count INTEGER NOT NULL DEFAULT 0,
  current_coin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  mode TEXT NOT NULL,
  round_id TEXT NOT NULL,
  result INTEGER NOT NULL,
  size TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(dataset, mode, round_id)
);

CREATE INDEX IF NOT EXISTS idx_game_data_lookup
ON game_data(dataset, mode, id);

CREATE INDEX IF NOT EXISTS idx_prediction_user
ON prediction_history(user_id);

CREATE INDEX IF NOT EXISTS idx_coin_user
ON coin_transactions(user_id);

CREATE TABLE IF NOT EXISTS system_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

runSQL(schema);

const DATASET_SIZE = Math.max(
  1000,
  Number.parseInt(process.env.DATASET_SIZE || '1200', 10)
);

const datasets = [
  { dataset: '777', mode: 'WINGO' },
  { dataset: '777', mode: 'TRX' },
  { dataset: 'MINI', mode: 'WINGO' },
  { dataset: 'MINI', mode: 'TRX' }
];

console.log(`Generating ${DATASET_SIZE}+ records for each dataset...`);

for (const item of datasets) {
  const countResult = runSQL(`
    SELECT COUNT(*) AS count
    FROM game_data
    WHERE dataset='${sqlEscape(item.dataset)}'
      AND mode='${sqlEscape(item.mode)}';
  `).trim();

  const existing = Number.parseInt(countResult || '0', 10);

  if (existing >= DATASET_SIZE) {
    console.log(
      `✓ ${item.dataset} ${item.mode}: ${existing} records already exist`
    );
    continue;
  }

  const needed = DATASET_SIZE - existing;
  const statements = [];

  const base = Date.now();

  for (let i = 0; i < needed; i++) {
    const value = randomNumber();

    const roundNumber = String(base + existing + i).padStart(8, '0');

    const roundId = `${item.dataset}-${item.mode}-${roundNumber}`;

    statements.push(
      `INSERT OR IGNORE INTO game_data
      (dataset, mode, round_id, result, size)
      VALUES
      ('${sqlEscape(item.dataset)}',
       '${sqlEscape(item.mode)}',
       '${sqlEscape(roundId)}',
       ${value},
       '${sizeOf(value % 10)}');`
    );
  }

  runSQL(`
    BEGIN TRANSACTION;
    ${statements.join('\n')}
    COMMIT;
  `);

  const finalCount = runSQL(`
    SELECT COUNT(*)
    FROM game_data
    WHERE dataset='${sqlEscape(item.dataset)}'
      AND mode='${sqlEscape(item.mode)}';
  `).trim();

  console.log(
    `✓ ${item.dataset} ${item.mode}: ${finalCount} records`
  );
}

runSQL(`
INSERT INTO system_meta(key, value)
VALUES('database_initialized', datetime('now'))
ON CONFLICT(key) DO UPDATE SET
value=excluded.value,
updated_at=datetime('now');

INSERT INTO system_meta(key, value)
VALUES('last_rotation', datetime('now'))
ON CONFLICT(key) DO NOTHING;
`);

console.log('');
console.log('Database ready.');
console.log(`Location: ${dbPath}`);
console.log('');
console.log('Datasets:');

for (const item of datasets) {
  const count = runSQL(`
    SELECT COUNT(*)
    FROM game_data
    WHERE dataset='${sqlEscape(item.dataset)}'
      AND mode='${sqlEscape(item.mode)}';
  `).trim();

  console.log(`  ${item.dataset} ${item.mode}: ${count}`);
}

console.log('');
console.log('✓ Initialization completed successfully.');
