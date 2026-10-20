#!/usr/bin/env node
// Builds dist/Kairos-darwin-arm64/Kairos.app: package, leave out what must not ship, sign.
//   node scripts/build-mac.js            build and sign
//   node scripts/build-mac.js --dry      list what would ship and how big it is, without building (touches no permission, opens nothing)
// Signing: the identity named in $SPOOL_SIGN (default "Spool Dev") when it exists in the keychain, otherwise ad hoc. An ad-hoc signature changes on
// every build, which makes macOS forget the Screen Recording permission each time; a stable identity keeps it.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
// Regular expressions on the path inside the app folder (starts with /). Anything that matches is left out of the package.
const IGNORE = [
  /^\/(dist|design|tests|scripts|cloud|\.git|\.claude|library)(\/|$)/,                 // build output, the Loom reference screenshots, tests, build scripts
  /^\/(FEATURES|PLAN|REVIEW|PHASE4-CHECK|README)\.md$/, /^\/package-lock\.json$/, /^\/assets\/kairos-source\.png$/, /^\/PITCH\.md$/, /^\/\./,   // project notes and dotfiles (the app has its own mcp/README.md)
  /^\/node_modules\/onnxruntime-node\/bin\/napi-v\d+\/(linux|win32|darwin\/x64)(\/|$)/, // speech engine: darwin/arm64 only (linux and win32 are ~200 MB)
  /^\/node_modules\/onnxruntime-web(\/|$)/,                                      // browser build of the same engine; the Node build above is what runs
  /^\/node_modules\/uiohook-napi\/prebuilds\/(linux|win32|darwin-x64)[^/]*(\/|$)/,        // mouse hook: this Mac only
  /^\/node_modules\/@tesseract\.js-data\/eng\/4\.0\.0(\/|$)/,                 // OCR language data: only 4.0.0_best_int is read (ocr.js LANG_PATH)
  /^\/node_modules\/@mediapipe\/tasks-vision\/(wasm|vision_bundle\.(cjs|js)|README\.md)(\/|$)/, // gestures: only vision_bundle.mjs is read from the package; the WASM and the model ship from assets/models
  /\.map$/, /\.d\.ts$/, /^\/node_modules\/.*\/(test|tests|docs|examples?)\//,    // source maps, type files, other packages' tests and docs
];
const ignored = (rel) => IGNORE.some((re) => re.test(rel));

function walk(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (ignored(r)) continue;
    if (e.isDirectory()) walk(dir, r, out); else if (e.isFile()) out.push([r, fs.statSync(path.join(dir, r)).size]);
  }
  return out;
}

// What the packager keeps of node_modules is only production dependencies; for the dry run, those are found the same way (npm ls --omit=dev).
function prodModules() {
  const r = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  return new Set(r.stdout.split('\n').filter((l) => l.includes('/node_modules/')).map((l) => l.slice(root.length)));
}

function shipped() {
  const prod = prodModules(), files = [];
  for (const [rel, size] of walk(root)) {
    if (rel.startsWith('/node_modules/electron/')) continue; // the packager supplies Electron itself
    if (rel.startsWith('/node_modules/')) { const m = /^(\/node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(rel); if (!prod.has(m[1]) && !/^\/node_modules\/[^/]+\/node_modules\//.test(rel)) continue; }
    files.push([rel, size]);
  }
  return files;
}

// --stage <dir>: copy exactly what would ship into <dir>, so the trimmed tree can be exercised with plain node, without a build.
function stage(to) {
  for (const [rel] of shipped()) { fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true }); fs.copyFileSync(path.join(root, rel), path.join(to, rel)); }
  console.log('staged into', to);
}

function dry() {
  const files = shipped();
  const total = files.reduce((n, f) => n + f[1], 0), top = {};
  for (const [rel, size] of files) { const k = rel.split('/').slice(1, rel.startsWith('/node_modules/') ? 3 : 2).join('/'); top[k] = (top[k] || 0) + size; }
  console.log(`app folder: ${files.length} files, ${(total / 1048576).toFixed(0)} MB (Electron itself adds about 290 MB)`);
  for (const [k, n] of Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(n / 1048576).toFixed(1).padStart(7)} MB  ${k}`);
  const leaked = files.filter(([rel]) => /^\/(design|tests|PLAN\.md|REVIEW\.md|PHASE4-CHECK\.md)/.test(rel));
  if (leaked.length) { console.error('LEAK:', leaked.slice(0, 5)); process.exit(1); }
  const other = files.filter(([rel]) => /onnxruntime-node\/bin\/napi-v\d+\/(linux|win32)/.test(rel));
  if (other.length) { console.error('non-darwin binaries would ship:', other.slice(0, 3)); process.exit(1); }
}

async function build() {
  const { packager } = require('@electron/packager');
  const [dir] = await packager({
    dir: root, name: 'Kairos', platform: 'darwin', arch: 'arm64', out: path.join(root, 'dist'), overwrite: true, asar: false,
    appBundleId: 'app.hermes.recorder', icon: path.join(root, 'assets', 'icon'), extendInfo: path.join(__dirname, 'Info.extend.plist'), ignore: IGNORE,
  });
  const app = path.join(dir, 'Kairos.app');
  const want = process.env.SPOOL_SIGN || 'Spool Dev';
  const have = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout.includes(`"${want}"`);
  const r = spawnSync('codesign', ['--force', '--deep', '--sign', have ? want : '-', app], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('codesign failed');
  console.log(have ? `signed with "${want}": Screen Recording permission survives rebuilds` : 'signed ad hoc: Screen Recording permission resets on every build (create a "Spool Dev" certificate to avoid that)');
  console.log(app);
}

const stageAt = process.argv.indexOf('--stage');
if (require.main === module) (stageAt > 0 ? Promise.resolve(stage(process.argv[stageAt + 1])) : process.argv.includes('--dry') ? Promise.resolve(dry()) : build()).catch((e) => { console.error(e); process.exit(1); });
module.exports = { IGNORE, ignored };
