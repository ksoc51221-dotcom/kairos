// A small GitHub client for "Publish to GitHub": one public repository per shared video, served by GitHub Pages. It only uses the REST API, so Kairos needs
// no git and no extra software. Everything is injectable (fetch, sleep) so the tests run against an in-process fake and never touch the network.
//
// Honest limits, repeated in the UI: a GitHub link has no password, and deleting the repository does not undo copies, forks or caches.
const API = 'https://api.github.com';

class GitHubError extends Error {
  constructor(code, message, status) { super(message); this.name = 'GitHubError'; this.code = code; this.status = status; }
}

// What the owner reads when something goes wrong.
function explain(e) {
  if (!e || e.name !== 'GitHubError') return String(e?.message || e).slice(0, 300);
  switch (e.code) {
    case 'bad_token': return 'GitHub did not accept the token. It may have expired or been revoked. Make a new one and paste it in Settings -> Publish to GitHub.';
    case 'no_create': return 'This GitHub token cannot create repositories. Use a classic token with the "repo" permission (or run "gh auth login" and tick "Use my GitHub CLI login").';
    case 'no_delete': return `GitHub says this token is not allowed to delete repositories. ${e.message}`;
    case 'rate_limit': return 'GitHub is asking Kairos to slow down. Try again in a few minutes.';
    case 'network': return 'Could not reach GitHub. Check your internet connection.';
    case 'pages_failed': return e.message;
    case 'cancelled': return 'Cancelled.';
    default: return e.message;
  }
}

