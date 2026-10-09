// Applies db/schema.sql to the configured MySQL database (verified TLS).
// Usage: node scripts/db-migrate.js
//
// Two parts. The schema itself is all CREATE TABLE IF NOT EXISTS, so it only
// ever adds. ADJUSTMENTS below cover the case that does not reach — a column
// whose definition has changed since a database was created. Each one checks
// information_schema first and does nothing when the column is already right,
// so this stays safe to run against a live database as often as you like.
require('../lib/env');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// CA cert can come from a file (DB_CA_CERT) or inline (DB_CA_CERT_PEM), matching
// db/index.js. DigitalOcean MySQL requires SSL.
function ca() {
  const inline = process.env.DB_CA_CERT_PEM;
  if (inline && inline.includes('BEGIN CERTIFICATE')) return inline.replace(/\\n/g, '\n');
  const p = process.env.DB_CA_CERT;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// Column changes that a CREATE TABLE IF NOT EXISTS cannot deliver to a database
// that already exists.
//
// None of these say AFTER. Column position is cosmetic in MySQL, and naming a
// neighbour couples one adjustment to another having already run: three of
// these pointed AFTER a column that a LATER entry in this list adds, which is
// fine on a database that happens to have it and a hard stop on one that does
// not. That is exactly backwards — the older the database, the more likely it
// breaks. Order within this list now carries no meaning, which is the only
// safe thing for it to carry.
const width = (table, column) => `
  SELECT CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`;

const hasColumn = (table, column) => `
  SELECT COUNT(*) AS n FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`;

const hasIndex = (table, index) => `
  SELECT COUNT(*) AS n FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND INDEX_NAME = '${index}'`;

const isNullable = (table, column) => `
  SELECT IS_NULLABLE AS yn FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`;

// Add a column only if it is missing, as a statement that can sit in front of
// another. An adjustment that needs a column some *other* adjustment adds is
// the coupling this file exists to avoid — see the note above — so instead of
// relying on list order, the adjustment carries what it needs with it.
const ensureColumn = (table, column, definition) => `
  SET @needed := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}');
  SET @sql := IF(@needed, 'ALTER TABLE ${table} ADD COLUMN ${column} ${definition}', 'DO 0');
  PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s`;

// Drop a column only if it is there. The mirror of ensureColumn, for a
// column that exists on some databases and never existed on others — an
// unconditional DROP would be a hard stop on the ones that never had it.
const dropColumnIfPresent = (table, column) => `
  SET @present := (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}');
  SET @sql := IF(@present, 'ALTER TABLE ${table} DROP COLUMN ${column}', 'DO 0');
  PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s`;

// Retiring columns, guarded by a count that mentions them.
//
// A plain `WHERE settled = 1` cannot be the check: MySQL parses the whole
// statement before any guard can skip it, so on a database where the column
// is already gone the check itself errors. The guard therefore has to run
// inside the database, against SQL built only once the column is known to
// exist.
const dropIfUnused = (table, columns, usedWhere) => `
  SET @present := (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${columns[0]}');
  SET @used := 0;
  SET @count_sql := IF(@present = 1,
    'SELECT COUNT(*) INTO @used FROM ${table} WHERE ${usedWhere}', 'DO 0');
  PREPARE s FROM @count_sql; EXECUTE s; DEALLOCATE PREPARE s;
  SET @alter_sql := IF(@present = 1 AND @used = 0,
    'ALTER TABLE ${table} ${columns.map((c) => `DROP COLUMN ${c}`).join(', ')}', 'DO 0');
  PREPARE s FROM @alter_sql; EXECUTE s; DEALLOCATE PREPARE s`;

// A column that is being retired, on a table nobody has written to yet. Both
// halves matter: the column is dropped only where there is no row that could
// be carrying something in it.
const deadColumn = (table, column) => `
  SELECT
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}') AS present,
    (SELECT COUNT(*) FROM ${table}) AS rows_held`;

const ADJUSTMENTS = [
  {
    // Dropping start_date took it out of this index too, leaving an upgraded
    // database with (account_id, enabled) where a fresh one has created_at
    // on the end — and created_at is now what the lookup filters on.
    why: 'recharge_text_rules.idx_text_rule_lookup — created_at replaces start_date in it',
    check: `SELECT
        (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_text_rules'
            AND INDEX_NAME = 'idx_text_rule_lookup') AS present,
        (SELECT COUNT(*) FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_text_rules'
            AND INDEX_NAME = 'idx_text_rule_lookup' AND COLUMN_NAME = 'created_at') AS correct`,
    needed: (row) => Number(row.present) > 0 && Number(row.correct) === 0,
    // One ALTER, not two: this index also covers the foreign key on
    // account_id, and dropping it on its own leaves that uncovered — MySQL
    // refuses. Replacing it in a single statement never exposes the gap.
    sql: `ALTER TABLE recharge_text_rules
            DROP INDEX idx_text_rule_lookup,
            ADD INDEX idx_text_rule_lookup (account_id, enabled, created_at)`
  },
  {
    // Default 1: this is how the module works now, and an existing
    // deployment upgrading into it should behave the same as a fresh one
    // rather than silently keeping the old two-click flow.
    why: 'recharge_settings.auto_post — paying a bill posts its recharge',
    check: hasColumn('recharge_settings', 'auto_post'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE recharge_settings ADD COLUMN auto_post TINYINT(1) NOT NULL DEFAULT 1'
  },
  {
    why: 'bills.marked_paid_at — when Bills Hub itself marked the bill paid',
    check: hasColumn('bills', 'marked_paid_at'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bills ADD COLUMN marked_paid_at DATETIME NULL'
  },
  {
    // Bills Hub has been marking bills paid since before the column existed,
    // and the payment batches record exactly which and when. Backfilling
    // keeps that history rather than making every past payment look like
    // something Xero did on its own.
    why: 'bills.marked_paid_at — backfill from the payment batches that set it',
    check: `SELECT COUNT(*) AS n FROM bills b
              JOIN payment_batch_lines l ON l.bill_id = b.id
              JOIN payment_batches pb ON pb.id = l.batch_id
             WHERE pb.test_mode = 0 AND l.xero_payment_id IS NOT NULL
               AND b.marked_paid_at IS NULL`,
    needed: (row) => Number(row.n) > 0,
    sql: `UPDATE bills b
            JOIN payment_batch_lines l ON l.bill_id = b.id
            JOIN payment_batches pb ON pb.id = l.batch_id AND pb.account_id = b.account_id
             SET b.marked_paid_at = COALESCE(pb.xero_posted_at, pb.created_at)
           WHERE pb.test_mode = 0 AND l.xero_payment_id IS NOT NULL
             AND b.marked_paid_at IS NULL`
  },
  {
    // Replaced by the rule's own created_at: a rule acts on bills marked
    // paid in Bills Hub after it was written, so a second date to keep in
    // step with that was only ever a way for the two to disagree.
    why: 'recharge_text_rules.start_date — the rule\'s created_at is the line now',
    check: hasColumn('recharge_text_rules', 'start_date'),
    needed: (row) => Number(row.n) === 1,
    sql: 'ALTER TABLE recharge_text_rules DROP COLUMN start_date'
  },
  {
    // The old key counted cancelled runs and testing-mode runs against the
    // real one, which is not what "a bill is recharged once" means. Replaced
    // with a generated column, because MySQL has no partial index and NULL
    // drops a row out of a unique index.
    why: 'recharge_runs.uq_run_bill — one LIVE run per bill, per mode',
    check: hasColumn('recharge_runs', 'live_bill_id'),
    needed: (row) => Number(row.n) === 0,
    // The key names test_mode, which another adjustment adds. Carried here
    // rather than assumed, so this does not depend on list order.
    sql: `${ensureColumn('recharge_runs', 'test_mode', 'TINYINT(1) NOT NULL DEFAULT 0')};
          ALTER TABLE recharge_runs
            DROP INDEX uq_run_bill,
            ADD COLUMN live_bill_id BIGINT UNSIGNED GENERATED ALWAYS AS
              (IF(status = 'cancelled', NULL, bill_id)) VIRTUAL,
            ADD UNIQUE KEY uq_run_bill (account_id, live_bill_id, test_mode)`
  },
  {
    why: 'recharge_runs.test_mode — a run worked out while testing mode was on',
    check: hasColumn('recharge_runs', 'test_mode'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE recharge_runs ADD COLUMN test_mode TINYINT(1) NOT NULL DEFAULT 0'
  },
  {
    // Settlement is a question about two Xero ledgers and the answer lives
    // there. Dropped only where nothing was ever recorded — a transfer
    // somebody noted is not ours to delete without them seeing it. That
    // guard runs inside the database; see dropIfUnused.
    why: 'recharge_run_lines.settled / settled_reference / settled_on — settlement is tracked in Xero',
    check: hasColumn('recharge_run_lines', 'settled'),
    needed: (row) => Number(row.n) === 1,
    sql: dropIfUnused('recharge_run_lines',
      ['settled', 'settled_reference', 'settled_on'], 'settled = 1')
  },
  {
    why: "recharge_runs.status — drop the 'settled' state along with it",
    check: `SELECT
        (SELECT COUNT(*) FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_runs'
            AND COLUMN_NAME = 'status' AND COLUMN_TYPE LIKE '%settled%') AS present,
        (SELECT COUNT(*) FROM recharge_runs WHERE status = 'settled') AS rows_held`,
    needed: (row) => Number(row.present) === 1 && Number(row.rows_held) === 0,
    sql: "ALTER TABLE recharge_runs MODIFY status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft'"
  },
  {
    why: "entities.short_code — Xero's own code for the organisation, so a link can say which one it means",
    check: hasColumn('entities', 'short_code'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE entities ADD COLUMN short_code VARCHAR(16) NULL'
  },
  // ── Recharge: two kinds of rule ───────────────────────────────────────────
  //
  // An address rule now covers several suppliers (or none, meaning any), and
  // can be narrowed by a reference. Bill type is gone — it described the rule
  // rather than deciding anything, and the supplier already says what kind of
  // bill it is.
  {
    why: 'recharge_rules.reference_contains — narrow an address rule by the bill reference',
    check: hasColumn('recharge_rules', 'reference_contains'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE recharge_rules ADD COLUMN reference_contains VARCHAR(255) NULL'
  },
  {
    // supplier_name moves to its own table, so a rule can name several. The
    // existing single value is carried across rather than dropped.
    why: 'recharge_rule_suppliers — an address rule covers a set of suppliers',
    check: `SELECT COUNT(*) AS n FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_rule_suppliers'`,
    needed: (row) => Number(row.n) === 0,
    sql: `CREATE TABLE recharge_rule_suppliers (
            id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            rule_id       BIGINT UNSIGNED NOT NULL,
            supplier_name VARCHAR(255) NOT NULL,
            supplier_key  VARCHAR(255) NOT NULL,
            UNIQUE KEY uq_rule_supplier (rule_id, supplier_key),
            INDEX idx_supplier_key (supplier_key),
            CONSTRAINT fk_rs_rule FOREIGN KEY (rule_id) REFERENCES recharge_rules(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    // Carry and drop in one step, because a check that names supplier_name
    // cannot run on a database where supplier_name is already gone — MySQL
    // parses the whole statement before any guard can skip it. Carried, not
    // simply dropped: a rule whose supplier vanished would widen silently
    // from one supplier to every supplier.
    why: 'recharge_rules.supplier_name — moved into recharge_rule_suppliers',
    check: hasColumn('recharge_rules', 'supplier_name'),
    needed: (row) => Number(row.n) === 1,
    sql: `INSERT IGNORE INTO recharge_rule_suppliers (rule_id, supplier_name, supplier_key)
          SELECT id, supplier_name, LOWER(REGEXP_REPLACE(supplier_name, '[^a-zA-Z0-9]', ''))
            FROM recharge_rules
           WHERE supplier_name IS NOT NULL AND supplier_name <> '';
          ALTER TABLE recharge_rules DROP COLUMN supplier_name`
  },
  {
    // Carried a bill type for part of this release and then stopped: the
    // supplier already says what kind of bill it is. Only ever existed on a
    // database that saw the middle of the release, so the drop is guarded.
    why: 'recharge_rules.bill_type — the supplier already says what kind of bill it is',
    check: hasColumn('recharge_rules', 'bill_type'),
    needed: (row) => Number(row.n) === 1,
    sql: dropColumnIfPresent('recharge_rules', 'bill_type')
  },
  {
    why: 'recharge_text_rules — rules that match on supplier, reference or other text',
    check: `SELECT COUNT(*) AS n FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_text_rules'`,
    needed: (row) => Number(row.n) === 0,
    sql: `CREATE TABLE recharge_text_rules (
            id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            account_id      BIGINT UNSIGNED NOT NULL,
            name            VARCHAR(255) NOT NULL,
            match_mode      ENUM('all','any') NOT NULL DEFAULT 'all',
            payer_tenant_id VARCHAR(64) NULL,
            owner_tenant_id VARCHAR(64) NOT NULL,
            start_date      DATE NOT NULL,
            enabled         TINYINT(1) NOT NULL DEFAULT 1,
            last_run_at     DATETIME NULL,
            position        INT DEFAULT 0,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_text_rule_lookup (account_id, enabled, start_date),
            CONSTRAINT fk_trule_account FOREIGN KEY (account_id) REFERENCES accounts(id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    why: 'recharge_text_conditions — one test against one field of a bill',
    check: `SELECT COUNT(*) AS n FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_text_conditions'`,
    needed: (row) => Number(row.n) === 0,
    sql: `CREATE TABLE recharge_text_conditions (
            id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            rule_id   BIGINT UNSIGNED NOT NULL,
            field     ENUM('supplier','reference','invoice_number','description','tracking') NOT NULL,
            operator  ENUM('contains','is','starts_with','ends_with','not_contains') NOT NULL DEFAULT 'contains',
            value     VARCHAR(255) NOT NULL,
            position  INT DEFAULT 0,
            CONSTRAINT fk_tc_rule FOREIGN KEY (rule_id) REFERENCES recharge_text_rules(id) ON DELETE CASCADE,
            INDEX idx_tc_rule (rule_id, position)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  },
  {
    why: 'recharge_runs.text_rule_id — which recharge rule raised a run',
    check: hasColumn('recharge_runs', 'text_rule_id'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE recharge_runs ADD COLUMN text_rule_id BIGINT UNSIGNED NULL, '
       + 'ADD CONSTRAINT fk_run_trule FOREIGN KEY (text_rule_id) REFERENCES recharge_text_rules(id) ON DELETE SET NULL'
  },
  // ── Recharge: rules key on a premises address, not on a payer ─────────────
  //
  // The rule used to say "bills from this supplier, paid by this entity, split
  // between those entities". It now says "a bill from this supplier, for this
  // premises, belongs to that entity" — the payer is whoever Xero has on the
  // bill header, and the address decides the rest. These add what the new
  // shape needs; the old columns are retired further down, and only where
  // nothing is stored in them.
  {
    why: 'bills.premises_address / premises_source — the address printed on the bill',
    check: hasColumn('bills', 'premises_address'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bills ADD COLUMN premises_address VARCHAR(512) NULL, '
       + 'ADD COLUMN premises_source VARCHAR(16) NULL'
  },
  {
    why: 'recharge_rules — premises address, its match key and the owning entity',
    check: hasColumn('recharge_rules', 'premises_address'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE recharge_rules '
       + 'ADD COLUMN premises_address VARCHAR(512) NULL, '
       + 'ADD COLUMN address_key VARCHAR(512) NULL, '
       + 'ADD COLUMN owner_tenant_id VARCHAR(64) NULL, '
       + 'ADD COLUMN rule_key CHAR(64) NULL'
  },
  {
    // The old table demanded a payer on every rule. A rule names a premises
    // and nothing else now, so the column goes — but only where nothing is
    // stored in it, and nullable first so an older database that still has
    // values can at least accept new rules.
    why: 'recharge_rules.payer_tenant_id — a rule names a premises, not a payer',
    check: hasColumn('recharge_rules', 'payer_tenant_id'),
    needed: (row) => Number(row.n) === 1,
    sql: `ALTER TABLE recharge_rules MODIFY payer_tenant_id VARCHAR(64) NULL;
          ${dropIfUnused('recharge_rules', ['payer_tenant_id'], 'payer_tenant_id IS NOT NULL')}`
  },
  {
    // The lookup index led with payer_tenant_id, which no longer exists and
    // was never what a rule is found by. Left alone, an upgraded database
    // and a fresh one disagree about their own indexes.
    why: 'recharge_rules.idx_rule_lookup — rules are found by account and enabled, not by payer',
    check: `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_rules'
               AND INDEX_NAME = 'idx_rule_lookup' AND COLUMN_NAME = 'payer_tenant_id'`,
    needed: (row) => Number(row.n) === 1,
    sql: `ALTER TABLE recharge_rules DROP INDEX idx_rule_lookup;
          ALTER TABLE recharge_rules ADD INDEX idx_rule_lookup (account_id, enabled)`
  },
  {
    why: 'recharge_rules — one rule per supplier + premises',
    check: hasIndex('recharge_rules', 'uq_rule_premises'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE recharge_rules ADD UNIQUE KEY uq_rule_premises (account_id, rule_key)'
  },
  {
    why: 'recharge_runs.premises_address — the address that decided the recharge',
    check: hasColumn('recharge_runs', 'premises_address'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE recharge_runs ADD COLUMN premises_address VARCHAR(512) NULL'
  },
  {
    // Percentage splits across several subsidiaries are gone: an address
    // belongs to one entity and the recharge is the whole amount. Dropped only
    // on a database where no rule was ever written, because a share somebody
    // configured is not ours to throw away without them seeing it.
    why: 'recharge_rule_targets — percentage splits, replaced by a single address owner',
    check: `SELECT
        (SELECT COUNT(*) FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recharge_rule_targets') AS present,
        (SELECT COUNT(*) FROM recharge_rules) AS rows_held`,
    needed: (row) => Number(row.present) === 1 && Number(row.rows_held) === 0,
    sql: 'DROP TABLE IF EXISTS recharge_rule_targets'
  },
  {
    why: 'recharge_rules.match_type / match_value — replaced by the premises address',
    check: deadColumn('recharge_rules', 'match_type'),
    needed: (row) => Number(row.present) === 1 && Number(row.rows_held) === 0,
    sql: 'ALTER TABLE recharge_rules DROP COLUMN match_type, DROP COLUMN match_value'
  },
  {
    why: "bank_formats.template_sheet — which sheet of the bank's own workbook to fill",
    check: hasColumn('bank_formats', 'template_sheet'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bank_formats ADD COLUMN template_sheet VARCHAR(64) NULL'
  },
  {
    why: "payment_batch_lines.bill_date — the bill's own period, for the JomPay Ref-2",
    check: hasColumn('payment_batch_lines', 'bill_date'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batch_lines ADD COLUMN bill_date DATE NULL'
  },
  {
    // Ayu Borneo pays from Hong Leong and nothing else, so the generic CSV and
    // the unverified Maybank starter are gone. Anything still pointing at them
    // is repointed before they are deleted — an existing batch keeps its
    // format_key, and a row with no layout to render would fail to download.
    why: 'bank_accounts / payment_batches — repoint the retired layouts at Hong Leong',
    check: "SELECT COUNT(*) AS n FROM bank_accounts WHERE format_key IN ('generic-csv','maybank-m2e-csv')",
    needed: (row) => Number(row.n) > 0,
    sql: "UPDATE bank_accounts SET format_key = 'hlb-connectfirst' WHERE format_key IN ('generic-csv','maybank-m2e-csv')"
  },
  {
    why: 'payment_batches — the same, so an old file still renders',
    check: "SELECT COUNT(*) AS n FROM payment_batches WHERE format_key IN ('generic-csv','maybank-m2e-csv')",
    needed: (row) => Number(row.n) > 0,
    sql: "UPDATE payment_batches SET format_key = 'hlb-connectfirst' WHERE format_key IN ('generic-csv','maybank-m2e-csv')"
  },
  {
    why: 'bank_formats — drop the retired built-in layouts',
    check: "SELECT COUNT(*) AS n FROM bank_formats WHERE account_id IS NULL AND format_key IN ('generic-csv','maybank-m2e-csv')",
    needed: (row) => Number(row.n) > 0,
    sql: "DELETE FROM bank_formats WHERE account_id IS NULL AND format_key IN ('generic-csv','maybank-m2e-csv')"
  },
  {
    why: 'accounts.test_mode — the toggle that stops every Xero write',
    check: hasColumn('accounts', 'test_mode'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE accounts ADD COLUMN test_mode TINYINT(1) NOT NULL DEFAULT 0'
  },
  {
    why: 'payment_batches.test_mode — a batch whose file is real but which never reached Xero',
    check: hasColumn('payment_batches', 'test_mode'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batches ADD COLUMN test_mode TINYINT(1) NOT NULL DEFAULT 0'
  },
  {
    why: "bank_formats.template — the bank's own workbook, filled rather than rebuilt",
    check: hasColumn('bank_formats', 'template'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bank_formats ADD COLUMN template VARCHAR(128) NULL, '
       + 'ADD COLUMN template_header_rows INT NOT NULL DEFAULT 1'
  },
  {
    why: 'bank_accounts.biller_format_key — the JomPay layout, for the utilities in the same pay run',
    check: hasColumn('bank_accounts', 'biller_format_key'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bank_accounts ADD COLUMN biller_format_key VARCHAR(64) NULL'
  },
  {
    // These were never bank names: the sync was writing Xero's
    // BankAccountType into bank_name, so every account claimed to be at a
    // bank called "BANK". A later sync will not clear them, because a
    // hand-entered bank name is meant to survive one.
    why: 'bank_accounts.bank_name — clear the BankAccountType values that were mistaken for bank names',
    check: "SELECT COUNT(*) AS n FROM bank_accounts WHERE bank_name IN ('BANK','CREDITCARD','PAYPAL')",
    needed: (row) => Number(row.n) > 0,
    sql: "UPDATE bank_accounts SET bank_name = NULL WHERE bank_name IN ('BANK','CREDITCARD','PAYPAL')"
  },
  {
    why: "bank_formats.payment_mode — Hong Leong's field limits depend on the rail",
    check: hasColumn('bank_formats', 'payment_mode'),
    needed: (row) => Number(row.n) === 0,
    sql: "ALTER TABLE bank_formats ADD COLUMN payment_mode VARCHAR(8) NULL"
  },
  {
    why: "payees.payee_code / payment_batch_lines.payee_code — Xero's BatchPayments.Code, the supplier abbreviation",
    check: hasColumn('payees', 'payee_code'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payees ADD COLUMN payee_code VARCHAR(40) NULL'
  },
  {
    why: 'payment_batch_lines.payee_code',
    check: hasColumn('payment_batch_lines', 'payee_code'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batch_lines ADD COLUMN payee_code VARCHAR(40) NULL'
  },
  {
    why: 'payment_batch_lines — snapshot the payee payment details with the batch',
    check: hasColumn('payment_batch_lines', 'payee_bank_account_name'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batch_lines '
       + 'ADD COLUMN payee_bank_account_name VARCHAR(100) NULL, '
       + 'ADD COLUMN payee_details VARCHAR(255) NULL, '
       + 'ADD COLUMN payee_email VARCHAR(500) NULL'
  },
  {
    why: "payees — the rest of Xero's BatchPayments block, which is where Ayu Borneo keep the payment details",
    check: hasColumn('payees', 'bank_account_name'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payees '
       + 'ADD COLUMN bank_account_name VARCHAR(100) NULL, '
       + 'ADD COLUMN details VARCHAR(255) NULL, '
       + 'ADD COLUMN tax_number VARCHAR(50) NULL, '
       + 'ADD COLUMN email VARCHAR(500) NULL'
  },
  {
    why: 'payment_batches.receipt_name — the bank acknowledgement attached to a batch',
    check: hasColumn('payment_batches', 'receipt_name'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batches ADD COLUMN receipt_name VARCHAR(255) NULL, ADD COLUMN receipt_attached_at DATETIME NULL'
  },
  {
    why: 'payment_batch_lines.receipt_attached — so attaching can resume',
    check: hasColumn('payment_batch_lines', 'receipt_attached'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE payment_batch_lines ADD COLUMN receipt_attached TINYINT(1) NOT NULL DEFAULT 0'
  },
  {
    why: 'bill_sync_state.contacts_cursor_utc — contact changes need their own high-water mark',
    check: hasColumn('bill_sync_state', 'contacts_cursor_utc'),
    needed: (row) => Number(row.n) === 0,
    sql: 'ALTER TABLE bill_sync_state ADD COLUMN contacts_cursor_utc DATETIME NULL'
  },
  {
    // Found the hard way: 24 of 41 organisations failed their first sync with
    // "Data too long for column 'reference'". Xero documents Reference as 255
    // and returns more.
    why: "bills.reference was too narrow for the references Xero actually sends",
    check: width('bills', 'reference'),
    needed: (row) => Number(row.n) < 500,
    sql: 'ALTER TABLE bills MODIFY reference VARCHAR(500)'
  }
];

(async () => {
  const cert = ca();
  // Mirrors db/index.js: a local, non-TLS database is allowed outside production.
  const plaintextOk = process.env.DB_SSL === 'disable' && process.env.NODE_ENV !== 'production';
  if (!cert && !plaintextOk) {
    console.error('Missing CA cert. Set DB_CA_CERT (file path) or DB_CA_CERT_PEM (inline) in .env.');
    process.exit(1);
  }
  if (!cert) console.warn('[db] DB_SSL=disable — connecting WITHOUT TLS. Local development only.');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 25060),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: cert ? { ca: cert, rejectUnauthorized: true } : undefined,
    multipleStatements: true
  });
  await conn.query(sql);

  for (const a of ADJUSTMENTS) {
    const [[row]] = await conn.query(a.check);
    if (!row || !a.needed(row)) continue;
    console.log(`  altering: ${a.why}`);
    await conn.query(a.sql);
    console.log(`  done:     ${a.sql}`);
  }

  const [tables] = await conn.query('SHOW TABLES');
  console.log(`Schema applied to "${process.env.DB_NAME}". ${tables.length} tables:`);
  for (const t of tables) console.log('  -', Object.values(t)[0]);
  await conn.end();
})().catch((err) => {
  console.error('Migration FAILED:', err.code || '', err.message);
  process.exit(1);
});
