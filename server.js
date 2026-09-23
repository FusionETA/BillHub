// Bills Hub — Express bootstrap.
//
//   npm start          production
//   npm run dev        with a local .env
//
// Module 1 (Bills): sync across every connected organisation, the bills list,
// and submit/approve straight through to Xero.
// Module 2 (Bank files): payment batches, bank-format files, and recording the
// payment in Xero as a batch payment.
// Module 3 (Notifications): the scheduled WhatsApp digest of draft bills.
// Module 4 (Recharge): intercompany recharges — an AR invoice in the payer and
// a mirror bill in the subsidiary, settled by intercompany transfer.
require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('./db');
const sync = require('./billhub/sync');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Behind DigitalOcean's load balancer, so req.protocol and req.ip come from the
// forwarded headers — the OAuth redirect URI depends on getting this right.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use('/api/auth', require('./auth/router'));
app.use('/api/xero', require('./billhub/xeroRouter'));
app.use('/api/bills', require('./billhub/router'));
app.use('/api/payments', require('./billhub/paymentsRouter'));
app.use('/api/digest', require('./billhub/digestRouter'));
app.use('/api/recharge', require('./billhub/rechargeRouter'));

app.get('/api/health', async (req, res) => {
  try {
    await db.ping();
  } catch (err) {
    return res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
  // Bills Hub reads WazzOCR's Xero tables, so a missing GRANT is a deployment
  // fault worth surfacing here rather than discovering it one sync at a time.
  const { GRANTS } = require('./lib/grantSource');
  let grantStore = 'up';
  try {
    await db.getOne(`SELECT 1 FROM ${GRANTS} LIMIT 1`);
  } catch (err) {
    grantStore = `unreadable: ${err.code || err.message}`;
  }
  res.json({ ok: grantStore === 'up', db: 'up', wazzocrGrantStore: grantStore });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// JSON errors for /api, so the client never has to parse an HTML error page.
app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  if (res.headersSent) return next(err);
  const status = err.statusCode || 500;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: err.message });
  res.status(status).send(err.message);
});

// Only bind a port when started directly, so tests can mount the same app on
// their own port.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Bills Hub listening on :${PORT}`);
    if (require('./auth/middleware').AUTH_DISABLED) {
      console.warn('');
      console.warn('  ****************************************************************');
      console.warn('  *  AUTH_DISABLED=true — there is no sign-in.                   *');
      console.warn('  *  Anyone who can reach this URL can submit and approve bills  *');
      console.warn('  *  in the connected Xero organisations. Do not expose it.      *');
      console.warn('  ****************************************************************');
      console.warn('');
    }
    db.ping()
      .then(async () => {
        console.log('[db] connected');
        // Ship the built-in bank layouts. Idempotent, and it never overwrites a
        // layout someone has corrected.
        await require('./models/bankFormats').seedBuiltIns()
          .catch((e) => console.error('[payments] could not seed bank formats:', e.message));
        // Fill the Wazzup channel from the environment on a fresh deployment.
        await (async () => {
          const digestModel = require('./models/digest');
          const rows = await db.query("SELECT id FROM accounts WHERE status <> 'suspended'");
          for (const a of rows) await digestModel.seedFromEnv(a.id);
        })().catch((e) => console.error('[digest] could not seed settings:', e.message));
        sync.startScheduler();
        require('./billhub/digest').startScheduler();
      })
      .catch((err) => console.error('[db] NOT connected:', err.message));
  });

  // Let in-flight Xero calls finish before the process goes away on a redeploy.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`[server] ${signal} — shutting down`);
      sync.stopScheduler();
      require('./billhub/digest').stopScheduler();
      server.close(() => db.close().finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 10000).unref();
    });
  }
}

module.exports = app;
