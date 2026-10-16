// The Privacy Guard's deterministic rules: what counts as a secret on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { regexFindings } = require('../../src/agents/privacy');

// Build an OCR line the way ocr.js does: one box per word.
const line = (text) => ({ text, words: text.split(' ').map((w, i) => ({ text: w, x0: i * 0.1, y0: 0.1, x1: i * 0.1 + 0.08, y1: 0.12 })) });
const found = (text) => regexFindings(line(text)).map((f) => [f.type, f.value]);
const types = (text) => regexFindings(line(text)).map((f) => f.type);

test('emails', () => {
  assert.deepEqual(found('contact jane.doe+work@example.co.uk today'), [['email', 'jane.doe+work@example.co.uk']]);
  assert.deepEqual(types('no address here'), []);
});

test('api keys and tokens', () => {
  assert.ok(types('OPENAI_API_KEY=sk-proj12345678abcd').includes('api key') || types('sk-proj12345678abcd').includes('api key'));
  assert.deepEqual(found('token ghp_abcdefgh12345678'), [['api key', 'ghp_abcdefgh12345678']]);
  assert.deepEqual(found('aws AKIAIOSFODNN7EXAMPLE'), [['api key', 'AKIAIOSFODNN7EXAMPLE']]);
  assert.deepEqual(types('jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4'), ['token']);
});

test('credit cards need a valid Luhn checksum', () => {
  assert.deepEqual(types('card 4111 1111 1111 1111 exp'), ['credit card']);
  assert.deepEqual(types('card 4111111111111111'), ['credit card']);
  assert.deepEqual(types('order 1234 5678 9012 3456 shipped'), [], 'fails Luhn, so it is not flagged');
});

test('ssn, phone and password lines', () => {
  assert.deepEqual(found('ssn 123-45-6789 on file'), [['ssn', '123-45-6789']]);
  assert.ok(types('call (415) 555-2671 now').includes('phone'));
  assert.ok(types('call +1 415-555-2671 now').includes('phone'));
  assert.deepEqual(found('password: hunter2'), [['password', 'hunter2']]);
  assert.deepEqual(found('PASSWD = correcthorse'), [['password', 'correcthorse']]);
});

test('long mixed strings look like secrets, long words do not', () => {
  assert.deepEqual(types('x9fK2mQ7pL4vB8nR3tY6wZ1cD5aG0hJ'), ['secret']);
  assert.deepEqual(types('internationalizationconfigurationmanagement'), [], 'letters only');
});

test('ordinary screen text is left alone', () => {
  for (const t of ['Settings Billing Team Members', 'Version 1.2.3 released 2026-10-14', 'Click Save to continue', 'Total: $1,299.00', 'meeting at 10:30 in room 204']) assert.deepEqual(types(t), [], t);
});

test('the box covers exactly the words the secret spans', () => {
  const f = regexFindings(line('send to jane@example.com please'))[0];
  assert.equal(f.type, 'email');
  assert.ok(f.box.x0 === 0.2 && Math.abs(f.box.x1 - 0.28) < 1e-9, JSON.stringify(f.box));
});

// OCR does not read a key the way it was typed (Phase 5: the fake key was missed once in a real run). The rules also run on a normalised and an
// O/0, l/1-folded view of each line, and a hit is mapped back to the ORIGINAL characters and word boxes.
test('OCR variants of an API key are still found, and the box covers the whole key', () => {
  for (const t of ['Deploy key: sk-live-9f8e7d6c5b4a3210abcd', 'Deploy key: sk- live -9f8e7d6c5b4a3210abcd', 'Deploy key: sk—live—9f8e7d6c5b4a3210abcd', 'Deploy key: sk–live-9f8e7d6c5b4a3210abcd',
    'Deploy key: sk-Iive-9f8e7d6c5b4a32l0abcd', 'Deploy key: sk_live_9f8eO7d6c5b4a32l0abcd']) {
    const f = regexFindings(line(t)).find((x) => x.type === 'api key'); assert.ok(f, t);
    assert.equal(f.value, t.slice(t.indexOf('sk')), `the value is the original text: ${t}`);
    assert.ok(f.box.x1 >= line(t).words.at(-1).x1 - 1e-9, `box reaches the last word: ${t}`);
  }
  // split into words by the OCR: the box is the union of all the words the key touches
  const f = regexFindings(line('key: sk- live -9f8e7d6c5b4a3210abcd')).find((x) => x.type === 'api key');
  assert.ok(Math.abs(f.box.x0 - 0.1) < 1e-9 && Math.abs(f.box.x1 - 0.38) < 1e-9, JSON.stringify(f.box));
});
test('OCR digit look-alikes in cards and phones', () => {
  assert.deepEqual(types('card 4111 1111 1111 l111'), ['credit card']);
  assert.deepEqual(types('card 4111 1111 1111 lll2'), [], 'not a valid number even after folding');
  assert.deepEqual(types('call (5O5) 555-0100'), ['phone']);
});
test('the extra views do not turn ordinary text into secrets', () => {
  for (const t of ['state - of - the - art design', 'Next review on Friday afternoon', 'internationalization-and-localization-guidelines', 'Hello Olivia, all lines look Ill-lit', 'File - Edit - View']) assert.deepEqual(found(t), [], t);
});
