// redact() at unit level: keys never appear in output.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const loadRedact = async () => (await import('../src/http.js')).redact;

describe('redact', () => {
  test('removes every occurrence of each configured key', async () => {
    const redact = await loadRedact();
    const out = redact('first sk-live-12345 then sk-live-12345 and other-key-999', ['sk-live-12345', 'other-key-999']);
    assert.ok(!out.includes('sk-live-12345'));
    assert.ok(!out.includes('other-key-999'));
  });

  test('removes Bearer tokens even when the key is not in the configured list', async () => {
    const redact = await loadRedact();
    const out = redact('401 Unauthorized: Authorization: Bearer abc123SECRETtoken.xyz', []);
    assert.ok(!out.includes('abc123SECRETtoken'), out);
  });

  test('removes fal-style "Key id:secret" credentials', async () => {
    const redact = await loadRedact();
    const out = redact('Invalid credentials: Key 1234abcd-aaaa:ffeeddccbbaa99887766', []);
    assert.ok(!out.includes('ffeeddccbbaa99887766'), out);
  });

  test('removes Replicate-style r8_ tokens', async () => {
    const redact = await loadRedact();
    const out = redact('bad token r8_AbCdEfGh1234567890ZyXw in request', []);
    assert.ok(!out.includes('r8_AbCdEfGh1234567890ZyXw'), out);
  });

  test('treats keys literally, not as regular expressions', async () => {
    const redact = await loadRedact();
    const key = 'a+b.c$d(e)[f]*';
    const out = redact(`oops ${key} leaked, but aab-c stays`, [key]);
    assert.ok(!out.includes(key));
    assert.ok(out.includes('stays'));
  });

  test('leaves ordinary text unchanged and ignores empty keys', async () => {
    const redact = await loadRedact();
    const text = 'Insufficient credits: top up at example.com. Task 42 failed.';
    assert.equal(redact(text, ['', 'unrelated-key-0000']), text);
  });

  test('returns a string', async () => {
    const redact = await loadRedact();
    assert.equal(typeof redact('x', ['k']), 'string');
  });
});
