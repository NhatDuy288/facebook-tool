import test from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, message } from './errors.ts';

test('browser network access denial has a specific actionable message', () => {
  const code = errorCode(Error('page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://www.facebook.com/private'));
  assert.equal(code, 'NETWORK_ACCESS_DENIED');
  assert.match(message(code), /bị chặn/);
  assert.ok(!message(code).includes('/private'));
  assert.equal(errorCode(Error('unrecognized failure')), 'READ_FAILED');
});
