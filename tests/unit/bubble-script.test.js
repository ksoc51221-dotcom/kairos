// The bubble page script must run to the end: it once threw on load (a `let` used before its declaration), and the camera never opened.
const test = require('node:test'), assert = require('node:assert'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const C = require('../../src/shared/constants');

test('bubble.js loads without throwing and registers its handlers', () => {
  const handlers = {};
  const el = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'style' ? new Proxy({ setProperty() {} }, { set: () => true }) : k === 'classList' ? { toggle() {}, add() {}, remove() {} } : k === 'dataset' ? {} : k === 'value' ? '260' : t[k] ?? (typeof k === 'string' && /^(querySelectorAll|getTracks)$/.test(k) ? () => [] : undefined)),
    set: () => true, apply: () => undefined,
  });
  const ctx = {
    window: { SPOOL: C, KairosIcons: { fill() {} } },
    document: { getElementById: el, querySelectorAll: () => [], body: { classList: { toggle() {} } } },
    spool: { on: (n, f) => { handlers[n] = f; }, send() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    addEventListener() {}, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/bubble/bubble.js'), 'utf8'), ctx);
  assert.ok(handlers['bubble:init'] && handlers['bubble:style'] && handlers['bubble:hover'], 'handlers registered: ' + Object.keys(handlers));
});
