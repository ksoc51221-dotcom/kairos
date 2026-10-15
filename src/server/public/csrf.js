// B5: adds the per-launch CSRF token to every same-origin write made by the owner's pages.
// The token comes from /api/me, which only answers the owner on this machine; other websites cannot read that response.
(() => {
  const orig = window.fetch.bind(window); let pending = null;
  const token = () => (pending = pending || orig('/api/me').then((r) => r.json()).then((m) => m.csrf || '').catch(() => ''));
  window.spoolToken = token; // for XHR uploads: xhr.setRequestHeader('x-spool-csrf', await spoolToken())
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    let same = true; try { same = new URL(url, location.href).origin === location.origin; } catch {}
    if (same && method !== 'GET' && method !== 'HEAD') {
      const t = await token();
      if (t) { const h = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined)); h.set('x-spool-csrf', t); init = { ...init, headers: h }; }
    }
    return orig(input, init);
  };
})();
