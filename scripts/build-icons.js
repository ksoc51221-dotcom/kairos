// Renders assets/icon.svg to assets/icon.png (1024), assets/icon.icns and extension/icons/icon{16,32,48,128}.png, headlessly.
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/build-icons.js     (falls back to the repo's playwright-core)
// Chromium: PLAYWRIGHT_CHROMIUM=/path/to/headless_shell or Chromium to override; otherwise playwright's own download is used.
// Extension icons are full-bleed (no transparent margin, Chrome adds none). Extension and iconset 16/32 drop the hairline rim and use a larger mark and hub so they stay crisp.
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const root = path.join(__dirname, '..'), svg = fs.readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const small = svg.replace(/<path d="[^"]*" fill="none"[^>]*\/>\n/, '').replace('scale(24.5)', 'scale(27.5)').replace('r="1.9"', 'r="2.3"');
const bleed = (x) => x.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
(async () => {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  const render = async (src, px, file) => {
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${src}`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
  };
  const set = path.join(os.tmpdir(), 'kairos-icon.iconset'); fs.rmSync(set, { recursive: true, force: true }); fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) for (const k of [1, 2]) await render(s * k <= 32 ? small : svg, s * k, path.join(set, `icon_${s}x${s}${k === 2 ? '@2x' : ''}.png`));
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'assets', 'icon.icns')]); fs.rmSync(set, { recursive: true, force: true });
  await render(svg, 1024, path.join(root, 'assets', 'icon.png'));
  for (const s of [16, 32, 48, 128]) await render(bleed(s <= 32 ? small : svg), s, path.join(root, 'extension', 'icons', `icon${s}.png`));
  fs.copyFileSync(path.join(root, 'assets', 'icon.svg'), path.join(root, 'src', 'server', 'public', 'favicon.svg'));
  await browser.close(); console.log('icons done');
})().catch((e) => { console.error(e); process.exit(1); });
