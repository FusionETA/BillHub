-- Bills Hub schema — its own database on the same MySQL cluster as WazzOCR.
-- Apply with: node scripts/db-migrate.js   (safe to re-run)
--
-- Structure and conventions follow WazzOCR (accounts -> users -> sessions).
-- Every table below lives in the Bills Hub database; nothing here touches
-- WazzOCR's schema.
--
-- There are deliberately no xero_grants / xero_connections tables. Bills Hub
-- borrows WazzOCR's existing grant instead of holding one of its own, because
-- Xero supersedes the older token set whenever the same Xero user re-authorises
-- the same app — a second consent would silently break WazzOCR. See
-- lib/wazzocrDb.js for the two tables it reads and the grants it needs.

-- ── Tenancy & auth ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  status         ENUM('active','suspended','trial') DEFAULT 'active',
  -- Currency the group reports in; drives the "RM" prefix and the totals.
  base_currency  VARCHAR(8) NOT NULL DEFAULT 'MYR',
  -- Which WazzOCR account's Xero grant this account borrows. Ids are not shared
  -- between the two databases, so the mapping has to be explicit. NULL means
  -- Xero is not wired up yet.
  wazzocr_account_id BIGINT UNSIGNED NULL,
  setup_complete TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NULL,
  email          VARCHAR(255) NOT NULL UNIQUE,
  google_sub     VARCHAR(255) NULL UNIQUE,
  xero_sub       VARCHAR(255) NULL UNIQUE,
  password_hash  VARBINARY(255) NULL,
  phone_number   VARCHAR(32) NULL,
  name           VARCHAR(255),
  avatar_url     VARCHAR(512),
  role           ENUM('owner','member') DEFAULT 'owner',
  is_super_admin TINYINT(1) DEFAULT 0,
  status         ENUM('invited','active','disabled') DEFAULT 'invited',
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login_at  DATETIME,
  CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  id         CHAR(64) PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  ip         VARCHAR(45),
  user_agent VARCHAR(255),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Bills module ────────────────────────────────────────────────────────────

