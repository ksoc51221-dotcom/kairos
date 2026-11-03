// The Kairos stroke icons (24x24 grid, 1.5 px round strokes) used by the extension: the same drawing style as src/shared/icons.js.
//   KairosIcons.svg('power') -> '<svg class="i" ...>...</svg>'
(function (root) {
  const P = {
    power: '<path d="M12 3.5v8"/><path d="M7 6.8a7.5 7.5 0 1 0 10 0"/>',
    person: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.2 18.2c1-2.4 3.2-3.7 5.8-3.7s4.8 1.3 5.8 3.7"/>',
    monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.5 20.5h7M12 16.5v4"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" class="f"/>',
    pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1" class="f"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" class="f"/>',
    play: '<path d="M7.5 5v14l11-7z" class="f"/>',
    x: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
    'eye-off': '<path d="M3 12s3.5-6 9-6c1.4 0 2.7.4 3.8 1M21 12s-3.5 6-9 6c-1.4 0-2.7-.4-3.8-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    'mic-off': '<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.9-.8"/><path d="M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3"/><path d="m3 3 18 18"/>',
    library: '<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M3.5 9h17M9 4v5"/>',
    more: '<circle cx="5.5" cy="12" r="1.4" class="f"/><circle cx="12" cy="12" r="1.4" class="f"/><circle cx="18.5" cy="12" r="1.4" class="f"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    edit: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="m14 6 3 3"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18.5v-9A1.5 1.5 0 0 1 6.5 8H11"/>',
    shield: '<path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15 10.5"/>',
    film: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="m10 9.5 4.5 2.5-4.5 2.5z"/>',
    kairos: '<polygon points="12.00,3.20 16.90,3.20 14.90,8.40 10.30,8.40" class="f" stroke="none"/><polygon points="19.62,7.60 22.07,11.84 16.57,12.71 14.27,8.73" class="f" opacity=".62" stroke="none"/><polygon points="19.62,16.40 17.17,20.64 13.67,16.31 15.97,12.33" class="f" stroke="none"/><polygon points="12.00,20.80 7.10,20.80 9.10,15.60 13.70,15.60" class="f" opacity=".62" stroke="none"/><polygon points="4.38,16.40 1.93,12.16 7.43,11.29 9.73,15.27" class="f" stroke="none"/><polygon points="4.38,7.60 6.83,3.36 10.33,7.69 8.03,11.67" class="f" opacity=".62" stroke="none"/>',
  };
  const svg = (name, extra = '') => `<svg class="i ${extra}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  const fill = (el = document) => el.querySelectorAll('[data-icon]').forEach((n) => { n.innerHTML = svg(n.dataset.icon); n.removeAttribute('data-icon'); });
  root.KairosIcons = { svg, fill };
})(typeof self !== 'undefined' ? self : this);
