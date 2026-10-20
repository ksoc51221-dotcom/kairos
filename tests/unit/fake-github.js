// An in-process stand-in for the parts of GitHub that "Publish to GitHub" uses: the REST API (user, repos, contents, pages, delete) and the
// github.io site that Pages serves. It is a `fetch` replacement, so no port is opened and nothing touches the network. It is as strict as GitHub
// where it matters here: a token is required, a repository name can only be used once, files can only be written to a repository that exists
// (a fresh one can answer 404 for a moment), Pages needs a public repository, a build takes a few polls, and deleting needs a permission.
const SITE = /^https:\/\/([^.]+)\.github\.io\/([^/]+)\/(.*)$/;

function createFakeGitHub(opts = {}) {
  const cfg = { token: 'ghp_testtoken', login: 'octo', scopes: ['repo', 'delete_repo'], appearAfter: 0, buildPolls: 2, ...opts };
  const repos = new Map(); // name -> { name, private, files: Map(path -> Buffer), pages: null | { polls, status }, commits: number, appearLeft }
  const calls = [];
  const injections = []; // { match: RegExp on "METHOD path", status, body, headers, times }

  const json = (status, obj, headers = {}) => new Response(status === 204 ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const err = (status, message, headers) => json(status, { message }, headers);

  async function fetch(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    if (init.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const u = new URL(url);
    calls.push({ method, url: u.host + u.pathname, body: init.body });

    if (u.host.endsWith('.github.io')) { // the Pages site
      const m = SITE.exec(url);
      if (!m) return new Response('not found', { status: 404 });
      const r = repos.get(m[2]);
      if (!r || r.private || m[1] !== cfg.login || r.pages?.status !== 'built') return new Response('not found', { status: 404 });
      const file = m[3] || 'index.html';
      return r.files.has(file) ? new Response(r.files.get(file), { status: 200 }) : new Response('not found', { status: 404 });
    }

    const key = `${method} ${u.pathname}`;
    const inj = injections.find((i) => i.match.test(key) && i.times !== 0);
    if (inj) { if (inj.times > 0) inj.times--; if (inj.networkError) { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; } return json(inj.status, inj.body || { message: 'injected' }, inj.headers); }

    if (init.headers?.Authorization !== `Bearer ${cfg.token}`) return err(401, 'Bad credentials');
    const body = init.body ? JSON.parse(init.body) : {};
    let m;
    if (method === 'GET' && u.pathname === '/user') return json(200, { login: cfg.login }, cfg.scopes ? { 'x-oauth-scopes': cfg.scopes.join(', ') } : {});
    if (method === 'POST' && u.pathname === '/user/repos') {
      if (cfg.scopes && !cfg.scopes.includes('repo')) return err(403, 'Resource not accessible by personal access token');
      if (repos.has(body.name)) return err(422, 'name already exists on this account');
      repos.set(body.name, { name: body.name, private: body.private !== false, files: new Map(), pages: null, commits: 0, appearLeft: cfg.appearAfter, description: body.description });
      return json(201, { name: body.name, owner: { login: cfg.login } });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname))) {
      const [, owner, name, rest = ''] = m, r = repos.get(name);
      if (owner !== cfg.login || !r) return err(404, 'Not Found');
      if (method === 'DELETE' && !rest) {
        if (cfg.scopes && !cfg.scopes.includes('delete_repo')) return err(403, 'Must have admin rights to Repository.');
        repos.delete(name); return json(204);
      }
      if (method === 'GET' && !rest) return json(200, { name, private: r.private, default_branch: 'main' });
      if (method === 'PATCH' && !rest) { if (typeof body.private === 'boolean') r.private = body.private; return json(200, { name, private: r.private }); }
      if (method === 'PUT' && rest.startsWith('/contents/')) {
        if (r.appearLeft > 0) { r.appearLeft--; return err(404, 'Not Found'); }
        const path = decodeURIComponent(rest.slice('/contents/'.length));
        r.files.set(path, Buffer.from(body.content || '', 'base64')); r.commits++;
        return json(201, { content: { path }, commit: { sha: `c${r.commits}` } });
      }
      if (method === 'POST' && rest === '/pages') {
        if (r.private) return err(422, 'Your current plan does not support GitHub Pages for this repository.');
        if (r.pages) return err(409, 'A GitHub Pages site already exists for this repository.');
        r.pages = { polls: 0, status: 'building' }; return json(201, { html_url: `https://${cfg.login}.github.io/${name}/` });
      }
      if (method === 'GET' && rest === '/pages/builds/latest') {
        if (!r.pages) return err(404, 'Not Found');
        if (cfg.pagesError) { r.pages.status = 'errored'; return json(200, { status: 'errored', error: { message: cfg.pagesError } }); }
        if (++r.pages.polls > cfg.buildPolls) r.pages.status = 'built';
        return json(200, { status: r.pages.status });
      }
      if (method === 'GET' && rest === '/pages') return r.pages ? json(200, { html_url: `https://${cfg.login}.github.io/${name}/`, status: r.pages.status }) : err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  return {
    cfg, repos, calls, fetch,
    inject: (match, spec) => injections.push({ times: -1, ...spec, match }),
    clearInjections: () => { injections.length = 0; },
    publicRepos: () => [...repos.values()].filter((r) => !r.private),
  };
}

module.exports = { createFakeGitHub };
