-- Bills Hub schema — its own database on the same MySQL cluster as WazzOCR.
-- Apply with: node scripts/db-migrate.js   (safe to re-run)
--
-- Structure and conventions follow WazzOCR (accounts -> users -> sessions).
-- Every table below lives in the Bills Hub database; nothing here touches
-- WazzOCR's schema.
--
-- The xero_grants / xero_connections tables below are used when
-- XERO_GRANT_SOURCE=own (the default): Bills Hub runs its own consent and holds
-- its own token. With XERO_GRANT_SOURCE=wazzocr it reads WazzOCR's tables
-- instead and these stay empty — that avoids a second consent, which would
-- supersede WazzOCR's token. See lib/grantSource.js.

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
  -- Testing mode. When on, every call that would CHANGE something in Xero is
  -- refused at lib/xero.js, so the app can be exercised end to end — sync,
  -- select bills, generate a bank file — without a single write reaching the
  -- real organisations. Reads are untouched, so the file is built from live
  -- Xero data. Per account and persisted, because a toggle that forgets itself
  -- on restart is worse than no toggle.
  test_mode      TINYINT(1) NOT NULL DEFAULT 0,
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

-- ── Xero (XERO_GRANT_SOURCE=own) ────────────────────────────────────────────
--
-- Bills Hub's own grant, used when it runs its own consent. In
-- XERO_GRANT_SOURCE=wazzocr mode these tables are simply unused — the app reads
-- WazzOCR's instead. See lib/grantSource.js.

