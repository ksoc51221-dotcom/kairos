// Phase 4: AI Actions (validated JSON, cached), Send to (preview first, once), the Action Plan brief, and the Spool MCP server over real stdio.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');
const llm = require('../../src/agents/llm');
const actions = require('../../src/agents/actions');
const integrations = require('../../src/agents/integrations');
const { buildActionPlan } = require('../../src/agents/action-plan');
const security = require('../../src/server/security');
const { startServer } = require('../../src/server/server');
const { withOwner } = require('./owner');

// ---- canned model answers, one per action, so the tests need no Ollama ----
const ANSWERS = {
  sop: { title: 'Rotate the staging key', purpose: 'Keep staging credentials fresh.', prerequisites: ['Admin access'], steps: [{ title: 'Open settings', detail: 'Click the gear.' }, { title: 'Rotate', detail: 'Press rotate and confirm.' }], troubleshooting: [] },
  pr: { title: 'Add retry to uploader', summary: 'Uploads now retry three times.', changes: ['Add backoff', 'Add test'], testing: ['Ran the suite'], risks: [] },
  bug: { title: 'Save button does nothing', severity: 'high', environment: 'Not stated', steps: ['Open the form', 'Press Save'], expected: 'It saves', actual: 'Nothing happens', notes: '' },
  issue: { title: 'Fix the save button', type: 'bug', description: 'Save does nothing on the profile form.', acceptanceCriteria: ['Save persists the form'], labels: ['ui'] },
  email: { subject: 'Thanks for the walkthrough', body: 'Hi [Name], thanks for your time. Next steps below.', nextSteps: ['Send the doc'] },
  recap: { title: 'Weekly sync', summary: 'We agreed the plan.', decisions: ['Ship Friday'], actionItems: [{ task: 'Write notes', owner: 'Sam' }, { task: 'Book the room', owner: '' }], openQuestions: [] },
};
let calls = [], nextAnswer = null;
const realJson = llm.json;
llm.json = async (o) => { calls.push(o); const id = Object.keys(actions.ACTIONS).find((k) => o.system === actions.ACTIONS[k].system); return structuredClone(nextAnswer ? (typeof nextAnswer === 'function' ? nextAnswer(id) : nextAnswer) : ANSWERS[id]); };
const realAvail = llm.available; llm.available = async () => true;

let srv, port, vids = [], data;
const sample = (title, speech) => store.create({ title, status: 'ready', shareable: true, duration: 90, createdAt: Date.now(), segments: speech.map((t, i) => ({ start: i * 10, end: i * 10 + 8, text: t })), transcript: speech.join(' '),
  summary: 'A walkthrough.', tasks: ['Do the thing'], guide: { kind: 'how-to', label: 'How-to guide', title: `${title} guide`, intro: 'Intro', closing: 'Done', steps: [{ n: 1, title: 'Open it', detail: 'Click open.', at: 5, image: null }, { n: 2, title: 'Save it', detail: 'Press save.', at: 25, image: null }] } });
test.before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-p4-')); store.init(path.join(data, 'library'), { log: () => {} }); // the app keeps its library in <data>/library
  vids = [sample('Staging key rotation', ['First open the settings page.', 'Then rotate the key and confirm.']), sample('Profile bug', ['The save button does nothing.', 'I expected the form to save.']), sample('Weekly sync', ['We agreed to ship on Friday.', 'Sam will write the notes.'])];
  srv = startServer({ port: 0 }); port = await srv.ready;
});
test.after(async () => { llm.json = realJson; llm.available = realAvail; await srv.close(); store.close(); });

function call(method, url, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: `127.0.0.1:${port}`, 'x-spool-csrf': security.TOKEN, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...withOwner({}, port) } }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, headers: res.headers, text: buf, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

