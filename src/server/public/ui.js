// Icons and small helpers shared by the web pages. Inline SVGs drawn for Kairos in one stroke style (24x24 grid, 1.75 px round strokes, set in app.css),
// in the spirit of the MIT-licensed Lucide set; no icon library is a dependency and nothing is fetched. Use: UI.i('share') -> '<svg class="i">…</svg>'.
// A name with no icon renders an empty svg, so add new icons here (the foundation file), not inline in a page.
(() => {
  const P = {
    logo: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.4" class="f"/><path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
    more: '<circle cx="5" cy="12" r="1.5" class="f"/><circle cx="12" cy="12" r="1.5" class="f"/><circle cx="19" cy="12" r="1.5" class="f"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8M12 17h.01"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
    sidebar: '<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M9.5 4v16M15 9.5 12.5 12l2.5 2.5"/>',
    scissors: '<circle cx="6" cy="6.5" r="2.6"/><circle cx="6" cy="17.5" r="2.6"/><path d="M8.3 7.9 20 17M8.3 16.1 20 7"/>',
    wand: '<path d="m4 20 11-11M14.5 5l.8-1.8.8 1.8 1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8zM18.5 12l.6-1.4.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6z"/>',
    sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18l-1.8-5.4L4.5 10.8 10.2 9z"/>',
    silence: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M17 3v4M15 5h4M12 8v8M9 10v4M15 10v4"/>',
    filler: '<path d="M13.5 6.5 19 12l-4.5 4.5L9 11z"/><path d="m4 20 5-5M5 6l.7-1.6L6.4 6 8 6.7 6.4 7.4 5.7 9 5 7.4 3.4 6.7z"/>',
    captions: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M16.5 10.2a2.2 2.2 0 1 0 0 3.6"/>',
    transform: '<path d="M6.5 5.5 8 3l1.5 2.5 2.5 1.5-2.5 1.5L8 11 6.5 8.5 4 7z"/><path d="M13 13.5 20 20M16.5 10.5l1.5 1.5"/>',
    doc: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 9h6M9 12.5h6M9 16h3.5"/>',
    comment: '<path d="M4.5 5.5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H12l-4.5 3.5V17h-3a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"/><path d="M8 9.5h8M8 13h5"/>',
    smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c1 1.5 2.2 2.2 3.5 2.2s2.5-.7 3.5-2.2M9.2 9.8h.01M14.8 9.8h.01"/>',
    'smile-plus': '<path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5"/><path d="M8.5 14c1 1.5 2.2 2.2 3.5 2.2s2.5-.7 3.5-2.2M9.2 9.8h.01M14.8 9.8h.01M18 3v5M15.5 5.5h5"/>',
    bookmark: '<path d="M6.5 4.5h11v16l-5.5-4-5.5 4z"/>',
    'bookmark-on': '<path d="M6.5 4.5h11v16l-5.5-4-5.5 4z" class="f"/>',
    play: '<path d="M8 5v14l11-7z" class="f"/>',
    pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" class="f"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    home: '<path d="M3.5 11 12 3.5 20.5 11"/><path d="M5.5 9.5V20h5v-6h3v6h5V9.5"/>',
    foryou: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.2 18.2c1.4-2.3 3.4-3.2 5.8-3.2s4.4.9 5.8 3.2"/>',
    library: '<rect x="4" y="3.5" width="16" height="4.5" rx="1.5"/><path d="M5.5 8v10.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V8"/><path d="M10 12.5h4"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3.5v3M15.5 3.5v3"/>',
    playlist: '<rect x="3.5" y="8" width="13" height="11" rx="2.5"/><path d="M7 5h10M9 2.5h9a2 2 0 0 1 2 2V15M8.5 11.5v4.2l3.6-2.1z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.3 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.6a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.6-3 3-4.6 6-4.6s5.4 1.6 6 4.6M16 5.6a3.2 3.2 0 0 1 0 5.8M18 15.2c1.7.6 2.7 2 3 4.3"/>',
    'user-plus': '<circle cx="9.5" cy="8.5" r="3.3"/><path d="M3.5 19.5c.6-3 3-4.6 6-4.6s5.4 1.6 6 4.6M18.5 8v6M15.5 11h6"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    right: '<path d="m9.5 6 6 6-6 6"/>',
    left: '<path d="m14.5 6-6 6 6 6"/>',
    up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2.5l8 4.5v-15L7.5 9H5a1 1 0 0 0-1 1z"/><path d="M19 9.5a4 4 0 0 1 0 5"/>',
    embed: '<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 5.5l-3 13"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    download: '<path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 19.5h14"/>',
    upload: '<path d="M12 16V5M7.5 9 12 4.5 16.5 9M5 19.5h14"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5"/>',
    pencil: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="m14 6 3 3"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-4.5-4.5L7 19.5"/>',
    undo: '<path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-3"/>',
    split: '<path d="M12 3.5v17"/><path d="M7.5 8 3.5 12l4 4M16.5 8l4 4-4 4"/>',
    arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
    box: '<rect x="4" y="5.5" width="16" height="13" rx="2.5"/>',
    blur: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>',
    text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17.5 14v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2H10"/>',
    chart: '<path d="M4 20V4M4 20h16M8 16v-4M12.5 16V8M17 16v-6"/>',
    board: '<rect x="3.5" y="4" width="17" height="13" rx="2.5"/><path d="M8 20.5h8M12 17v3.5"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4 8 8 5.5L20 8"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
    // ---- added with the workstation redesign ----
    kairos: '<polygon points="12.00,3.20 16.90,3.20 14.90,8.40 10.30,8.40" class="f" stroke="none"/><polygon points="19.62,7.60 22.07,11.84 16.57,12.71 14.27,8.73" class="f" opacity=".62" stroke="none"/><polygon points="19.62,16.40 17.17,20.64 13.67,16.31 15.97,12.33" class="f" stroke="none"/><polygon points="12.00,20.80 7.10,20.80 9.10,15.60 13.70,15.60" class="f" opacity=".62" stroke="none"/><polygon points="4.38,16.40 1.93,12.16 7.43,11.29 9.73,15.27" class="f" stroke="none"/><polygon points="4.38,7.60 6.83,3.36 10.33,7.69 8.03,11.67" class="f" opacity=".62" stroke="none"/>', // the brand mark: six-blade pinwheel, alternate blades lighter
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8 5.4-5.6"/>',
    'x-circle': '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    'help-circle': '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8M12 17h.01"/>',
    'alert-triangle': '<path d="M10.3 4.7 2.9 17.6A2 2 0 0 0 4.6 20.6h14.8a2 2 0 0 0 1.7-3L13.7 4.7a2 2 0 0 0-3.4 0z"/><path d="M12 10v4M12 17.3h.01"/>',
    lightbulb: '<path d="M8.6 14.3C7 13 6 11.3 6 9.3a6 6 0 0 1 12 0c0 2-1 3.7-2.6 5-.6.5-.9 1.2-.9 2.2h-5c0-1-.3-1.7-.9-2.2z"/><path d="M9.5 19h5M10.5 21.5h3"/>',
    flag: '<path d="M5.5 21V4.5"/><path d="M5.5 5h11.5l-2 4 2 4H5.5"/>',
    send: '<path d="m21 3-6.5 18-3.8-8.2L2.5 9z"/><path d="M21 3 10.7 12.8"/>',
    reply: '<path d="M9.5 6 4 11.5 9.5 17"/><path d="M4 11.5h9a6 6 0 0 1 6 6V19"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6z"/>',
    'shield-check': '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12 2.4 2.4 4.2-4.6"/>',
    volume: '<path d="M4 9.5v5h3.5l4.5 3.5v-12L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.2 6.5a8 8 0 0 1 0 11"/>',
    'volume-off': '<path d="M4 9.5v5h3.5l4.5 3.5v-12L7.5 9.5z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    cc: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.2 10.4a2.2 2.2 0 1 0 0 3.2M16.2 10.4a2.2 2.2 0 1 0 0 3.2"/>',
    pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="6.5" height="4.5" rx="1" class="f"/>',
    fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    bolt: '<path d="M13 3 5 13.5h6L10 21l9-11h-6.2z"/>',
    laptop: '<rect x="5" y="5.5" width="14" height="10" rx="1.8"/><path d="M2.5 19h19"/>',
    share: '<circle cx="6" cy="12" r="2.4"/><circle cx="17.5" cy="6" r="2.4"/><circle cx="17.5" cy="18" r="2.4"/><path d="m8.2 10.9 7.1-3.8M8.2 13.1l7.1 3.8"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h3.5"/>',
    record: '<circle cx="12" cy="12" r="6" class="f"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" class="f"/>',
    heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
    'thumb-up': '<path d="M8 10.5 11.4 4.2a1.9 1.9 0 0 1 3.5 1.4L14.2 9h4.8a2 2 0 0 1 2 2.5l-1.6 6.6A2.5 2.5 0 0 1 16.9 20H8z"/><path d="M8 10.5H5.5A1.5 1.5 0 0 0 4 12v6.5A1.5 1.5 0 0 0 5.5 20H8"/>',
    star: '<path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
    minus: '<path d="M5 12h14"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" class="f"/>',
    cursor: '<path d="M5 4.5 10.6 20l2.2-6.4 6.4-2.2z"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  };
  // Aliases for the names a design or another tool might use; they point at the same drawing.
  Object.assign(P, { edit: P.pencil, settings: P.gear, notifications: P.bell, zap: P.bolt, visibility: P.eye });
  const i = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const initials = (name) => (String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  // Fills every [data-i="name"] element with its icon.
  const fill = (root = document) => root.querySelectorAll('[data-i]').forEach((n) => { n.insertAdjacentHTML('afterbegin', i(n.dataset.i)); n.removeAttribute('data-i'); });
  // "7 minutes ago" style times, as shown under the title and on the cards
  const ago = (t) => { const s = (Date.now() - t) / 1000; if (s < 45) return 'just now'; const u = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2592000, 'month'], [31536000, 'year']]; let k = 0; while (k < u.length - 1 && s >= u[k + 1][0]) k++; const n = Math.floor(s / (k ? u[k][0] : 60)); return `${n} ${u[k][1]}${n === 1 ? '' : 's'} ago`; };
  const dur = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} sec` : `${Math.round(s / 60)} min`);
  // The owner's accent colour from Settings replaces --accent. The emerald default and the two earlier defaults (purple, then blue) count as "not chosen":
  // the stylesheet's own palette stays in charge and any earlier override is cleared.
  const DEFAULT_ACCENTS = ['#047857', '#7b5cf0', '#3267d4'];
  const ACCENT_VARS = ['--accent', '--accent-d', '--accent-soft', '--tile', '--accent-ink'];
  // Dark text on a light custom accent (white text on yellow is unreadable). Relative luminance per WCAG.
  const lum = (hex) => { const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const brand = (b = {}) => {
    const root = document.documentElement.style, a = (b.accent || '').toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(a) && !DEFAULT_ACCENTS.includes(a)) {
      root.setProperty('--accent', a); root.setProperty('--accent-d', `color-mix(in srgb, ${a}, black 16%)`);
      root.setProperty('--accent-soft', `color-mix(in srgb, ${a}, white 91%)`); root.setProperty('--tile', `color-mix(in srgb, ${a}, white 84%)`);
      root.setProperty('--accent-ink', lum(a) > 0.18 ? '#0f172a' : '#ffffff');
    } else ACCENT_VARS.forEach((v) => root.removeProperty(v));
  };
  // The brand mark: the Kairos pinwheel on an emerald square, or the owner's uploaded logo.
  const logo = (b = {}) => (b.logo ? '<span class="logo" style="background:url(/branding/logo.png) center/cover"></span>' : `<span class="logo">${i('kairos')}</span>`);
  window.UI = { brand, logo, i, P, esc, initials, fill, ago, dur };
})();
