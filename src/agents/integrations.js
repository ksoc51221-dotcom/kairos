// Send to (Phase 4): Slack (incoming webhook), GitHub issue, Linear issue (GraphQL), Jira issue (REST v3).
// Tokens stay in this computer's settings and go only to the service they belong to. Nothing is sent without a preview: `buildRequest` is a pure
// function that returns the exact request, the UI shows it, and `send` only runs a request that was previewed (see server/routes/actions.js).
const TARGETS = {
  slack: { label: 'Slack', needs: ['hook'], doc: 'an incoming webhook URL' },
  github: { label: 'GitHub issue', needs: ['repo', 'token'], doc: 'a repo (owner/name) and a token with the issues scope' },
  linear: { label: 'Linear issue', needs: ['key', 'teamId'], doc: 'an API key and a team ID' },
  jira: { label: 'Jira issue', needs: ['site', 'email', 'token', 'project'], doc: 'a site, e-mail, API token and project key' },
};

const missing = (target, cfg = {}) => TARGETS[target].needs.filter((k) => !String(cfg[k] || '').trim());
const mask = (s) => (s ? '••••' + String(s).slice(-4) : '');

// Jira wants Atlassian Document Format, not markdown. One paragraph per line, which keeps the text readable and always valid.
const adf = (text) => ({ type: 'doc', version: 1, content: String(text).split(/\n{1,}/).filter((l) => l.trim()).map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })) });

// doc = { title, markdown, type? } -> { method, url, headers, body, secrets:[header names to mask], summary }
function buildRequest(target, cfg = {}, doc) {
  if (!TARGETS[target]) throw new Error('unknown target');
  const m = missing(target, cfg); if (m.length) throw Object.assign(new Error(`${TARGETS[target].label} needs ${TARGETS[target].doc}. Add ${m.join(', ')} in Settings → Workspace → Integrations.`), { status: 400 });
  const title = String(doc.title || 'Kairos recording').slice(0, 250), text = String(doc.markdown || '');
  const json = { 'content-type': 'application/json' };
  if (target === 'slack') {
    const url = String(cfg.hook).trim(); if (!/^https?:\/\//.test(url)) throw Object.assign(new Error('The Slack webhook must be a URL'), { status: 400 });
    return { method: 'POST', url, headers: json, body: { text: `*${title}*\n${text.replace(/^#\s+.*\n+/, '').replace(/^#+\s*(.*)$/gm, '*$1*').replace(/\*\*(.+?)\*\*/g, '*$1*')}`.slice(0, 38000) }, secretUrl: true, summary: 'Post a message to your Slack channel' };
  }
  if (target === 'github') {
    const repo = String(cfg.repo).trim(); if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Object.assign(new Error('GitHub repo must look like owner/name'), { status: 400 });
    const base = String(cfg.api || 'https://api.github.com').replace(/\/$/, '');
    return { method: 'POST', url: `${base}/repos/${repo}/issues`, headers: { ...json, authorization: `Bearer ${cfg.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'spool' }, body: { title, body: text.slice(0, 60000), ...(doc.labels?.length ? { labels: doc.labels.slice(0, 5) } : {}) }, secrets: ['authorization'], summary: `Open an issue in ${repo}` };
  }
  if (target === 'linear') {
    const query = 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }';
    return { method: 'POST', url: String(cfg.api || 'https://api.linear.app/graphql'), headers: { ...json, authorization: String(cfg.key) }, body: { query, variables: { input: { teamId: String(cfg.teamId).trim(), title, description: text.slice(0, 60000) } } }, secrets: ['authorization'], summary: 'Create a Linear issue' };
  }
  const site = String(cfg.site).trim().replace(/\/$/, ''), base = /^https?:\/\//.test(site) ? site : `https://${site}`;
  return { method: 'POST', url: `${base}/rest/api/3/issue`, headers: { ...json, authorization: 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64'), accept: 'application/json' },
    body: { fields: { project: { key: String(cfg.project).trim() }, summary: title, description: adf(text.slice(0, 30000)), issuetype: { name: doc.type === 'bug' ? 'Bug' : doc.type === 'story' ? 'Story' : 'Task' } } }, secrets: ['authorization'], summary: `Create a Jira ${doc.type === 'bug' ? 'bug' : 'issue'} in ${cfg.project}` };
}

// What the preview shows: the request with every credential hidden. A Slack webhook URL *is* the credential, so only its host is shown.
function preview(req) {
  const u = new URL(req.url);
  return { summary: req.summary, method: req.method, url: req.secretUrl ? `${u.origin}/… (the webhook address is the secret)` : req.url,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, (req.secrets || []).includes(k) ? mask(v) : v])), body: req.body };
}

// Runs a previewed request. Returns { ok, status, link?, detail }.
async function send(req, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const r = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${new URL(req.url).hostname} answered ${r.status}: ${(j?.message || j?.errors?.[0]?.message || text).toString().slice(0, 200)}`);
  if (j?.errors?.length) throw new Error(`${new URL(req.url).hostname}: ${j.errors[0].message}`); // GraphQL reports failures with a 200
  const link = j?.html_url || j?.data?.issueCreate?.issue?.url || (j?.key && cfgBrowse(req, j.key)) || null;
  if (j?.data && j.data.issueCreate && !j.data.issueCreate.success) throw new Error('Linear did not create the issue');
  return { ok: true, status: r.status, link, detail: j?.number ? `#${j.number}` : j?.data?.issueCreate?.issue?.identifier || j?.key || 'sent' };
}
const cfgBrowse = (req, key) => { try { return `${new URL(req.url).origin}/browse/${key}`; } catch { return null; } };

module.exports = { TARGETS, buildRequest, preview, send, missing, mask };
