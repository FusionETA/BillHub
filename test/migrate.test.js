// The migration, run the way a deployment runs it: against a database built
// from the LAST release's schema, not from this one.
//
// test/safety.test.js checks that no adjustment says AFTER. That rules out
// one shape of a bigger problem — an adjustment that depends on another
// having already run — and a deployment found two more shapes of it:
//
//   ADD UNIQUE KEY (... test_mode)   where test_mode is added further down
//   DROP COLUMN bill_type            where bill_type is added further down
//
// Both passed on every database here, because every database here already
// had the columns from an earlier run. Only a database that has never seen
// them tells the truth, which on the day meant the droplet.
//
// So: build one from the previous schema.sql, migrate it, and require the
// result to be indistinguishable from a database created fresh. Then migrate
// it again and require nothing to happen.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const OLD_DB = `billhub_mig_old_${process.pid}`;
const NEW_DB = `billhub_mig_new_${process.pid}`;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok    ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// The schema as it stood before the most recent change to it — which is what
// a server that has not deployed yet is running.
function previousSchema() {
  const commits = git('log', '--format=%H', '--', 'db/schema.sql').trim().split('\n').filter(Boolean);
  if (commits.length < 2) return null;
  return { ref: commits[1], sql: git('show', `${commits[1]}:db/schema.sql`) };
}

const COLUMNS = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
   FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, COLUMN_NAME`;
const INDEXES = `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
   FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

function migrate(dbName) {
  return execFileSync(process.execPath, ['scripts/db-migrate.js'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DB_NAME: dbName }
  });
}

(async () => {
  const previous = previousSchema();
  if (!previous) {
    console.log('\nNo earlier db/schema.sql in this checkout — nothing to upgrade from.');
    console.log('(A shallow clone. The test needs history; it is not failing.)\n');
    process.exit(0);
  }

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true
  });

  try {
    console.log(`\nUpgrading a database built from ${previous.ref.slice(0, 7)}`);

    for (const [name, sql] of [[OLD_DB, previous.sql], [NEW_DB, fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8')]]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.query(`CREATE DATABASE \`${name}\``);
      await admin.query(`USE \`${name}\``);
      await admin.query(sql);
    }

    // The one that matters: this is the shape the droplet was in.
    let out;
    try {
      out = migrate(OLD_DB);
      check('the migration completes against the previous release\'s schema', true);
    } catch (e) {
      const text = `${e.stdout || ''}${e.stderr || ''}`;
      check('the migration completes against the previous release\'s schema', false,
        (text.match(/Migration FAILED.*/) || [text.slice(-300)])[0]);
      throw new Error('cannot compare a schema the migration could not produce');
    }
    check('and it had something to do', /altering:/.test(out), 'no adjustments ran — is this really an older schema?');

    migrate(NEW_DB);

    const [oldCols] = await admin.query(COLUMNS, [OLD_DB]);
    const [newCols] = await admin.query(COLUMNS, [NEW_DB]);
    const [oldIdx] = await admin.query(INDEXES, [OLD_DB]);
    const [newIdx] = await admin.query(INDEXES, [NEW_DB]);

    // An upgraded database and a fresh one have to be the same database.
    // Anything else is drift that only shows up months later, on whichever
    // deployment happens to be the old one.
    const key = (r) => JSON.stringify(r);
    const diff = (a, b) => {
      const sb = new Set(b.map(key));
      return a.filter((r) => !sb.has(key(r)));
    };
    const colsOnlyOld = diff(oldCols, newCols);
    const colsOnlyNew = diff(newCols, oldCols);
    const idxOnlyOld = diff(oldIdx, newIdx);
    const idxOnlyNew = diff(newIdx, oldIdx);

    check('an upgraded database has exactly the columns of a fresh one',
      colsOnlyOld.length === 0 && colsOnlyNew.length === 0,
      [...colsOnlyOld.map((r) => `upgraded only: ${r.TABLE_NAME}.${r.COLUMN_NAME} ${r.COLUMN_TYPE}`),
       ...colsOnlyNew.map((r) => `fresh only: ${r.TABLE_NAME}.${r.COLUMN_NAME} ${r.COLUMN_TYPE}`)]);

    check('and exactly the same indexes',
      idxOnlyOld.length === 0 && idxOnlyNew.length === 0,
      [...idxOnlyOld.map((r) => `upgraded only: ${r.TABLE_NAME}.${r.INDEX_NAME} (${r.COLUMN_NAME})`),
       ...idxOnlyNew.map((r) => `fresh only: ${r.TABLE_NAME}.${r.INDEX_NAME} (${r.COLUMN_NAME})`)]);

    // A part-applied migration has to be finishable by running it again, so
    // every adjustment must be a no-op once it has done its work.
    const second = migrate(OLD_DB);
    const stillDoing = (second.match(/altering:.*/g) || []);
    check('running it a second time does nothing', stillDoing.length === 0, stillDoing);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${OLD_DB}\``);
    await admin.query(`DROP DATABASE IF EXISTS \`${NEW_DB}\``);
    await admin.end();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
