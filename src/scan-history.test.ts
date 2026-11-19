import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanHistory, SCAN_HISTORY_LIMIT, scanBatches } from './scan-history.ts';
import type { ReadTiming, WindowRead } from './types.ts';
import { safeTransportEvidence } from './facebook/feed/read-diagnostics.ts';
const timing: ReadTiming = { startedAt: '2026-11-11T08:00:00.000Z', completedAt: '2026-11-11T08:00:01.000Z',
  startedMonoMs: 100, completedMonoMs: 1100, durationMs: 1000, intervalMs: 3000, waitMs: 2000, pollSeconds: 2 };
const context = { sessionId: 'session', accountId: '10', sourceId: '20', serverFloor: 100 };
const windowRead: WindowRead = { posts: [{ post_id: '123', creation_time: 110, sourceVerification: 'owning_profile', permalink: 'https://example.invalid/secret-url' }],
  usable: true, reasonCode: null, serverSeconds: 120, firstSeenAt: timing.completedAt, queryPOSTsIssued: 1, queryMs: 900, decodedBodyBytes: 5000 };

test('scan ring is bounded, detached from reader objects and snapshots do not change with later reads', () => {
  const history = new ScanHistory(), input = structuredClone(windowRead);
  history.record(timing, 'watch', input, null);
  const saved = history.snapshot(context);
  input.posts[0].post_id = '999';
  for (let i = 0; i < SCAN_HISTORY_LIMIT + 10; i++) history.record(timing, 'watch', windowRead, null);
  assert.equal(history.summary().retained, SCAN_HISTORY_LIMIT);
  assert.equal(saved.reads.length, 1); assert.equal(saved.reads[0].posts[0].post_id, '123');
  assert.equal(history.snapshot(context).reads[0].sequence, 12);
  history.clear(); assert.equal(history.summary().retained, 0);
  assert.equal(saved.reads.length, 1);
});

test('scan evidence projects safe fields and distinguishes rejected data from unknown transport results', () => {
  const history = new ScanHistory();
  const batch = { batchIndex: 0, requestedCount: 3, returnedPostCount: 1, selectedPostCount: 0, queryMs: 900,
    httpStatus: 200, decodedBodyBytes: 5000, responseComplete: true, usable: false, reasonCode: 'UNVERIFIED_WINDOW',
    serverSeconds: 120, posts: windowRead.posts, requestStartedAt: 1000, headersReceivedAt: 1900,
    body: 'secret-body', cursor: 'secret-cursor', form: { fb_dtsg: 'secret-token' },
    parser: { mainTimelineEdgesObserved: 2, parentSourceConflict: false, poisonedPostIds: ['456'], unsupportedPatchCount: 0,
      rejectedEdges: [{ observedPostIds: ['456'], classification: 'missing_or_conflicting_source_identity', secret: 'secret-edge' }] } };
  history.record(timing, 'watch', { ...windowRead, usable: false, reasonCode: 'UNVERIFIED_WINDOW', scanBatches: scanBatches([batch]) }, 'UNUSABLE_WINDOW');
  history.record(timing, 'watch', undefined, 'READ_TIMEOUT');
  const saved = history.snapshot(context), text = JSON.stringify(saved);
  assert.equal(saved.reads[0].outcome, 'rejected');
  assert.equal(saved.reads[0].readerReasonCode, 'UNVERIFIED_WINDOW');
  assert.deepEqual(saved.reads[0].batches[0].parser!.rejectedEdges[0].observedPostIds, ['456']);
  assert.equal(saved.reads[0].batches[0].requestStartedAt, 1000);
  assert.equal(saved.reads[1].outcome, 'error'); assert.equal(saved.reads[1].queryPOSTsIssued, null);
  assert.doesNotMatch(text, /secret-|permalink|fb_dtsg|cursor|form|body/);
});

