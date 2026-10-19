#!/usr/bin/env node
// `npm run doctor`: checks everything Hermes needs before the first run and prints the exact command for anything missing.
// Read-only: it installs nothing and records nothing. Exit code 1 only when something required is missing.
const fs = require('fs'), os = require('os'), path = require('path');
const URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434', MODEL = process.env.SPOOL_MODEL || 'qwen3:8b';
const rows = [], row = (ok, what, fix) => rows.push({ ok, what, fix });

async function main() {
  const major = +process.versions.node.split('.')[0];
  row(major >= 20, `Node ${process.versions.node}`, major >= 20 ? '' : 'Install Node 20 or newer: https://nodejs.org');
  let ff = ''; try { ff = require('ffmpeg-static'); } catch { /* not installed */ }
  row(!!ff && fs.existsSync(ff), 'ffmpeg (bundled with npm install)', 'Run: npm install');
  let el = ''; try { el = require('electron'); } catch { /* not installed */ }
  row(typeof el === 'string' && fs.existsSync(el), 'Electron', 'Run: npm install');
  row(process.platform === 'darwin' && process.arch === 'arm64', `${process.platform} ${process.arch}`, 'Hermes is built and tested on Apple silicon Macs only');

  const dataDir = process.env.SPOOL_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'spool');
  const speech = path.join(dataDir, 'models');
  const hasSpeech = fs.existsSync(speech) && fs.readdirSync(speech).length > 0;
  rows.push({ ok: hasSpeech, optional: true, what: 'Speech model (about 150 MB)', fix: 'Downloads on first run: press Download in the launcher warning. Until then new recordings stay "only you can watch".' });

  let tags = null;
  try { const r = await fetch(`${URL}/api/tags`, { signal: AbortSignal.timeout(2000) }); if (r.ok) tags = ((await r.json()).models || []).map((m) => m.name || m.model); } catch { /* not running */ }
  rows.push({ ok: tags !== null, optional: true, what: 'Ollama is running', fix: 'Optional, for titles, summaries and guides: install https://ollama.com and start it' });
  if (tags !== null) rows.push({ ok: tags.includes(MODEL), optional: true, what: `Model ${MODEL} is installed`, fix: `Run: ollama pull ${MODEL}${tags.length ? `   (installed: ${tags.join(', ')}; pick one in Settings > AI)` : ''}` });

  let bad = 0;
  for (const r of rows) {
    console.log(`${r.ok ? '✅' : r.optional ? '⚠️ ' : '❌'} ${r.what}${r.ok ? '' : '\n     ' + r.fix}`);
    if (!r.ok && !r.optional) bad++;
  }
  console.log(bad ? `\n${bad} required thing(s) missing.` : '\nReady. Start with: npm start   (macOS asks for Screen Recording the first time you press Record)');
  process.exit(bad ? 1 : 0);
}
main();
