// Builds Bills Hub's .env from WazzOCR's, on the box where both live.
//
//   node scripts/adopt-wazzocr-env.js --from /srv/wazzocr/.env
//   node scripts/adopt-wazzocr-env.js --from /srv/wazzocr/.env --db-name billhub --port 3311
//
// Borrowing WazzOCR's grant means sharing four values it already holds: the
// encryption key that decrypts the refresh token, the Xero client id and secret,
// and the database credentials. Retyping a production encryption key is how you
// get a deployment that fails every organisation at once with nothing in the
// logs to explain it — the two keys differ by a character nobody can see.
//
// So: read them off disk, write them straight out, and never print one. The
// report shows a fingerprint instead, which is enough to prove the two files
// agree without putting the value on a screen or in a scrollback buffer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const FROM = arg('--from');
const OUT = path.resolve(arg('--out', '.env'));
const DB_NAME = arg('--db-name', 'billhub');
const PORT = arg('--port', '3311');
const SECRET_OVERRIDE = arg('--client-secret');
const PUBLIC_URL = arg('--public-url');

if (!FROM || has('--help')) {
  console.log(`
Usage:
  node scripts/adopt-wazzocr-env.js --from <wazzocr .env> [options]

  --from <path>            WazzOCR's .env. Required.
  --out <path>             Where to write. Default .env
  --db-name <name>         Bills Hub's own database. Default billhub
  --port <n>               Port to listen on. Default 3311
  --public-url <url>       Where Bills Hub is reached, e.g.
                           https://billhub.example.com. Sets PUBLIC_BASE_URL and
                           the digest's own callback URL.
  --client-secret <value>  Use this instead of WazzOCR's, e.g. a second secret
                           generated for Bills Hub so the two are revocable
                           independently.
  --force                  Overwrite an existing output file.

Nothing is generated and nothing is printed: values are copied verbatim and
reported as fingerprints.
`);
  process.exit(has('--help') ? 0 : 1);
}

// Enough of dotenv's format for a real .env: KEY=value, optional quotes,
// comments and blanks skipped. Values containing '=' survive.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Six hex characters of a SHA-256. Proves two copies of a secret match without
// revealing anything useful about either.
const fingerprint = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 6);

if (!fs.existsSync(FROM)) {
  console.error(`\nCannot read ${FROM}.`);
  console.error('Point --from at WazzOCR\'s .env. On the droplet it is usually next to its server.js.\n');
  process.exit(1);
}
if (fs.existsSync(OUT) && !has('--force')) {
  console.error(`\n${OUT} already exists. Move it aside, or pass --force to overwrite it.\n`);
  process.exit(1);
}

const src = parseEnv(fs.readFileSync(FROM, 'utf8'));

const REQUIRED = ['APP_ENCRYPTION_KEY', 'XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD'];
const missing = REQUIRED.filter((k) => !src[k]);
if (missing.length) {
  console.error(`\n${FROM} does not define: ${missing.join(', ')}`);
  console.error('Either it is not WazzOCR\'s .env, or WazzOCR reads those from somewhere else\n'
    + '(a systemd EnvironmentFile, or the process environment). Find the file that has them.\n');
  process.exit(1);
}

const clientSecret = SECRET_OVERRIDE || src.XERO_CLIENT_SECRET;

// WazzOCR's own DB_NAME is the schema Bills Hub reads across into — a value
// that is easy to guess wrong and produces a baffling error when you do.
const wazzocrSchema = src.DB_NAME || 'wazzocr';
if (wazzocrSchema === DB_NAME) {
  console.error(`\nRefusing: --db-name "${DB_NAME}" is WazzOCR's own schema.`);
  console.error('Bills Hub keeps its own tables in its own database. Pick another name.\n');
  process.exit(1);
}

const ca = src.DB_CA_CERT ? `DB_CA_CERT=${src.DB_CA_CERT}` : null;
const caPem = src.DB_CA_CERT_PEM ? `DB_CA_CERT_PEM=${src.DB_CA_CERT_PEM}` : null;
if (!ca && !caPem) {
  console.error('\nWazzOCR\'s .env sets neither DB_CA_CERT nor DB_CA_CERT_PEM.');
  console.error('Bills Hub refuses an unverified TLS connection, so add one by hand after this runs.\n');
}

