// Phase 4 acceptance "each action produces valid JSON for 3 different test videos", with the REAL local model (Ollama), no Electron, no windows.
// usage: node tests/e2e/actions.js      (needs Ollama running with the configured model; the first call may take a minute while it loads)
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..', '..');
const store = require(path.join(root, 'src/store')), actions = require(path.join(root, 'src/agents/actions')), llm = require(path.join(root, 'src/agents/llm'));

const VIDEOS = [
  { title: 'Fixing the login redirect', transcript: 'Hi, this is a quick walkthrough of a bug. When I log in with a valid account the page redirects to the dashboard, but if the session cookie is expired it loops back to the login page forever. I open the network tab and you can see the 302 repeating. The expected behaviour is that the expired cookie is cleared and I land on the login form once. I think the redirect middleware checks the cookie before the expiry.',
    steps: ['Open the login page', 'Sign in with a valid account', 'Expire the cookie in dev tools', 'Reload and watch the 302 loop'] },
  { title: 'Onboarding a new teammate to the staging deploy', transcript: 'Let me show you how we deploy to staging. First open the CI dashboard and pick the staging pipeline. Click run, choose the main branch, and wait for the green check. Then open the staging URL and smoke test the sign in page. If something fails, roll back with the rollback button and tell the channel.',
    steps: ['Open the CI dashboard', 'Run the staging pipeline on main', 'Smoke test the sign in page', 'Roll back if it fails'] },
  { title: 'Weekly sync: launch checklist', transcript: 'We agreed to ship the beta on Thursday. Maya will finish the billing page by Wednesday. Sam still needs to confirm the legal text, that is open. We decided to postpone the mobile app to next month. Open question: do we need a status page before launch? I will send the recap after this call.',
    steps: [] },
];
(async () => {
  if (!(await llm.available())) { console.log('FAIL  Ollama is not running'); process.exit(1); }
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-act-')), { log: () => {} });
  const ok = []; const t0 = Date.now();
  for (const vd of VIDEOS) {
    const v = store.create({ title: vd.title, status: 'ready', shareable: true, duration: 90, transcript: vd.transcript, segments: [{ start: 0, end: 90, text: vd.transcript }],
      guide: vd.steps.length ? { title: vd.title, steps: vd.steps.map((s, i) => ({ n: i + 1, at: i * 10, title: s, detail: s })) } : undefined });
    for (const id of Object.keys(actions.ACTIONS)) {
      const t = Date.now(); // run() checks the model's JSON against the action's schema and throws if it still does not match after one retry
      try { const r = await actions.run(store.get(v.id), id); const good = !!r.markdown.trim() && !!r.result; ok.push(good); console.log(`${good ? 'PASS' : 'FAIL'}  ${vd.title.slice(0, 30)} / ${id}  (${((Date.now() - t) / 1000).toFixed(1)} s)`); }
      catch (e) { ok.push(false); console.log(`FAIL  ${vd.title.slice(0, 30)} / ${id}  ${e.message.slice(0, 120)}`); }
    }
  }
  console.log(`\n${ok.filter(Boolean).length}/${ok.length} valid in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  store.close(); process.exit(ok.every(Boolean) ? 0 : 1);
})();
