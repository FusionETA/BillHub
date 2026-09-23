// Where WazzOCR's Xero tables live.
//
// Bills Hub keeps every table of its own in its own database. It does not add
// anything to WazzOCR's schema — it only reads the two Xero tables WazzOCR
// already has, so both apps share one Xero grant instead of each holding their
// own. (Two grants for the same Xero user and app cannot coexist: Xero
// supersedes the older set the moment the newer consent completes.)
//
// Both databases must be on the same MySQL cluster, and the Bills Hub database
// user needs:
//     GRANT SELECT, UPDATE ON `wazzocr`.`xero_grants`      TO '<billhub user>'@'%';
//     GRANT SELECT          ON `wazzocr`.`xero_connections` TO '<billhub user>'@'%';
//
// The single UPDATE is the rotated refresh token — Xero invalidates the old one
// on every refresh, so whoever refreshes has to write the new one back.

const DB_NAME = process.env.WAZZOCR_DB_NAME || 'wazzocr';

// A schema name can't be a bound parameter, so it is interpolated — validate it
// as a plain MySQL identifier rather than trusting the environment blindly.
if (!/^[A-Za-z0-9_$]{1,64}$/.test(DB_NAME)) {
  throw new Error(`WAZZOCR_DB_NAME must be a plain MySQL identifier; got "${DB_NAME}".`);
}

const GRANTS = `\`${DB_NAME}\`.\`xero_grants\``;
const CONNECTIONS = `\`${DB_NAME}\`.\`xero_connections\``;

module.exports = { DB_NAME, GRANTS, CONNECTIONS };
