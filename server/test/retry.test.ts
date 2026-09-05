import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTransient, withRetry } from '../src/circle/retry.ts';

function networkError(code: string): Error {
  return Object.assign(new Error(`request failed: ${code}`), { code });
}

function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

describe('isTransient', () => {
  it('treats network failures as worth retrying', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT']) {
      assert.equal(isTransient(networkError(code)), true, code);
    }
  });

  it('sees through the wrapper an HTTP client puts around a DNS failure', () => {
    const wrapped = Object.assign(new Error('connect failed'), { cause: networkError('ENOTFOUND') });
    assert.equal(isTransient(wrapped), true);
  });

  it('retries rate limits and server errors', () => {
    assert.equal(isTransient(httpError(429)), true);
    assert.equal(isTransient(httpError(503)), true);
  });

  it('does not retry a request Circle rejected', () => {
    // Repeating these would fail identically and bury the real cause.
    assert.equal(isTransient(httpError(400)), false);
    assert.equal(isTransient(httpError(401)), false);
    assert.equal(isTransient(httpError(404)), false);
    assert.equal(isTransient(new Error('insufficient funds')), false);
  });
});

describe('withRetry', () => {
  it('returns the value once a transient failure clears', async () => {
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw networkError('ENOTFOUND');
        return 'ok';
      },
      { baseDelayMs: 1 },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('gives up after the attempt budget and reports the last failure', async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw networkError('ECONNRESET');
          },
          { attempts: 3, baseDelayMs: 1 },
        ),
      /ECONNRESET/,
    );

    assert.equal(calls, 3);
  });

  it('fails immediately on a rejected request rather than hammering the API', async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw httpError(400);
          },
          { attempts: 5, baseDelayMs: 1 },
        ),
      /http 400/,
    );

    assert.equal(calls, 1, 'a rejected request must not be repeated');
  });

  it('backs off further with each attempt', async () => {
    const delays: number[] = [];

    await assert.rejects(() =>
      withRetry(
        async () => {
          throw networkError('ETIMEDOUT');
        },
        {
          attempts: 4,
          baseDelayMs: 1,
          onRetry: (_attempt, _error, delayMs) => delays.push(delayMs),
        },
      ),
    );

    assert.deepEqual(delays, [1, 2, 4]);
  });
});
