// The bubble page script must run to the end: it once threw on load (a `let` used before its declaration), and the camera never opened.
const test = require('node:test'), assert = require('node:assert'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const C = require('../../src/shared/constants');

// Runs bubble.js against stand-ins for the page and returns the handlers it registered. `wait` replaces setTimeout so retries do not slow the test.
function boot(getUserMedia = async () => ({ getTracks: () => [] }), log = console, wait = (f) => f()) {
  const handlers = {};
  const el =() => new Proxy(function () {}, {
    get: (t, k) => (k === 'style' ? new Proxy({ setProperty() {} }, { set: () => true }) : k === 'classList' ? { toggle() {}, add() {}, remove() {} } : k === 'dataset' ? {} : k === 'value' ? '260' : t[k] ?? (typeof k === 'string' && /^(querySelectorAll|getTracks)$/.test(k) ? () => [] : undefined)),
    set: () => true, apply: () => undefined,
  });
  const ctx = {
    window: { SPOOL: C, KairosIcons: { fill() {} }, KairosGestures: require('../../src/shared/gestures') },
    location: { href: 'file:///app/src/renderer/bubble/index.html' }, URL,
    document: { getElementById: el, querySelectorAll: () => [], createElement: el, body: { classList: { toggle() {} } } },
    spool: { on: (n, f) => { handlers[n] = f; }, send() {} },
    navigator: { mediaDevices: { getUserMedia } },
    addEventListener() {}, console: log, setTimeout: wait,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/bubble/bubble.js'), 'utf8'), ctx);
  return handlers;
}

test('bubble.js loads without throwing and registers its handlers', () => {
  const handlers = boot();
  assert.ok(handlers['bubble:init'] && handlers['bubble:style'] && handlers['bubble:hover'], 'handlers registered: ' + Object.keys(handlers));
  assert.ok(handlers['gesture:load'] && handlers['gesture:run'] && handlers['gesture:toast'], 'gesture handlers registered: ' + Object.keys(handlers));
});

test('bubble:init tries a camera that is missing for a moment up to three times, names the error, and does not retry a refusal', async () => {
  const attempt = async (errors, id = 'cam-1') => {
    const tried = [], logged = [];
    const h = boot(async (c) => { tried.push(c.video.deviceId); const n = errors[tried.length - 1]; if (n) throw Object.assign(new Error('nope'), { name: n }); return { getTracks: () => [] }; }, { error: (m) => logged.push(m), log() {} });
    await h['bubble:init']({ camId: id });
    return { tries: tried.length, exact: tried.every((d) => d && d.exact === id), logged };
  };
  const a = await attempt(['OverconstrainedError', 'NotReadableError']);
  assert.equal(a.tries, 3, 'two failures, the third try opens it');
  assert.ok(a.exact, 'always the camera that was asked for');
  assert.match(a.logged[0], /try 1\): OverconstrainedError: nope/, 'the log names the error');
  assert.equal((await attempt(['NotFoundError', 'NotFoundError', 'NotFoundError'])).tries, 3, 'gives up after three');
  assert.equal((await attempt(['NotAllowedError'])).tries, 1, 'a refusal (permission) is not retried');
  assert.equal((await attempt([])).tries, 1, 'a camera that opens is opened once');
});
