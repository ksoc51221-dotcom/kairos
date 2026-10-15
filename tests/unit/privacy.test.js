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
