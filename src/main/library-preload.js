// Library window only. Gives the page nothing: no bridge, no Electron. Its one job is the two-finger swipe for back and forward, which Chromium keeps
// in Chrome and Electron does not have. It reads the page's wheel events from the preload's separate world.
(() => {
  const TRIGGER = 140, IDLE_MS = 160; // pixels of sideways travel for one swipe; a pause this long ends a gesture (and its momentum)
  let sumX = 0, sumY = 0, spent = false, idle = null;

  const scrollsSideways = (start) => {
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) return true;
    for (let el = start; el && el !== root && el.nodeType === 1; el = el.parentElement) {
      const { overflowX } = getComputedStyle(el);
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) return true;
    }
    return false;
  };

  window.addEventListener('wheel', (e) => {
    clearTimeout(idle);
    idle = setTimeout(() => { sumX = 0; sumY = 0; spent = false; }, IDLE_MS);
    if (spent) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || scrollsSideways(e.target)) { spent = true; return; } // the page or a scroller owns this one
    if (Math.sign(e.deltaX) && Math.sign(e.deltaX) === -Math.sign(sumX)) sumX = 0; // changed direction
    sumX += e.deltaX; sumY += Math.abs(e.deltaY);
    if (sumY > Math.abs(sumX)) { spent = true; return; } // a vertical scroll that drifted sideways
    if (Math.abs(sumX) < TRIGGER) return;
    spent = true;
    if (sumX < 0) history.back(); else history.forward(); // fingers moving right scroll left: that is "back", as in Safari and Chrome
  }, { passive: true });
})();
