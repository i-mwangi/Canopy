import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { idempotencyUuid } from '../src/circle/client.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('idempotencyUuid', () => {
  it('produces a valid version 5 UUID', () => {
    assert.match(idempotencyUuid('settle:abc:payout'), UUID);
    assert.match(idempotencyUuid('seed:renter-1'), UUID);
  });

  it('is stable, so a retry stays idempotent', () => {
    assert.equal(idempotencyUuid('settle:abc:payout'), idempotencyUuid('settle:abc:payout'));
  });

  it('separates the legs of one settlement', () => {
    assert.notEqual(idempotencyUuid('settle:abc:payout'), idempotencyUuid('settle:abc:fee'));
  });
});