// ---- AI Actions ----
test('every action returns schema-valid JSON and markdown for 3 different videos', async () => {
  for (const v of vids) for (const id of Object.keys(actions.ACTIONS)) {
    const r = await actions.run(store.get(v.id), id);
    assert.doesNotThrow(() => actions.validate(actions.ACTIONS[id].schema, r.result), `${id} on ${v.title}`);
    assert.ok(r.markdown.length > 40 && r.title, `${id} renders`);
    assert.match(calls.at(-1).user, new RegExp(v.title), 'the prompt carries this video');
  }
  assert.equal(calls.length, 18);
});
test('the validator rejects what the model must not get away with', () => {
  const bad = (id, raw) => assert.throws(() => actions.conform(id, raw));
  bad('bug', { ...ANSWERS.bug, severity: 'catastrophic' });          // enum
  bad('bug', { ...ANSWERS.bug, steps: [] });                         // empty where a value is required
  bad('pr', { ...ANSWERS.pr, changes: 'a string' });                 // wrong type
  bad('sop', { title: 'x', purpose: 'y' });                          // missing keys
  bad('email', null);
  const ok = actions.conform('sop', { ...ANSWERS.sop, extra: 'dropped', prerequisites: ['  a  ', ''] });
  assert.equal(ok.extra, undefined); assert.deepEqual(ok.prerequisites, ['a']);
});
test('a bad first answer is retried once with the error; two bad answers fail with a readable message', async () => {
  calls = []; let n = 0; nextAnswer = (id) => (n++ === 0 ? { ...ANSWERS[id], severity: 'bad' } : ANSWERS[id]);
  const r = await actions.run(store.get(vids[1].id), 'bug'); assert.equal(r.result.severity, 'high'); assert.equal(calls.length, 2); assert.match(calls[1].user, /rejected/);
  nextAnswer = () => ({ nonsense: true }); await assert.rejects(actions.run(store.get(vids[1].id), 'bug'), /did not match the Bug report format twice/);
  nextAnswer = null;
});
test('API: generate, cache until the transcript changes, regenerate on force', async () => {
  calls = []; const id = vids[0].id;
  const a = await call('POST', `/api/videos/${id}/actions/sop`, { body: {} }); assert.equal(a.status, 200); assert.equal(a.json.result.title, 'Rotate the staging key'); assert.equal(calls.length, 1);
  const b = await call('POST', `/api/videos/${id}/actions/sop`, { body: {} }); assert.equal(b.json.cached, true); assert.equal(calls.length, 1, 'served from the cache');
  assert.equal((await call('GET', `/api/videos/${id}/actions`)).json.actions.find((x) => x.id === 'sop').cached.stale, false);
  store.update(id, { segments: [{ start: 0, end: 5, text: 'Everything was re-recorded.' }] });
  assert.equal((await call('GET', `/api/videos/${id}/actions`)).json.actions.find((x) => x.id === 'sop').cached.stale, true, 'marked stale');
  assert.equal((await call('POST', `/api/videos/${id}/actions/sop`, { body: {} })).json.cached, undefined); assert.equal(calls.length, 2, 'regenerated');
  assert.equal((await call('POST', `/api/videos/${id}/actions/nope`, { body: {} })).status, 404);
});
test('API: nothing is generated or sent for a video the Privacy Guard has not cleared', async () => {
  const v = store.create({ title: 'Checking', status: 'ready', shareable: false, segments: [{ start: 0, end: 1, text: 'secret' }] });
  assert.equal((await call('POST', `/api/videos/${v.id}/actions/sop`, { body: {} })).status, 409);
  assert.equal((await call('POST', `/api/videos/${v.id}/send/preview`, { body: { target: 'slack', action: 'sop' } })).status, 409);
  assert.equal((await call('GET', `/api/videos/${v.id}/action-plan`)).status, 409);
});

