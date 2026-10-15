// Log file + diagnostics, so an "it doesn't work" report can be diagnosed. Electron-free.
const fs = require('fs');

let file = null;
const fmt = (a) => a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');

function log(...a) {
  const line = `${new Date().toISOString()} ${fmt(a)}`;
  console.log(line);
  try { if (file) fs.appendFileSync(file, line + '\n'); } catch {}
}
const init = (f) => { file = f; };
const tail = (n = 60) => { try { return fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; } };

module.exports = { log, init, tail, get file() { return file; } };
