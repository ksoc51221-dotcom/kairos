// Inline SVG icons in one stroke style (24x24 grid, 2px round strokes), drawn for Kairos. Loaded by renderer windows as window.KairosIcons.
//   KairosIcons.svg('home')        -> '<svg class="i" ...>...</svg>'
//   KairosIcons.fill(rootElement)  -> replaces every [data-icon="name"] with its svg
(function (root) {
  const P = {
    home: '<path d="M3.5 11 12 3.5 20.5 11"/><path d="M5.5 9.5V20h5v-6h3v6h5V9.5"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
    'video-off': '<path d="m15.5 10.5 6-3.5v10l-6-3.5"/><path d="M7 6H5a2.5 2.5 0 0 0-2.5 2.5v7A2.5 2.5 0 0 0 5 18h8.5a2.5 2.5 0 0 0 2-1"/><path d="M13.5 6a2 2 0 0 1 2 2v1"/><path d="m3 3 18 18"/>',
    camera: '<path d="M4 8h3l1.6-2.5h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.6"/>',
    x: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
    window: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 3.5v17M3.5 12h17"/>',
    monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.5 20.5h7M12 16.5v4"/>',
    crop: '<path d="M6 2.5v14a2 2 0 0 0 2 2h13.5"/><path d="M18 21.5V8a2 2 0 0 0-2-2H2.5"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    'mic-off': '<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.9-.8"/><path d="M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3"/><path d="m3 3 18 18"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.6-.3-1-.6-1.4-.3-.4-.4-.8-.4-1.2 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7.3" r="1"/><circle cx="15" cy="7.3" r="1"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
    more: '<circle cx="5" cy="12" r="1.4" class="f"/><circle cx="12" cy="12" r="1.4" class="f"/><circle cx="19" cy="12" r="1.4" class="f"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" class="f"/>',
    pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1" class="f"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" class="f"/>',
    play: '<path d="M7.5 5v14l11-7z" class="f"/>',
    restart: '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3.5 4v5h5"/>',
    skip: '<path d="M5.5 5.5 14 12l-8.5 6.5z"/><path d="M18.5 5v14"/>',
    rewind: '<path d="M11 17 6 12l5-5M18 17l-5-5 5-5"/>',
    pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="m14 6 3 3"/>',
    target: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
    chevron: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    circle: '<circle cx="12" cy="12" r="8.5"/>',
    squircle: '<rect x="3.5" y="3.5" width="17" height="17" rx="6"/>',
    portrait: '<rect x="6" y="3" width="12" height="18" rx="2.5"/>',
    laptop: '<rect x="5" y="5.5" width="14" height="10" rx="1.8"/><path d="M2.5 19h19"/>',
    'window-bar': '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="7" cy="9" r=".9" class="f"/><circle cx="9.8" cy="9" r=".9" class="f"/>',
    dashed: '<rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke-dasharray="3.2 3"/>',
    'portrait-cam': '<rect x="3.5" y="4" width="17" height="16" rx="3"/><circle cx="12" cy="10.5" r="2.4"/><path d="M7.5 17c.8-2.2 2.6-3.2 4.5-3.2s3.7 1 4.5 3.2"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    'lock-open': '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.9-1"/>',
    agent: '<path d="M4.5 6.5l5.6 13 2-5.4 5.4-2z"/><path d="M18.5 2.5v4.5M16.25 4.75h4.5"/>',
    power: '<path d="M12 3.5v8"/><path d="M7 6.8a7.5 7.5 0 1 0 10 0"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/>',
    'chevron-right': '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
    'chevron-left': '<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>',
    'chevron-up': '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
    kairos: '<polygon points="12.00,3.20 16.90,3.20 14.90,8.40 10.30,8.40" class="f" stroke="none"/><polygon points="19.62,7.60 22.07,11.84 16.57,12.71 14.27,8.73" class="f" opacity=".62" stroke="none"/><polygon points="19.62,16.40 17.17,20.64 13.67,16.31 15.97,12.33" class="f" stroke="none"/><polygon points="12.00,20.80 7.10,20.80 9.10,15.60 13.70,15.60" class="f" opacity=".62" stroke="none"/><polygon points="4.38,16.40 1.93,12.16 7.43,11.29 9.73,15.27" class="f" stroke="none"/><polygon points="4.38,7.60 6.83,3.36 10.33,7.69 8.03,11.67" class="f" opacity=".62" stroke="none"/>', // the logo's pinwheel: six blades, alternate ones lighter
    landscape: '<rect x="3" y="6" width="18" height="12" rx="2.5"/>',
  };
  const svg = (name, extra = '') => `<svg class="i ${extra}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  const fill = (el = document) => el.querySelectorAll('[data-icon]').forEach((n) => { n.innerHTML = svg(n.dataset.icon); n.removeAttribute('data-icon'); });
  root.KairosIcons = { svg, fill, names: Object.keys(P) };
})(typeof self !== 'undefined' ? self : this);