-- Display metadata for an organisation WazzOCR has connected: the short code
-- ("ABKK") and short name ("Ayu Borneo (KK)") the UI shows instead of the full
-- legal name Xero returns. Keyed by Xero's tenant id, which is the one
-- identifier both databases agree on.
-- Seeded from the tenant name on first sync, then editable — a re-sync never
-- overwrites a code someone has corrected by hand.
CREATE TABLE IF NOT EXISTS entities (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NOT NULL,
  xero_tenant_id VARCHAR(64) NOT NULL,
  code           VARCHAR(16)  NOT NULL,
  short_name     VARCHAR(255) NOT NULL,
  position       INT DEFAULT 0,
  included       TINYINT(1) NOT NULL DEFAULT 1,   -- 0 = hide from Bills Hub
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ent_tenant (account_id, xero_tenant_id),
  INDEX idx_ent_account (account_id, position),
  CONSTRAINT fk_ent_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Local mirror of Xero ACCPAY invoices (supplier bills) across every connected
-- org. Pulled incrementally using Xero's UpdatedDateUTC. Xero stays the source
-- of truth: rows here are only ever written by the sync, or by an action that
-- has already succeeded against Xero.
CREATE TABLE IF NOT EXISTS bills (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id       BIGINT UNSIGNED NOT NULL,
  xero_tenant_id   VARCHAR(64) NOT NULL,
  xero_invoice_id  CHAR(36) NOT NULL,
  invoice_number   VARCHAR(255),
  reference        VARCHAR(255),
  contact_id       CHAR(36),
  contact_name     VARCHAR(255),
  -- Xero's own status: DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED | DELETED
  xero_status      VARCHAR(16) NOT NULL,
  bill_date        DATE,
  due_date         DATE,
  fully_paid_on    DATE NULL,
  currency_code    VARCHAR(8),
  currency_rate    DECIMAL(18,8),
  sub_total        DECIMAL(16,2) DEFAULT 0,
  total_tax        DECIMAL(16,2) DEFAULT 0,
  total            DECIMAL(16,2) DEFAULT 0,
  amount_paid      DECIMAL(16,2) DEFAULT 0,
  amount_due       DECIMAL(16,2) DEFAULT 0,
  amount_credited  DECIMAL(16,2) DEFAULT 0,
  has_attachments  TINYINT(1) DEFAULT 0,
  attachment_count INT DEFAULT 0,
  -- Contact resolves to another connected org -> shown as "Intercompany".
  is_interco       TINYINT(1) DEFAULT 0,
  updated_date_utc DATETIME NULL,          -- Xero's UpdatedDateUTC
  synced_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bill (account_id, xero_tenant_id, xero_invoice_id),
  INDEX idx_bill_list (account_id, xero_status, bill_date),
  INDEX idx_bill_due (account_id, due_date),
  INDEX idx_bill_contact (account_id, contact_name(64)),
  INDEX idx_bill_tenant (account_id, xero_tenant_id, bill_date),
  CONSTRAINT fk_bill_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-tenant sync bookkeeping. `cursor_utc` is the high-water mark fed back to
-- Xero as If-Modified-Since, so each run pulls only what changed.
CREATE TABLE IF NOT EXISTS bill_sync_state (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NOT NULL,
  xero_tenant_id VARCHAR(64) NOT NULL,
  cursor_utc     DATETIME NULL,
  last_run_at    DATETIME NULL,
  last_status    ENUM('ok','error','running') DEFAULT 'ok',
  last_error     VARCHAR(512),
  bills_upserted INT DEFAULT 0,
  UNIQUE KEY uq_sync_tenant (account_id, xero_tenant_id),
  CONSTRAINT fk_sync_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Bank files module ───────────────────────────────────────────────────────

-- A payment file layout, held as data rather than code because the exact columns
-- differ per bank AND per customer registration (Maybank alone has CSV and
-- pipe-delimited variants). Editing a layout must never need a deploy.
--
-- `columns` is an ordered array of:
--   { "header": "Account No", "field": "payeeAccount", "transform": "digits",
--     "maxLength": 20, "pad": "right", "padChar": "0", "default": "" }
-- Fields available per line are listed in lib/bankFile.js.
CREATE TABLE IF NOT EXISTS bank_formats (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  -- NULL = a built-in layout shipped with the app; set = this account's own.
  account_id     BIGINT UNSIGNED NULL,
  format_key     VARCHAR(64) NOT NULL,
  name           VARCHAR(255) NOT NULL,
  bank_name      VARCHAR(100),
  delimiter      VARCHAR(4) NOT NULL DEFAULT ',',
  extension      VARCHAR(8) NOT NULL DEFAULT 'csv',
  include_header TINYINT(1) NOT NULL DEFAULT 1,
  line_ending    ENUM('crlf','lf') NOT NULL DEFAULT 'crlf',
  quote_fields   TINYINT(1) NOT NULL DEFAULT 0,
  -- How paymentDate is written: YYYY-MM-DD | YYYYMMDD | DD/MM/YYYY | DDMMYYYY
  date_format    VARCHAR(16) NOT NULL DEFAULT 'YYYY-MM-DD',
  columns        JSON NOT NULL,
  header_row     JSON NULL,          -- optional file-level header record
  trailer_row    JSON NULL,          -- optional trailer (totals, counts)
  -- 0 until a human has checked the output against the bank's own spec sheet.
  -- The UI refuses to hide this: an unverified layout can be rejected by the
  -- bank, or worse, pay the wrong account.
  verified       TINYINT(1) NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fmt_key (account_id, format_key),
  CONSTRAINT fk_fmt_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Paying accounts, mirrored from Xero's BANK accounts. `xero_account_id` is what
-- a Xero batch payment is posted against; `format_key` picks the file layout.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id      BIGINT UNSIGNED NOT NULL,
  xero_tenant_id  VARCHAR(64) NOT NULL,
  xero_account_id CHAR(36) NOT NULL,
  code            VARCHAR(32),
  name            VARCHAR(255) NOT NULL,
  bank_name       VARCHAR(100),
  account_number  VARCHAR(64),          -- our own account, for file headers
  currency_code   VARCHAR(8),
  format_key      VARCHAR(64),
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  enabled         TINYINT(1) NOT NULL DEFAULT 1,
  synced_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bank_acct (account_id, xero_tenant_id, xero_account_id),
  INDEX idx_bank_acct_tenant (account_id, xero_tenant_id, enabled),
  CONSTRAINT fk_bankacct_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Supplier bank details. Xero keeps these as free text on the contact
-- (Contact.BankAccountDetails), which is often blank or formatted by hand, so a
-- corrected value can be stored here without writing back to Xero.
CREATE TABLE IF NOT EXISTS payees (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id     BIGINT UNSIGNED NOT NULL,
  xero_tenant_id VARCHAR(64) NOT NULL,
  contact_id     CHAR(36) NOT NULL,
  contact_name   VARCHAR(255),
  account_number VARCHAR(64),
  bank_name      VARCHAR(100),
  -- 'xero' = as pulled from the contact; 'manual' = corrected here, and a
  -- re-sync must not overwrite it.
  source         ENUM('xero','manual') NOT NULL DEFAULT 'xero',
  synced_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payee (account_id, xero_tenant_id, contact_id),
  CONSTRAINT fk_payee_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A run of bills paid together from one bank account. Maps onto a Xero
-- BatchPayment (PAYBATCH), which is why it cannot span organisations or
-- currencies: the Xero API only accepts base-currency batches within one org.
CREATE TABLE IF NOT EXISTS payment_batches (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id       BIGINT UNSIGNED NOT NULL,
  xero_tenant_id   VARCHAR(64) NOT NULL,
  reference        VARCHAR(32) NOT NULL,        -- PAY-4469
  bank_account_id  BIGINT UNSIGNED NOT NULL,
  payment_date     DATE NOT NULL,
  currency_code    VARCHAR(8),
  total            DECIMAL(16,2) NOT NULL DEFAULT 0,
  line_count       INT NOT NULL DEFAULT 0,
  -- ready      → file generated, not yet downloaded
  -- downloaded → file taken, not yet confirmed uploaded to the bank portal
  -- uploaded   → confirmed with the bank; this is when Xero is posted
  -- posted     → recorded in Xero with no file (already paid another way)
  -- cancelled  → abandoned before reaching the bank
  status           ENUM('ready','downloaded','uploaded','posted','cancelled') NOT NULL DEFAULT 'ready',
  file_name        VARCHAR(255),
  format_key       VARCHAR(64),
  -- Set once Xero has accepted the batch payment. Its presence is what stops a
  -- batch being posted twice.
  xero_batch_payment_id CHAR(36) NULL,
  xero_posted_at   DATETIME NULL,
  post_error       VARCHAR(512),
  downloaded_at    DATETIME NULL,
  uploaded_at      DATETIME NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_batch_ref (account_id, reference),
  INDEX idx_batch_list (account_id, status, created_at),
  CONSTRAINT fk_batch_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_batch_bankacct FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One bill per line. The payee details are copied in at creation time so the
-- file and the Xero payment reflect what was approved, not what the contact
-- record happens to say later.
CREATE TABLE IF NOT EXISTS payment_batch_lines (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  batch_id        BIGINT UNSIGNED NOT NULL,
  bill_id         BIGINT UNSIGNED NOT NULL,
  xero_invoice_id CHAR(36) NOT NULL,
  contact_name    VARCHAR(255),
  payee_account   VARCHAR(64),
  payee_bank      VARCHAR(100),
  amount          DECIMAL(16,2) NOT NULL,
  reference       VARCHAR(255),
  xero_payment_id CHAR(36) NULL,
  UNIQUE KEY uq_line_bill (batch_id, bill_id),
  -- A bill may only sit in one live batch at a time; enforced in the model,
  -- since a cancelled batch must not block a retry.
  INDEX idx_line_bill (bill_id),
  CONSTRAINT fk_line_batch FOREIGN KEY (batch_id) REFERENCES payment_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Notifications module ────────────────────────────────────────────────────

-- One row per account: when the draft-bills digest goes out, what it contains,
-- and which Wazzup channel sends it.
CREATE TABLE IF NOT EXISTS digest_settings (
  account_id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled           TINYINT(1) NOT NULL DEFAULT 0,
  frequency         ENUM('daily','weekly','monthly') NOT NULL DEFAULT 'daily',
  -- Local wall-clock time in `timezone`, not UTC — "09:00 MYT" has to stay
  -- 09:00 regardless of where the server runs.
  send_time         TIME NOT NULL DEFAULT '09:00:00',
  timezone          VARCHAR(64) NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  day_of_week       TINYINT NOT NULL DEFAULT 1,     -- 1=Mon … 7=Sun, weekly only
  day_of_month      TINYINT NOT NULL DEFAULT 1,     -- 1–28, or 0 = last day
  working_days_only TINYINT(1) NOT NULL DEFAULT 1,  -- daily: skip Sat/Sun
  include_breakdown TINYINT(1) NOT NULL DEFAULT 1,
  breakdown_limit   INT NOT NULL DEFAULT 3,
  send_when_empty   TINYINT(1) NOT NULL DEFAULT 0,
  -- Wazzup channel. The key is AES-256-GCM encrypted, like the Xero token.
  channel_id        VARCHAR(128),
  api_key           VARBINARY(512),
  sender_phone      VARCHAR(32),
  queue_url         VARCHAR(512),                   -- the "open the queue" link
  -- The local date a digest was last sent for. A tick that finds today already
  -- here does nothing, so a restart or a slow run cannot send twice.
  last_sent_for     DATE NULL,
  last_sent_at      DATETIME NULL,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_digest_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS digest_recipients (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id   BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(255) NOT NULL,
  -- Digits only, country code included, as Wazzup expects it (60123456789).
  phone        VARCHAR(32) NOT NULL,
  role         VARCHAR(64),
  enabled      TINYINT(1) NOT NULL DEFAULT 1,
  -- 1 = group-wide, and newly connected organisations are included
  -- automatically. 0 = only the rows in digest_recipient_entities.
  all_entities TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recipient_phone (account_id, phone),
  CONSTRAINT fk_recipient_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS digest_recipient_entities (
  recipient_id   BIGINT UNSIGNED NOT NULL,
  xero_tenant_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (recipient_id, xero_tenant_id),
  CONSTRAINT fk_rcpent_recipient FOREIGN KEY (recipient_id) REFERENCES digest_recipients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every send attempt, including the exact text. Without this there is no way to
-- answer "what did finance actually receive on Tuesday?".
CREATE TABLE IF NOT EXISTS digest_runs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id   BIGINT UNSIGNED NOT NULL,
  recipient_id BIGINT UNSIGNED NULL,     -- NULL once the recipient is deleted
  phone        VARCHAR(32),
  trigger_type ENUM('schedule','manual','test') NOT NULL DEFAULT 'schedule',
  status       ENUM('sent','failed','skipped') NOT NULL,
  draft_count  INT DEFAULT 0,
  draft_total  DECIMAL(16,2) DEFAULT 0,
  message      MEDIUMTEXT,
  error        VARCHAR(512),
  sent_for     DATE NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_run_account (account_id, created_at),
  CONSTRAINT fk_run_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Recharge module ─────────────────────────────────────────────────────────

-- Which ledger accounts a recharge posts to. Codes differ per chart of
-- accounts, so they are configuration, not constants — the same reasoning as
-- the bank file layouts. A recharge cannot be posted until they are set.
CREATE TABLE IF NOT EXISTS recharge_settings (
  account_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  -- On the AR invoice raised in the paying entity.
  ar_account_code  VARCHAR(32),
  -- On the draft bill raised in the subsidiary.
  ap_account_code  VARCHAR(32),
  tax_type         VARCHAR(32) DEFAULT 'NONE',
  -- Prefix for the reference written on both sides, e.g. IC- -> IC-TNB-0726-KJ
  reference_prefix VARCHAR(16) NOT NULL DEFAULT 'IC-',
  -- Days until the intercompany bill falls due.
  due_days         INT NOT NULL DEFAULT 30,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rcs_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Bills from this supplier, paid by this entity, belong to those entities."
-- Rules only ever suggest a recharge; nothing is posted without a person.
CREATE TABLE IF NOT EXISTS recharge_rules (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id        BIGINT UNSIGNED NOT NULL,
  payer_tenant_id   VARCHAR(64) NOT NULL,
  supplier_name     VARCHAR(255) NOT NULL,
  -- 'any'                every bill from this supplier in the payer
  -- 'reference_contains' only when the reference contains match_value
  match_type        ENUM('any','reference_contains') NOT NULL DEFAULT 'any',
  match_value       VARCHAR(255),
  enabled           TINYINT(1) NOT NULL DEFAULT 1,
  position          INT DEFAULT 0,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rule_lookup (account_id, payer_tenant_id, enabled),
  CONSTRAINT fk_rule_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who a rule recharges to, and in what proportion. One row at 100% is the
-- common case; several rows split a shared cost.
CREATE TABLE IF NOT EXISTS recharge_rule_targets (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_id          BIGINT UNSIGNED NOT NULL,
  target_tenant_id VARCHAR(64) NOT NULL,
  share_percent    DECIMAL(9,4) NOT NULL DEFAULT 100.0000,
  UNIQUE KEY uq_rule_target (rule_id, target_tenant_id),
  CONSTRAINT fk_rt_rule FOREIGN KEY (rule_id) REFERENCES recharge_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One recharge of one paid bill out to one or more subsidiaries.
CREATE TABLE IF NOT EXISTS recharge_runs (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id      BIGINT UNSIGNED NOT NULL,
  rule_id         BIGINT UNSIGNED NULL,      -- NULL = raised by hand
  bill_id         BIGINT UNSIGNED NOT NULL,
  payer_tenant_id VARCHAR(64) NOT NULL,
  xero_invoice_id CHAR(36) NOT NULL,         -- the original supplier bill
  supplier_name   VARCHAR(255),
  bill_reference  VARCHAR(255),
  bill_total      DECIMAL(16,2) NOT NULL,
  recharge_total  DECIMAL(16,2) NOT NULL,
  currency_code   VARCHAR(8),
  paid_on         DATE NULL,
  -- draft     → worked out locally, nothing in Xero yet
  -- posted    → AR invoices and subsidiary bills exist in Xero
  -- settled   → every line settled by intercompany transfer
  -- cancelled → abandoned before reaching Xero
  status          ENUM('draft','posted','settled','cancelled') NOT NULL DEFAULT 'draft',
  post_error      VARCHAR(512),
  posted_at       DATETIME NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- A bill is recharged once. A cancelled run releases it.
  UNIQUE KEY uq_run_bill (account_id, bill_id),
  INDEX idx_run_list (account_id, status, created_at),
  CONSTRAINT fk_run_account2 FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_run_rule FOREIGN KEY (rule_id) REFERENCES recharge_rules(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One subsidiary's share. Each line becomes two documents in Xero: an AR
-- invoice in the payer and a draft bill in the subsidiary. Their ids are what
-- stop a line being posted twice.
CREATE TABLE IF NOT EXISTS recharge_run_lines (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id            BIGINT UNSIGNED NOT NULL,
  target_tenant_id  VARCHAR(64) NOT NULL,
  share_percent     DECIMAL(9,4),
  amount            DECIMAL(16,2) NOT NULL,
  reference         VARCHAR(255),
  ar_invoice_id     CHAR(36) NULL,           -- ACCREC in the payer
  ar_invoice_number VARCHAR(255),
  ap_invoice_id     CHAR(36) NULL,           -- ACCPAY in the subsidiary
  ap_invoice_number VARCHAR(255),
  line_error        VARCHAR(512),
  settled           TINYINT(1) NOT NULL DEFAULT 0,
  settled_reference VARCHAR(255),
  settled_on        DATE NULL,
  UNIQUE KEY uq_run_target (run_id, target_tenant_id),
  CONSTRAINT fk_rl_run FOREIGN KEY (run_id) REFERENCES recharge_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