// ---- Send to ----
const doc = { title: 'Fix the save button', markdown: '# Fix\n\nSave does nothing.\n\n- [ ] It saves', type: 'bug', labels: ['ui'] };
test('requests are built correctly for Slack, GitHub, Linear and Jira, and credentials never show in a preview', () => {
  const slack = integrations.buildRequest('slack', { hook: 'https://hooks.slack.com/services/T000/B000/XXXXSECRET' }, doc);
  assert.equal(slack.method, 'POST'); assert.match(slack.body.text, /\*Fix the save button\*/);
  const gh = integrations.buildRequest('github', { repo: 'acme/app', token: 'ghp_SECRETTOKEN1234' }, doc);
  assert.equal(gh.url, 'https://api.github.com/repos/acme/app/issues'); assert.equal(gh.headers.authorization, 'Bearer ghp_SECRETTOKEN1234'); assert.deepEqual(gh.body.labels, ['ui']);
  const lin = integrations.buildRequest('linear', { key: 'lin_api_SECRET9999', teamId: 'team-1' }, doc);
  assert.equal(lin.url, 'https://api.linear.app/graphql'); assert.equal(lin.body.variables.input.teamId, 'team-1'); assert.match(lin.body.query, /issueCreate/);
  const jira = integrations.buildRequest('jira', { site: 'acme.atlassian.net', email: 'a@acme.com', token: 'JIRASECRET7777', project: 'ENG' }, doc);
  assert.equal(jira.url, 'https://acme.atlassian.net/rest/api/3/issue'); assert.equal(jira.body.fields.issuetype.name, 'Bug'); assert.equal(jira.body.fields.description.version, 1);
  assert.match(jira.headers.authorization, /^Basic /);
  for (const [r, secret] of [[slack, 'XXXXSECRET'], [gh, 'SECRETTOKEN'], [lin, 'SECRET9999'], [jira, 'JIRASECRET']]) {
    const p = JSON.stringify(integrations.preview(r)); assert.ok(!p.includes(secret), `${r.summary}: secret hidden`);
  }
  assert.throws(() => integrations.buildRequest('github', { repo: 'acme/app' }, doc), /needs a repo.*token/);
  assert.throws(() => integrations.buildRequest('github', { repo: 'nonsense', token: 'x' }, doc), /owner\/name/);
  assert.throws(() => integrations.buildRequest('slack', { hook: 'ftp://x' }, doc), /URL/);
  assert.throws(() => integrations.buildRequest('carrier-pigeon', {}, doc), /unknown/);
});
test('API: send needs a fresh preview, works once, reaches a real endpoint with the right body, and logs it', async () => {
  const got = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ url: req.url, body: JSON.parse(b) }); res.writeHead(200); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const id = vids[1].id;
  store.setSettings({ integrations: { slack: { hook: `http://127.0.0.1:${hook.address().port}/services/T/B/SECRETPART` } } });
  await call('POST', `/api/videos/${id}/actions/bug`, { body: {} });
  assert.equal((await call('POST', `/api/videos/${id}/send`, { body: { token: 'made-up' } })).status, 409, 'no preview, no send');
  const pv = await call('POST', `/api/videos/${id}/send/preview`, { body: { target: 'slack', action: 'bug' } });
  assert.equal(pv.status, 200); assert.ok(!pv.text.includes('SECRETPART'), 'the webhook path is not shown'); assert.match(pv.json.body.text, /Save button does nothing/); assert.equal(got.length, 0, 'previewing sends nothing');
  const sent = await call('POST', `/api/videos/${id}/send`, { body: { token: pv.json.token } });
  assert.equal(sent.status, 200, sent.text); assert.equal(got.length, 1); assert.equal(got[0].url, '/services/T/B/SECRETPART'); assert.match(got[0].body.text, /Save button does nothing/);
  assert.equal((await call('POST', `/api/videos/${id}/send`, { body: { token: pv.json.token } })).status, 409, 'a preview is single use');
  assert.ok(store.get(id).activity.some((a) => /Sent to Slack/.test(a.event)));
  const other = await call('POST', `/api/videos/${vids[0].id}/send`, { body: { token: (await call('POST', `/api/videos/${id}/send/preview`, { body: { target: 'slack', action: 'bug' } })).json.token } });
  assert.equal(other.status, 409, 'a preview for one video cannot send another');
  const miss = await call('POST', `/api/videos/${id}/send/preview`, { body: { target: 'github', action: 'bug' } }); assert.equal(miss.status, 400); assert.match(miss.json.error, /needs a repo/);
  hook.close(); hook.closeAllConnections?.();
});
test('GitHub, Linear and Jira responses are understood (links, GraphQL errors, HTTP errors)', async () => {
  const fake = (status, body) => async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const g = integrations.buildRequest('github', { repo: 'a/b', token: 't' }, doc);
  assert.deepEqual(await integrations.send(g, { fetchImpl: fake(201, { html_url: 'https://github.com/a/b/issues/9', number: 9 }) }), { ok: true, status: 201, link: 'https://github.com/a/b/issues/9', detail: '#9' });
  await assert.rejects(integrations.send(g, { fetchImpl: fake(401, { message: 'Bad credentials' }) }), /401.*Bad credentials/);
  const l = integrations.buildRequest('linear', { key: 'k', teamId: 't' }, doc);
  assert.equal((await integrations.send(l, { fetchImpl: fake(200, { data: { issueCreate: { success: true, issue: { identifier: 'ENG-7', url: 'https://linear.app/x/ENG-7' } } } }) })).detail, 'ENG-7');
  await assert.rejects(integrations.send(l, { fetchImpl: fake(200, { errors: [{ message: 'team not found' }] }) }), /team not found/);
  const j = integrations.buildRequest('jira', { site: 'acme.atlassian.net', email: 'e', token: 't', project: 'ENG' }, doc);
  assert.equal((await integrations.send(j, { fetchImpl: fake(201, { key: 'ENG-12' }) })).link, 'https://acme.atlassian.net/browse/ENG-12');
});