const diagnostics = (extra: Record<string, unknown> = {}): WindowRead => ({ ...windowRead,
  scanBatches: [{ batchIndex: 0, requestedCount: 3, returnedPostCount: 1, selectedPostCount: 1, queryMs: 900,
    httpStatus: 200, decodedBodyBytes: 5000, responseComplete: true, usable: true, reasonCode: null,
    serverSeconds: 120, posts: windowRead.posts, responseFingerprint: 'a'.repeat(64),
    transport: safeTransportEvidence({ dateSeconds: 120, ageSeconds: 0,
      resource: { match: 'matched', transferBytes: 1000, encodedBodyBytes: 700, workerStartMs: 0 } }), ...extra }] });
const later = (ms: number): ReadTiming => ({ ...timing, completedMonoMs: timing.completedMonoMs + ms, startedMonoMs: timing.startedMonoMs + ms });

test('unchanged network windows are distinguished from cache signals, never called confirmed Facebook lag', () => {
  const h = new ScanHistory();
  h.record(timing, 'watch', diagnostics(), null);
  const repeated = h.record(later(3000), 'watch', diagnostics(), null);
  assert.equal(repeated.freshness.interpretation, 'unchanged_over_network_internal_cause_unknown');
  assert.equal(repeated.freshness.sameHeadResponseAsPrevious, true);
  assert.equal(repeated.freshness.headDateDeltaSeconds, 0);
  assert.equal(repeated.freshness.unchangedReads, 2); assert.equal(repeated.freshness.unchangedForMs, 3000);
  const changedPayload = diagnostics({ responseFingerprint: 'b'.repeat(64),
    transport: safeTransportEvidence({ dateSeconds: 126, resource: { match: 'matched', transferBytes: 1100, encodedBodyBytes: 800, workerStartMs: 0 } }) });
  const next = h.record(later(6000), 'watch', changedPayload, null);
  assert.equal(next.freshness.sameWindowAsPrevious, true); assert.equal(next.freshness.sameHeadResponseAsPrevious, false);
  assert.equal(next.freshness.headDateDeltaSeconds, 6); assert.equal(next.freshness.unchangedReads, 3);
  const cached = h.record(later(9000), 'watch', diagnostics({ transport: safeTransportEvidence({ ageSeconds: 10 }) }), null);
  assert.equal(cached.freshness.interpretation, 'cache_signal_present');
  const sw = h.record(later(12000), 'watch', diagnostics({ transport: safeTransportEvidence({
    resource: { match: 'matched', transferBytes: 0, encodedBodyBytes: 900, workerStartMs: 1 } }) }), null);
  assert.equal(sw.freshness.interpretation, 'unchanged_cause_unknown');
});

test('freshness comparison resets on errors, new windows, baseline boundaries and new sessions', () => {
  const h = new ScanHistory();
  h.record(timing, 'baseline', diagnostics(), null);
  assert.equal(h.record(later(3000), 'watch', diagnostics(), null).freshness.interpretation, 'first_observation');
  const changed = { ...diagnostics(), posts: [{ ...windowRead.posts[0], post_id: '456' }] };
  const accepted = h.record(later(6000), 'watch', changed, null);
  assert.equal(accepted.freshness.interpretation, 'window_changed'); assert.equal(accepted.freshness.unchangedReads, 1);
  assert.equal(h.record(later(9000), 'watch', diagnostics(), 'UNUSABLE_WINDOW').freshness.interpretation, 'read_not_valid');
  assert.equal(h.record(later(12000), 'watch', diagnostics(), null).freshness.comparedWithSequence, null);
  h.clear(); assert.equal(h.record(later(15000), 'watch', diagnostics(), null).freshness.unchangedReads, 1);
  const unknown = h.record(later(18000), 'watch', windowRead, null);
  assert.equal(unknown.freshness.interpretation, 'unchanged_cause_unknown');
  assert.equal(unknown.freshness.sameHeadResponseAsPrevious, null);
});
