// Screenshots: capture the display → pick an area → annotate → save as an image in the library.
// The area picker is shared with "Custom area" recording; its result arrives through areaResult() (wired in ipc.js).
const { desktopCapturer, screen, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('../store');
const config = require('./config');
const permissions = require('./permissions');
const win = require('./windows');
const { W, alive } = win;

let pending = null;
function pickArea({ display, image, mode }) {
  return new Promise((resolve) => {
    pending?.(null); // a second picker replaces the first
    win.holdOverlay('area');
    const w = win.createArea(display.bounds);
    const done = (r) => { pending = null; win.releaseOverlay('area'); if (alive(w)) w.close(); resolve(r); };
    pending = done;
    w.webContents.once('did-finish-load', () => { w.webContents.send('area:init', { mode, image }); w.show(); w.focus(); });
  });
}
const areaResult = (r) => pending?.(r);

// "Custom area" recording: returns the chosen crop (fractions of the display) and the display's source id, or null if cancelled
async function pickCrop(sourceId) {
  const display = win.displayFor(sourceId); win.hideLauncher();
  const crop = await pickArea({ display, mode: 'record' });
  return crop ? { crop, sourceId: sourceId?.startsWith('screen:') ? sourceId : `screen:${display.id}:0` } : null;
}

async function start() {
  if (require('./session').isActive()) return;
  win.hideLauncher();
  if (process.platform === 'darwin' && permissions.status().screen !== 'granted') { await permissions.ensure({ cam: false, screen: true }); return; }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  await new Promise((r) => setTimeout(r, 120));
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = srcs.find((s) => s.id.startsWith(`screen:${d.id}:`)) || srcs[0], full = src.thumbnail;
  const crop = await pickArea({ display: d, image: full.toDataURL(), mode: 'screenshot' });
  if (!crop) return;
  const fs_ = full.getSize();
  const img = full.crop({ x: Math.round(crop.x * fs_.width), y: Math.round(crop.y * fs_.height), width: Math.round(crop.w * fs_.width), height: Math.round(crop.h * fs_.height) });
  openAnnotator(img, d);
}

function openAnnotator(img, d) {
  const w = win.createAnnotator(d);
  w.webContents.once('did-finish-load', () => { w.webContents.send('annotate:init', { image: img.toDataURL() }); w.show(); w.focus(); });
}
const cancelAnnotate = () => { if (alive(W.annotate)) W.annotate.close(); };
const copyAnnotated = (url) => clipboard.writeImage(nativeImage.createFromDataURL(url));
function saveAnnotated(url) {
  const img = nativeImage.createFromDataURL(url), sz = img.getSize();
  const v = store.create({ type: 'image', title: `Screenshot ${new Date().toLocaleString()}`, titleAuto: false, status: 'ready', stage: 'done', shareable: true, // a screenshot is a PNG the owner annotated himself: no Privacy Guard pass for stills yet
 width: sz.width, height: sz.height });
  fs.writeFileSync(path.join(store.videoDir(v.id), 'image.png'), img.toPNG());
  fs.writeFileSync(path.join(store.videoDir(v.id), 'thumb.jpg'), img.resize({ width: 480 }).toJPEG(80));
  clipboard.writeText(config.origin(`/v/${v.id}`));
  cancelAnnotate();
  shell.openExternal(config.ownerOrigin(`/v/${v.id}`));
}

module.exports = { start, pickArea, pickCrop, areaResult, openAnnotator, cancelAnnotate, copyAnnotated, saveAnnotated };
