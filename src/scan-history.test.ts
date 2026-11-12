import test from 'node:test';
import assert from 'node:assert/strict';
import { ScanHistory, SCAN_HISTORY_LIMIT, scanBatches } from './scan-history.ts';
import type { ReadTiming, WindowRead } from './types.ts';
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
