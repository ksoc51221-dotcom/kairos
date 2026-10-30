#!/usr/bin/env node
// Zip the browser extension (without its tests) so it can be sent to someone, or uploaded to the Chrome Web Store.
//   npm run build:ext   ->  dist/kairos-extension-<version>.zip
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'extension');
const { version } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const out = path.join(__dirname, '..', 'dist', `kairos-extension-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync('zip', ['-rq', out, '.', '-x', 'tests/*', '-x', '*.DS_Store', '-x', 'README.md'], { cwd: dir, stdio: 'inherit' });
console.log(`Wrote ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