function createGitHub({ token, fetch: f = (...a) => globalThis.fetch(...a), retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 3000, pollMax = 80, api = API } = {}) {
  if (!token) throw new GitHubError('bad_token', 'No GitHub token.');
  let login = null;

  async function request(method, path, body, { signal, okStatuses = [], retry404 = 0, raw = false } = {}) {
    const url = path.startsWith('http') ? path : `${api}${path}`;
    let lastErr;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new GitHubError('cancelled', 'cancelled');
      let res;
      try {
        res = await f(url, { method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Kairos', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        if (signal?.aborted || e?.name === 'AbortError') throw new GitHubError('cancelled', 'cancelled');
        lastErr = new GitHubError('network', `Could not reach GitHub (${e?.cause?.code || e?.message || e}).`);
        if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        throw lastErr;
      }
      const text = res.status === 204 ? '' : await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (res.ok || okStatuses.includes(res.status)) return raw ? { status: res.status, data, headers: res.headers } : data;
      const msg = data?.message || `HTTP ${res.status}`;
      if (res.status === 401) throw new GitHubError('bad_token', msg, 401);
      const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse|secondary/i.test(msg)));
      if (limited) { if (attempt < retries) { await sleep(Math.min(20000, 1500 * 2 ** attempt)); continue; } throw new GitHubError('rate_limit', msg, res.status); }
      if (res.status >= 500 && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
      if (res.status === 404 && attempt < retry404) { await sleep(700 * (attempt + 1)); continue; } // a repository that was only just created can take a moment to appear
      throw new GitHubError(res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : res.status === 422 ? 'invalid' : 'http', msg, res.status);
    }
  }

  const gh = {
    // { login, scopes } — scopes is null for fine-grained tokens (GitHub does not report them).
    async user(opts) {
      const r = await request('GET', '/user', null, { ...opts, raw: true });
      login = r.data.login;
      const h = r.headers.get('x-oauth-scopes');
      return { login, scopes: h == null ? null : h.split(',').map((s) => s.trim()).filter(Boolean) };
    },
    async check(opts) {
      const u = await gh.user(opts), s = u.scopes;
      return { login: u.login, scopes: s, canCreate: s ? s.includes('repo') || s.includes('public_repo') : null, canDelete: s ? s.includes('delete_repo') : null };
    },
    // The repository starts PRIVATE. Nothing is visible until makePublic(), which is the moment the link goes live.
    async createRepo(name, description, opts) {
      if (!login) await gh.user(opts);
      try {
        await request('POST', '/user/repos', { name, description, private: true, has_issues: false, has_projects: false, has_wiki: false, auto_init: false }, opts);
      } catch (e) {
        if (e.code === 'forbidden' || e.code === 'not_found') throw new GitHubError('no_create', e.message, e.status);
        throw e;
      }
      return { owner: login, name };
    },
    // Creates or replaces one file on the default branch. Files are written one after another, never at the same time.
    async putFile(repo, path, content, message, opts) {
      if (!login) await gh.user(opts);
      return request('PUT', `/repos/${login}/${repo}/contents/${path}`, { message, content: Buffer.from(content).toString('base64') }, { ...opts, retry404: 5 });
    },
    async makePublic(repo, opts) {
      await request('PATCH', `/repos/${login}/${repo}`, { private: false }, opts);
    },
    async enablePages(repo, opts) {
      const info = await request('GET', `/repos/${login}/${repo}`, null, opts);
      await request('POST', `/repos/${login}/${repo}/pages`, { source: { branch: info.default_branch || 'main', path: '/' } }, { ...opts, okStatuses: [409] });
    },
    // Resolves with the page address once GitHub has built the site and the address answers.
    async waitForPages(repo, opts = {}) {
      let url = `https://${login}.github.io/${repo}/`;
      for (let i = 0; i < pollMax; i++) {
        let b = null;
        try { b = await request('GET', `/repos/${login}/${repo}/pages/builds/latest`, null, { ...opts, retries: 0 }); } catch (e) { if (e.code === 'cancelled' || e.code === 'bad_token') throw e; }
        if (b?.status === 'errored') throw new GitHubError('pages_failed', `GitHub could not build the page${b.error?.message ? `: ${b.error.message}` : ''}.`);
        if (b?.status === 'built') {
          try { const p = await request('GET', `/repos/${login}/${repo}/pages`, null, opts); if (p?.html_url) url = p.html_url; } catch { /* keep the guess */ }
          try { const r = await f(url, { method: 'GET', signal: opts.signal, headers: { 'User-Agent': 'Kairos' } }); if (r.ok) { await r.arrayBuffer?.(); return url; } } catch (e) { if (opts.signal?.aborted) throw new GitHubError('cancelled', 'cancelled'); }
        }
        await sleep(pollMs);
      }
      throw new GitHubError('pages_failed', 'GitHub is still building the page. The repository exists; open it on GitHub and check Settings -> Pages in a few minutes.');
    },
    async deleteRepo(repo, opts) {
      if (!login) await gh.user(opts);
      try { await request('DELETE', `/repos/${login}/${repo}`, null, { ...opts, okStatuses: [404] }); }
      catch (e) {
        if (e.code === 'forbidden') throw new GitHubError('no_delete', `Delete https://github.com/${login}/${repo} yourself (its Settings page, Danger Zone), or give the token the "delete_repo" permission.`, e.status);
        throw e;
      }
    },
    get login() { return login; },
  };
  return gh;
}

// The page a viewer opens: just the video, nothing else loads from anywhere. `base` is the page's own address (for the link-preview picture).
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pageHtml({ title, base }) {
  const t = esc(String(title || 'Recording').slice(0, 200));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${t}</title>
<meta property="og:title" content="${t}">
<meta property="og:type" content="video.other">
<meta property="og:image" content="${esc(base)}thumb.jpg">
<style>
  body{margin:0;background:#0b0d10;color:#e8eaed;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
  main{width:min(960px,100% - 32px);padding:24px 0}
  video{width:100%;border-radius:12px;background:#000}
  h1{font-size:1.25rem;margin:0 0 12px}
  p{opacity:.65;margin:12px 0 0;font-size:14px}
</style>
</head>
<body>
<main>
  <h1>${t}</h1>
  <video src="video.mp4" poster="thumb.jpg" controls playsinline preload="metadata"></video>
  <p>Recorded with Kairos.</p>
</main>
</body>
</html>
`;
}

module.exports = { GitHubError, createGitHub, explain, pageHtml };
