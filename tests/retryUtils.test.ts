import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  truncate,
  isRetryableStatus,
  backoffMs,
  withTimeout,
} from '../src/utils/retryUtils';

test('truncate leaves short strings unchanged', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('', 5), '');
});

test('truncate cuts long strings and appends ellipsis', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcde…');
});

test('isRetryableStatus marks 429 + 5xx', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(599), true);
});

test('isRetryableStatus rejects 2xx, 3xx, other 4xx', () => {
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(301), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
});

test('backoffMs scales exponentially within jitter range', () => {
  const base = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const lo = base * Math.pow(2, attempt) * 0.75;
    const hi = base * Math.pow(2, attempt) * 1.25;
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(attempt, base);
      assert.ok(v >= Math.floor(lo) && v <= Math.ceil(hi),
        `backoff[${attempt}] = ${v} outside [${lo}, ${hi}]`);
    }
  }
});

test('withTimeout resolves when promise settles in time', async () => {
  const v = await withTimeout(Promise.resolve(42), 1000);
  assert.equal(v, 42);
});

test('withTimeout rejects when promise never settles', async () => {
  const never = new Promise<number>(() => {/* hang */});
  await assert.rejects(() => withTimeout(never, 50), /timed out/i);
});

test('withTimeout propagates underlying rejection', async () => {
  const fail = Promise.reject(new Error('boom'));
  await assert.rejects(() => withTimeout(fail, 1000), /boom/);
});
