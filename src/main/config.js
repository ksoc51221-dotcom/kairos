// Process-level configuration read from the environment (used by tests and the packaged app alike).
const { PORT: DEFAULT_PORT } = require('../shared/constants');

// SPOOL_SELFTEST='{"mode":"screen-cam","seconds":10,...}' runs a scripted scenario instead of opening the launcher (see selftest.js)
let SELFTEST = null;
try { SELFTEST = process.env.SPOOL_SELFTEST ? JSON.parse(process.env.SPOOL_SELFTEST) : null; } catch (e) { console.error('SPOOL_SELFTEST is not valid JSON:', e.message); process.exit(2); }

const PORT = +process.env.SPOOL_PORT || DEFAULT_PORT;
const origin = (p = '') => `http://localhost:${PORT}${p}`;
// R1: a link for the OWNER's browser: it signs this browser in as the owner (one-time code), then lands on `p`. Never copy it to the clipboard or share it.
const ownerOrigin = (p = '/') => origin(require('../server/security').ownerLoginPath(p));
const dataDir = (app) => process.env.SPOOL_DATA || app.getPath('userData');

module.exports = { SELFTEST, PORT, origin, ownerOrigin, dataDir };
