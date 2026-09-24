// Which .env file to read.
//
//   node scripts/preflight.js                    reads .env
//   ENV_FILE=.env.wazzocr node scripts/preflight.js   reads that instead
//
// Two configurations have to coexist: .env holds the stage-1 setup (Bills Hub's
// own Xero app, the Demo Company, a local database) and a stage-2 file holds the
// borrowed-grant one (WazzOCR's app and encryption key, against WazzOCR's
// cluster). Swapping one file over the other loses whichever is underneath, and
// the two are not interchangeable — so name the file instead.
const path = require('path');

const file = process.env.ENV_FILE || '.env';
const resolved = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);

const out = require('dotenv').config({ path: resolved });
if (process.env.ENV_FILE) {
  if (out.error) {
    console.error(`[env] ENV_FILE=${file} could not be read: ${out.error.message}`);
    process.exit(1);
  }
  console.log(`[env] reading ${file}`);
}

module.exports = { file, path: resolved };