const body = `# Bills Hub — written by scripts/adopt-wazzocr-env.js on ${new Date().toISOString().slice(0, 10)}
# from ${FROM}. Shared values are copied verbatim; nothing here was generated.

PORT=${PORT}
NODE_ENV=production
# Behind nginx, so req.protocol and req.ip come from the forwarded headers.
TRUST_PROXY_HOPS=1
${PUBLIC_URL ? `PUBLIC_BASE_URL=${PUBLIC_URL}` : '# PUBLIC_BASE_URL=https://billhub.example.com   <- set this once TLS is up'}

# Sign-in is ON. Bills Hub can submit, approve and pay in the connected Xero
# organisations, so an open instance hands that to anyone who finds the URL.
AUTH_DISABLED=false
DEFAULT_ACCOUNT_ID=1

# ── Xero: WazzOCR's grant, borrowed ─────────────────────────────────────────
# No consent here, and no redirect URI. Authorising this app again with the same
# Xero login would supersede WazzOCR's token and stop its bill pipeline.
XERO_GRANT_SOURCE=wazzocr
XERO_CLIENT_ID=${src.XERO_CLIENT_ID}
XERO_CLIENT_SECRET=${clientSecret}

# A value matching no tenant id: every Xero WRITE is refused, every read works.
# Leave it until you have deliberately chosen what may be written to, then
# replace it with the line \`npm run entities only <CODE>\` prints.
XERO_TENANT_ALLOWLIST=not-yet-reviewed-nothing-is-writable

# ── WazzOCR ─────────────────────────────────────────────────────────────────
WAZZOCR_DB_NAME=${wazzocrSchema}
WAZZOCR_URL=${src.PUBLIC_BASE_URL || 'https://wazzocr.fusioneta.com.my'}

# Copied verbatim. This decrypts WazzOCR's stored refresh token; a generated one
# cannot, and every organisation fails at once if it is wrong.
APP_ENCRYPTION_KEY=${src.APP_ENCRYPTION_KEY}

# ── Database — same cluster, Bills Hub's own schema ─────────────────────────
DB_HOST=${src.DB_HOST}
DB_PORT=${src.DB_PORT || '25060'}
DB_USER=${src.DB_USER}
DB_PASSWORD=${src.DB_PASSWORD}
DB_NAME=${DB_NAME}
${ca || caPem || '# DB_CA_CERT=certs/do-mysql-ca.crt   <- set one of these'}

# ── Off until you turn them on ──────────────────────────────────────────────
# No background sync across 41 organisations, and no Wazzup credentials, so
# nothing syncs or sends while you are still looking around.
SYNC_INTERVAL_MINUTES=0
SYNC_CONCURRENCY=2
${PUBLIC_URL ? `DIGEST_QUEUE_URL=${PUBLIC_URL}` : '# DIGEST_QUEUE_URL='}
# WAZZUP_CHANNEL_ID=
# WAZZUP_API_KEY=
# WAZZUP_SENDER_PHONE=
`;

fs.writeFileSync(OUT, body, { mode: 0o600 });

console.log(`\nWrote ${OUT}  (chmod 600)\n`);
console.log('  Copied from WazzOCR, verbatim:');
console.log(`    APP_ENCRYPTION_KEY   fingerprint ${fingerprint(src.APP_ENCRYPTION_KEY)}  (${src.APP_ENCRYPTION_KEY.length} chars)`);
console.log(`    XERO_CLIENT_ID       ${src.XERO_CLIENT_ID}`);
console.log(`    XERO_CLIENT_SECRET   fingerprint ${fingerprint(clientSecret)}${SECRET_OVERRIDE ? '  (yours, not WazzOCR\'s)' : ''}`);
console.log(`    DB_HOST              ${src.DB_HOST}:${src.DB_PORT || '25060'}`);
console.log(`    DB_USER              ${src.DB_USER}`);
console.log(`    DB_PASSWORD          fingerprint ${fingerprint(src.DB_PASSWORD)}`);
console.log('\n  Set for Bills Hub:');
console.log(`    DB_NAME              ${DB_NAME}          (its own; create it if you have not)`);
if (PUBLIC_URL) console.log(`    PUBLIC_BASE_URL      ${PUBLIC_URL}`);
console.log(`    WAZZOCR_DB_NAME      ${wazzocrSchema}          (read across into)`);
console.log('    XERO_TENANT_ALLOWLIST  matches nothing — all writes refused');
console.log('    AUTH_DISABLED        false');
console.log(`
  Next:
    CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
    GRANT SELECT, UPDATE ON \`${wazzocrSchema}\`.\`xero_grants\`       TO '${src.DB_USER}'@'%';
    GRANT SELECT          ON \`${wazzocrSchema}\`.\`xero_connections\` TO '${src.DB_USER}'@'%';

    npm run db:migrate
    node scripts/preflight.js
`);
