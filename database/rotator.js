const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH =
  process.env.DB_PATH ||
  path.join(__dirname, 'xeen.db');

const DATASETS = [
  { dataset: '777', mode: 'WINGO' },
  { dataset: '777', mode: 'TRX' },
  { dataset: 'MINI', mode: 'WINGO' },
  { dataset: 'MINI', mode: 'TRX' }
];

const TOTAL_PER_DATASET = 1200;

function runSql(sql) {
  return execFileSync(
    'sqlite3',
    [DB_PATH, sql],
    { encoding: 'utf8' }
  );
}

function randomDigit() {
  return Math.floor(Math.random() * 10);
}

function generateData() {
  const now = new Date().toISOString();

  for (const item of DATASETS) {
    const rows = [];

    for (let i = 1; i <= TOTAL_PER_DATASET; i++) {
      const result = randomDigit();
      const size = result >= 5 ? 'BIG' : 'SMALL';

      const roundId =
        `${item.dataset}-${item.mode}-${Date.now()}-${i}`;

      rows.push(
        `('${item.dataset}','${item.mode}','${roundId}',${result},'${size}','${now}')`
      );
    }

    const sql = `
      BEGIN TRANSACTION;

      DELETE FROM game_data
      WHERE dataset='${item.dataset}'
        AND mode='${item.mode}';

      INSERT INTO game_data
      (dataset, mode, round_id, result, size, created_at)
      VALUES ${rows.join(',')};

      COMMIT;
    `;

    runSql(sql);

    console.log(
      `✓ ${item.dataset} ${item.mode}: ${TOTAL_PER_DATASET} records`
    );
  }
}

function startRotator() {
  console.log('Xeen AI Data Rotator started');

  generateData();

  // 3 hours
  const THREE_HOURS = 3 * 60 * 60 * 1000;

  setInterval(() => {
    console.log('\n[ROTATE] Generating new datasets...');
    generateData();
  }, THREE_HOURS);
}

if (require.main === module) {
  startRotator();
}

module.exports = {
  generateData,
  startRotator
};
