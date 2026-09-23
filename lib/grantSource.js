// Where Bills Hub's Xero grant lives.
//
//   XERO_GRANT_SOURCE=own       (default) Bills Hub holds its own grant, in its
//                               own tables, obtained through its own consent.
//                               Standalone: it needs nothing from WazzOCR.
//
//   XERO_GRANT_SOURCE=wazzocr   Bills Hub borrows WazzOCR's existing grant by
//                               reading wazzocr.xero_grants. No second consent,
//                               so WazzOCR's token is never superseded — but the
//                               two apps then share one token, and Bills Hub
//                               must use WazzOCR's client id, secret and
//                               APP_ENCRYPTION_KEY.
//
// `own` is the default because it is self-contained and cannot affect anything
// else. Switch to `wazzocr` once a deployment is proven and you want the 41
// organisations without another consent.
//
// Xero tenant ids identify the organisation, not the app connection, so the
// same organisation keeps its id across both modes — `entities`, `bills` and
// everything else keyed on it survive the switch.

const MODE = String(process.env.XERO_GRANT_SOURCE || 'own').trim().toLowerCase();

if (!['own', 'wazzocr'].includes(MODE)) {
  throw new Error(`XERO_GRANT_SOURCE must be "own" or "wazzocr"; got "${MODE}".`);
}

const WAZZOCR_DB = process.env.WAZZOCR_DB_NAME || 'wazzocr';
if (MODE === 'wazzocr' && !/^[A-Za-z0-9_$]{1,64}$/.test(WAZZOCR_DB)) {
  throw new Error(`WAZZOCR_DB_NAME must be a plain MySQL identifier; got "${WAZZOCR_DB}".`);
}

const BORROWED = MODE === 'wazzocr';
const GRANTS = BORROWED ? `\`${WAZZOCR_DB}\`.\`xero_grants\`` : '`xero_grants`';
const CONNECTIONS = BORROWED ? `\`${WAZZOCR_DB}\`.\`xero_connections\`` : '`xero_connections`';

// The account id the connections table is keyed by. Bills Hub's own in `own`
// mode; WazzOCR's in `wazzocr` mode, since the two databases number accounts
// independently.
async function connectionsAccountId(accountId) {
  if (!BORROWED) return accountId;
  return require('../models/accounts').wazzocrIdFor(accountId);
}

function describe() {
  return BORROWED
    ? `borrowing WazzOCR's Xero grant from "${WAZZOCR_DB}"`
    : 'using its own Xero grant';
}

module.exports = { MODE, BORROWED, GRANTS, CONNECTIONS, WAZZOCR_DB, connectionsAccountId, describe };
