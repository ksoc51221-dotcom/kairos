// Builds assets/icon.icns from assets/icon.png (1024 px) with sips + iconutil.
// The whole logo pipeline: `swift scripts/make-logo.swift .` (kairos-source.png -> icon.png), then `node scripts/make-icon.js`.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const out = path.join(__dirname, '..', 'assets'), set = path.join(out, 'icon.iconset');
fs.rmSync(set, { recursive: true, force: true }); fs.mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) for (const k of [1, 2]) {
  const px = s * k; execFileSync('sips', ['-z', px, px, path.join(out, 'icon.png'), '--out', path.join(set, `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]); fs.rmSync(set, { recursive: true, force: true });
console.log('icon.icns done');