CREATE TABLE IF NOT EXISTS xero_grants (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id    BIGINT UNSIGNED NOT NULL,
  refresh_token VARBINARY(1024) NOT NULL,
  scope         TEXT,
  obtained_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_xerogrants_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS xero_connections (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id      BIGINT UNSIGNED NOT NULL,
  grant_id        BIGINT UNSIGNED NOT NULL,
  xero_tenant_id  VARCHAR(64) NOT NULL,
  tenant_name     VARCHAR(255),
  status          ENUM('active','expired','revoked') DEFAULT 'active',
  needs_reconnect TINYINT(1) DEFAULT 0,
  connected_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acct_tenant (account_id, xero_tenant_id),
  CONSTRAINT fk_xeroconn_account FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_xeroconn_grant   FOREIGN KEY (grant_id)   REFERENCES xero_grants(id)
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
  -- The organisation's own base currency, read from Xero. What the UI labels
  -- figures with; NULL until the first sync has asked.
  base_currency  VARCHAR(8) NULL,
  -- Xero's own short code for the organisation, e.g. "!a1B2c". A link into
  -- Xero has to say which organisation it means, or it opens whichever one
  -- the person happens to be in — and a recharge spans two. Read from
  -- /Organisation alongside the currency, so it costs no extra call.
  short_code     VARCHAR(16) NULL,
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
  -- Xero's API documents Reference as 255, but real organisations return more
  -- than that. Widened, and truncated on write as well — a field that is one
  -- character too long must never cost an organisation its sync.
  reference        VARCHAR(500),
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
  -- The premises the bill is FOR, as printed on it. On a utility bill this is
  -- the real owner of the cost, which is often not the entity on the header —
  -- see the recharge module. NULL until something has read it off the bill.
  premises_address VARCHAR(512) NULL,
  -- Where that address came from: 'ocr' (WazzOCR read the document),
  -- 'xero' (taken from the bill's own line descriptions or reference),
  -- 'manual' (typed in Bills Hub). Worth knowing, because one of these is a
  -- transcription and the other two are guesses at where someone wrote it.
  premises_source  VARCHAR(16) NULL,
  -- When Bills Hub itself marked this bill paid. Distinct from fully_paid_on
  -- and xero_status, which the sync overwrites from Xero and so cannot say
  -- who decided: a bill paid directly in Xero looks identical to one paid
  -- through here. A recharge keys on this one, because a recharge is a
  -- consequence of an action somebody took in Bills Hub.
  marked_paid_at   DATETIME NULL,
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
  -- Contacts move independently of the invoices that reference them: renaming
  -- one does not have to touch every bill it is on. So they get their own
  -- high-water mark rather than riding on the invoice cursor.
  contacts_cursor_utc DATETIME NULL,
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
  -- Hong Leong's limits move with the payment rail, so the layout has to carry
  -- which one it is: FT, IBG, RENTAS or DUITNW.
  payment_mode   VARCHAR(8) NULL,
  -- A workbook the bank supplied, with its header already in it. Rows go
  -- underneath; everything else in the file is left exactly as issued.
  template       VARCHAR(128) NULL,
  -- Which sheet inside that template the records go into. A bank's own tool is
  -- a whole workbook — BizConverter has eighteen sheets — so the file alone
  -- does not say where to write.
  template_sheet VARCHAR(64) NULL,
  template_header_rows INT NOT NULL DEFAULT 1,
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
  -- Xero's contact carries a BatchPayments block, which is the "Financial
  -- details" panel on the contact screen. Ayu Borneo use it as the single
  -- source for how a payee is paid:
  --   bank_account_name  a bank ("Maybank") for a transfer, or an all-digit
  --                      JomPay biller code ("5454") for a utility
  --   details            the lot/location, which becomes the payment narrative
  bank_account_name VARCHAR(100),
  details           VARCHAR(255),
  -- Xero's BatchPayments.Code. Ayu Borneo's payment narrative is
  -- "<entity> <supplier> <period>" — MA GE 0826 — and this is the only place
  -- the "GE" can live without inventing a second list to maintain.
  payee_code        VARCHAR(40),
  tax_number        VARCHAR(50),
  email             VARCHAR(500),
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
  -- Made while testing mode was on: a real file built from real Xero data, but
  -- nothing was posted to Xero and its bills were never reserved, so the same
  -- bills can be run again. Kept as a column rather than inferred, because
  -- "no payment id" is also what a failed posting looks like.
  test_mode        TINYINT(1) NOT NULL DEFAULT 0,
  file_name        VARCHAR(255),
  format_key       VARCHAR(64),
  -- Set once Xero has accepted the batch payment. Its presence is what stops a
  -- batch being posted twice.
  xero_batch_payment_id CHAR(36) NULL,
  -- The bank's acknowledgement for this batch, once it has been attached to
  -- every bill in it. Xero holds the file; this is only the record that it went.
  receipt_name       VARCHAR(255) NULL,
  receipt_attached_at DATETIME NULL,
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
  -- Snapshotted with the batch, not looked up when the file is rendered: the
  -- file a bank received must stay reproducible even after someone edits the
  -- contact in Xero.
  payee_bank_account_name VARCHAR(100),
  payee_details   VARCHAR(255),
  payee_code      VARCHAR(40),
  payee_email     VARCHAR(500),
  amount          DECIMAL(16,2) NOT NULL,
  -- The bill's own date, not the payment's. The JomPay Ref-2 carries the
  -- period the bill is FOR, which is the only thing telling four identical
  -- monthly bills apart; the payment date is the same on every line.
  bill_date       DATE NULL,
  reference       VARCHAR(255),
  xero_payment_id CHAR(36) NULL,
  -- Per line, so attaching to twenty bills can resume rather than start over.
  receipt_attached TINYINT(1) NOT NULL DEFAULT 0,
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
  -- Paying a bill posts its recharge, with no second click. On by default:
  -- once the rules are right the click is the same answer every time, and
  -- both documents are drafts, so nothing is authorised without a person.
  -- Here rather than in an env var so it can be stopped from the UI.
  auto_post        TINYINT(1) NOT NULL DEFAULT 1,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rcs_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Address rules ───────────────────────────────────────────────────────────
--
-- "A bill for this premises belongs to that entity."
--
-- The rule names a place, not a payer. Whoever Xero has on the bill header
-- pays the supplier; the address says whose cost it actually is. When the two
-- are the same entity nothing happens, and when they differ the whole amount
-- is recharged to the address owner.
--
-- Checked before the text rules below, because an address is a statement
-- about the real world and a supplier name is a guess from a string.
CREATE TABLE IF NOT EXISTS recharge_rules (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id        BIGINT UNSIGNED NOT NULL,
  -- As printed on the supplier bill. Kept verbatim so the rule can be read
  -- against a paper bill; matching uses the key below.
  premises_address  VARCHAR(512) NULL,
  -- premises_address with every separator stripped — see lib/premises.js.
  -- Matching on this is what makes spaces, commas and letter case irrelevant.
  address_key       VARCHAR(512) NULL,
  -- Optional. Narrows the rule to bills whose reference carries this text,
  -- for a landlord who bills several premises under one contact.
  reference_contains VARCHAR(255) NULL,
  -- The entity that premises belongs to, and so the entity the cost is
  -- recharged to.
  owner_tenant_id   VARCHAR(64) NULL,
  -- sha256 of the address key, the reference and every supplier named. Two
  -- rules with the same key describe exactly the same bills, and the second
  -- says nothing the first does not.
  rule_key          CHAR(64) NULL,
  enabled           TINYINT(1) NOT NULL DEFAULT 1,
  position          INT DEFAULT 0,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rule_premises (account_id, rule_key),
  INDEX idx_rule_lookup (account_id, enabled),
  CONSTRAINT fk_rule_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which suppliers an address rule covers. No rows at all means every
-- supplier: "whatever arrives for this building belongs to that entity",
-- which is the right rule for a premises one company occupies outright.
CREATE TABLE IF NOT EXISTS recharge_rule_suppliers (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_id       BIGINT UNSIGNED NOT NULL,
  supplier_name VARCHAR(255) NOT NULL,
  -- Normalised, so a supplier re-typed with different punctuation still
  -- matches the Xero contact.
  supplier_key  VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_rule_supplier (rule_id, supplier_key),
  INDEX idx_supplier_key (supplier_key),
  CONSTRAINT fk_rs_rule FOREIGN KEY (rule_id) REFERENCES recharge_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Recharge rules ──────────────────────────────────────────────────────────
--
-- For everything with no premises on it: rent, a tenancy, a supplier bill,
-- a central payroll deduction. A Xero bill carries no address field — only a
-- supplier, a reference, an invoice number, line descriptions and tracking —
-- so these rules match on that text instead.
--
-- Only consulted when no address rule matched. A rule acts on bills marked
-- paid in Bills Hub after the rule was written — created_at is the line, so
-- writing a rule cannot quietly reach back through years of history and
-- there is no separate date to keep in step with it.
CREATE TABLE IF NOT EXISTS recharge_text_rules (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id      BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(255) NOT NULL,
  -- all = every condition must hold; any = one is enough.
  match_mode      ENUM('all','any') NOT NULL DEFAULT 'all',
  -- NULL = any entity on the bill header. Set to narrow the rule to bills
  -- one particular company paid.
  payer_tenant_id VARCHAR(64) NULL,
  owner_tenant_id VARCHAR(64) NOT NULL,
  enabled         TINYINT(1) NOT NULL DEFAULT 1,
  last_run_at     DATETIME NULL,
  position        INT DEFAULT 0,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_text_rule_lookup (account_id, enabled, created_at),
  CONSTRAINT fk_trule_account FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One test against one field of a bill. Everything a Xero bill actually
-- carries that could identify who a cost belongs to:
--
--   supplier        Contact.Name
--   reference       Reference
--   invoice_number  InvoiceNumber
--   description     LineItems[].Description, joined
--   tracking        LineItems[].Tracking option names, joined
--
-- The last two need the bill read back from Xero one at a time, since the
-- list sync is summaryOnly — so they cost an API call and the first three
-- do not.
CREATE TABLE IF NOT EXISTS recharge_text_conditions (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_id   BIGINT UNSIGNED NOT NULL,
  field     ENUM('supplier','reference','invoice_number','description','tracking') NOT NULL,
  operator  ENUM('contains','is','starts_with','ends_with','not_contains') NOT NULL DEFAULT 'contains',
  value     VARCHAR(255) NOT NULL,
  position  INT DEFAULT 0,
  CONSTRAINT fk_tc_rule FOREIGN KEY (rule_id) REFERENCES recharge_text_rules(id) ON DELETE CASCADE,
  INDEX idx_tc_rule (rule_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One recharge of one paid bill out to one or more subsidiaries.
CREATE TABLE IF NOT EXISTS recharge_runs (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  account_id      BIGINT UNSIGNED NOT NULL,
  rule_id         BIGINT UNSIGNED NULL,      -- an address rule, or NULL
  text_rule_id    BIGINT UNSIGNED NULL,      -- a recharge rule, or NULL
                                             -- both NULL = raised by hand
  bill_id         BIGINT UNSIGNED NOT NULL,
  payer_tenant_id VARCHAR(64) NOT NULL,
  xero_invoice_id CHAR(36) NOT NULL,         -- the original supplier bill
  supplier_name   VARCHAR(255),
  bill_reference  VARCHAR(255),
  -- The premises address that decided this recharge, as it read at the time.
  -- Snapshotted rather than joined: a rule can be edited or deleted later, and
  -- the reason a cost moved between two companies has to stay readable.
  premises_address VARCHAR(512) NULL,
  bill_total      DECIMAL(16,2) NOT NULL,
  recharge_total  DECIMAL(16,2) NOT NULL,
  currency_code   VARCHAR(8),
  paid_on         DATE NULL,
  -- draft     → worked out locally, nothing in Xero yet
  -- posted    → the AR invoice and the mirror bill exist in Xero
  -- cancelled → abandoned before reaching Xero
  --
  -- There is no "settled" state. Whether the intercompany transfer has
  -- happened is a question about two Xero ledgers, and the answer lives
  -- there — recording it a second time here would only create something to
  -- disagree with.
  status          ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  -- Raised while testing mode was on: worked out from real Xero data, but
  -- nothing was ever sent to Xero and nothing ever will be. Hidden when
  -- testing mode is off, the same as a test payment batch — a run that can
  -- never be posted sitting among real ones is only confusing.
  test_mode       TINYINT(1) NOT NULL DEFAULT 0,
  post_error      VARCHAR(512),
  posted_at       DATETIME NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- A bill is recharged once — but a cancelled run releases it, and a run
  -- worked out in testing mode must not hold it against the real one. A
  -- plain UNIQUE (account_id, bill_id) says none of that: it counts
  -- cancelled rows and test rows alike. MySQL has no partial index, so the
  -- condition goes into a generated column instead, and NULL drops a row
  -- out of the index.
  live_bill_id    BIGINT UNSIGNED GENERATED ALWAYS AS
                    (IF(status = 'cancelled', NULL, bill_id)) VIRTUAL,
  UNIQUE KEY uq_run_bill (account_id, live_bill_id, test_mode),
  INDEX idx_run_list (account_id, status, created_at),
  CONSTRAINT fk_run_account2 FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT fk_run_rule FOREIGN KEY (rule_id) REFERENCES recharge_rules(id) ON DELETE SET NULL,
  CONSTRAINT fk_run_trule FOREIGN KEY (text_rule_id) REFERENCES recharge_text_rules(id) ON DELETE SET NULL
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
  UNIQUE KEY uq_run_target (run_id, target_tenant_id),
  CONSTRAINT fk_rl_run FOREIGN KEY (run_id) REFERENCES recharge_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