// ---- Action Plan ----
test('the Action Plan has the voice, the steps with clicks and screenshots, and the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-plan-')); fs.mkdirSync(path.join(dir, 'guide')); fs.writeFileSync(path.join(dir, 'guide', 'step1.jpg'), 'x');
  const v = { ...store.get(vids[1].id), mode: 'screen-cam', guide: { ...store.get(vids[1].id).guide, steps: [{ n: 1, title: 'Open it', detail: 'Click open.', at: 5, image: 'step1.jpg' }, { n: 2, title: 'Save it', detail: 'Press save.', at: 25, image: null }] } };
  const md = buildActionPlan(v, { dir, timeline: { clicks: [[6, 0.1, 0.1, 1], [26, 0.9, 0.9, 1]] } });
  assert.match(md, /# Task from a screen recording: Profile bug/); assert.match(md, /Do the thing/);
  assert.match(md, new RegExp(`screenshot: \`${path.join(dir, 'guide', 'step1.jpg').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
  assert.match(md, /0:06 top-left \(10%, 10%\)/); assert.match(md, /0:26 bottom-right \(90%, 90%\)/);
  assert.match(md, /\[0:00\] The save button does nothing\./); assert.match(md, /\[bleep\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('API: the action plan downloads as markdown', async () => {
  const r = await call('GET', `/api/videos/${vids[1].id}/action-plan`); assert.equal(r.status, 200); assert.match(r.headers['content-type'], /markdown/); assert.match(r.text, /Task from a screen recording/);
});

// ---- MCP over real stdio ----
test('MCP: Claude Code can list videos and read a transcript, guide and plan over stdio; uncleared videos stay closed', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  store.update(vids[0].id, { title: 'Staging key rotation' }); store.flush();
  const hidden = store.create({ title: 'Hidden', status: 'ready', shareable: false, segments: [{ start: 0, end: 1, text: 'top secret words' }] }); store.flush();
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', '..', 'mcp', 'server.js')], env: { ...process.env, SPOOL_DATA: data }, stderr: 'ignore' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['get_action_plan', 'get_guide', 'get_transcript', 'list_videos', 'search_videos']);
    const text = (r) => r.content[0].text;
    const list = JSON.parse(text(await client.callTool({ name: 'list_videos', arguments: {} })));
    assert.ok(list.length >= 4); const mine = list.find((x) => x.id === vids[0].id); assert.equal(mine.title, 'Staging key rotation'); assert.equal(mine.cleared, true);
    const tr = text(await client.callTool({ name: 'get_transcript', arguments: { id: vids[2].id } }));
    assert.match(tr, /\[0:00\] We agreed to ship on Friday\./); assert.match(tr, /Sam will write the notes/);
    assert.match(text(await client.callTool({ name: 'get_guide', arguments: { id: vids[2].id } })), /## 1\. Open it \(0:05\)/);
    assert.match(text(await client.callTool({ name: 'get_action_plan', arguments: { id: vids[2].id } })), /Task from a screen recording: Weekly sync/);
    const found = JSON.parse(text(await client.callTool({ name: 'search_videos', arguments: { query: 'friday' } })));
    assert.equal(found.length, 1); assert.equal(found[0].id, vids[2].id); assert.equal(found[0].matches[0].at, '0:00');
    const refused = await client.callTool({ name: 'get_transcript', arguments: { id: hidden.id } });
    assert.equal(refused.isError, true); assert.match(text(refused), /not been cleared by the Privacy Guard/); assert.doesNotMatch(text(refused), /top secret/);
    assert.equal(JSON.parse(text(await client.callTool({ name: 'search_videos', arguments: { query: 'top secret' } }))).length, 0, 'search never finds uncleared content');
    assert.equal(JSON.parse(text(await client.callTool({ name: 'list_videos', arguments: {} }))).find((x) => x.id === hidden.id).summary, undefined);
    assert.equal((await client.callTool({ name: 'get_transcript', arguments: { id: 'nope' } })).isError, true);
  } finally { await client.close(); }
});
