import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTransportEvidence, transportFromHeaders } from './read-diagnostics.ts';

const network = { match: 'matched', transferBytes: 1200, encodedBodyBytes: 900, decodedBodyBytes: 4000,
  workerStartMs: 0, deliveryType: 'other', requestToFirstByteMs: 700, downloadMs: 100, durationMs: 810 };
test('cache evidence separates local cache, service worker, network transfer and unavailable timings', () => {
  assert.equal(safeTransportEvidence({ resource: network })!.browserDelivery, 'network_transfer_observed');
  assert.equal(safeTransportEvidence({ resource: { ...network, transferBytes: 0 } })!.browserDelivery, 'local_cache_signal');
  assert.equal(safeTransportEvidence({ resource: { ...network, transferBytes: 0, workerStartMs: 12 } })!.browserDelivery, 'service_worker_observed');
  assert.equal(safeTransportEvidence({ resource: { ...network, transferBytes: 0, encodedBodyBytes: 0 } })!.browserDelivery, 'unknown');
  assert.equal(safeTransportEvidence({ resource: { ...network, match: 'ambiguous' } })!.browserDelivery, 'unknown');
  assert.equal(safeTransportEvidence({ resource: { ...network, workerStartMs: undefined } })!.browserDelivery, 'unknown');
  assert.equal(safeTransportEvidence({})!.browserDelivery, 'unknown');
});

test('safe cache headers keep only bounded evidence and never imply MISS means fresh origin data', () => {
  const result = transportFromHeaders({ date: 'Thu, 19 Nov 2026 03:00:19 GMT', age: '12',
    expires: 'Thu, 19 Nov 2026 03:00:25 GMT', 'cache-control': 'private, no-store, max-age="60", secret-directive=secret-token',
    'x-cache': 'MISS from secret-host, HIT from secret-host', 'cf-cache-status': 'HIT',
    'set-cookie': 'secret-cookie', authorization: 'secret-token' }, { requestCacheMode: 'no-store', resource: network, headersMs: 700, bodyMs: 100 });
  assert.equal(result.ageSeconds, 12); assert.equal(result.sharedCache, 'hit_or_stale_reported');
  assert.equal(result.dateSeconds, Date.parse('2026-11-19T03:00:19Z') / 1000);
  assert.deepEqual(result.cacheControl, ['private', 'no-store', 'max-age=60']);
  assert.doesNotMatch(JSON.stringify(result), /secret-|set-cookie|authorization/);
  const miss = transportFromHeaders({ age: '0', 'x-cache': 'MISS from secret-host' }, { resource: network });
  assert.equal(miss.sharedCache, 'miss_or_bypass_reported');
  assert.equal(transportFromHeaders({ age: '1' }, {}).sharedCache, 'age_reported');
  assert.equal(transportFromHeaders({ age: 'invalid', 'x-cache': 'secret-hit-host', date: '2026-11-19' }, {}).sharedCache, 'unknown');
});

test('malformed, missing and extra diagnostic fields cannot leak or manufacture transport evidence', () => {
  assert.equal(safeTransportEvidence(null), null);
  const result = safeTransportEvidence({ resource: { ...network, transferBytes: -1, encodedBodyBytes: Infinity,
    decodedBodyBytes: NaN, url: 'secret-url' }, headersMs: 'secret-time', ageSeconds: -1,
    cacheStatuses: [{ header: 'secret-header', statuses: ['HIT'] }, { header: 'x-cache', statuses: ['secret-status'] }],
    body: 'secret-body', cacheControl: ['secret-token', 'no-store'], browserDelivery: 'local_cache_signal', sharedCache: 'hit_or_stale_reported' })!;
  assert.equal(result.browserDelivery, 'unknown'); assert.equal(result.sharedCache, 'unknown');
  assert.equal(result.ageSeconds, null); assert.equal(result.headersMs, null);
  assert.doesNotMatch(JSON.stringify(result), /secret-|"body"|Infinity|NaN/);
});
