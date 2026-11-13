import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { Store } from './store.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type { Post, JobTiming, ActionTiming } from './types.ts';
import { SCAN_SNAPSHOT_LIMIT, type ScanDecision, type ScanSnapshot } from './scan-history.ts';
const post = (id: string, time = 101): Post => ({ post_id: id, creation_time: time, permalink: null, sourceVerification: 'owning_profile' });
function fixture(path = ':memory:') {
  const store = new Store(path), config = store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test' });
  const baseline = ['1','2','3','4','5'].map(id => post(id, 90));
  const sessionId = store.baseline('10', '20', 100, baseline);
  return { store, input: { accountId: '10', sourceId: '20', sessionId, floor: 100, serverNow: 120,
    previous: new Set(baseline.map(p => p.post_id)), posts: [post('6'), ...baseline.slice(0, 4)], config } };
}

test('result retention removes old details and preserves deduplication and pending work', () => {
  const { store, input } = fixture();
  try {
    const add = (id: number) => store.testJob(input.accountId, input.sourceId, input.sessionId, post(String(id)), input.config);
    const oldest = add(100), queued = add(101);
    store.db.prepare('INSERT INTO action_timings VALUES (?, ?, ?)').run(oldest.id, 'like', '{}');
    store.saveScanSnapshot('detection', oldest.id, { version: 1, capacity: 60,
      context: { sessionId: input.sessionId, accountId: input.accountId, sourceId: input.sourceId, serverFloor: input.floor }, reads: [] });
    for (let id = 102; id <= 121; id++) add(id);
    assert.deepEqual(store.pruneJobs([queued.id]), [oldest.id]);
    assert.equal(store.job(oldest.id), null);
    assert.equal(store.job(queued.id)?.id, queued.id);
    assert.equal(store.scanSnapshots().length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM action_timings').get()?.count, 0);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => add(100), /JOB_HISTORY_EXPIRED/);
    assert.equal(store.acceptWindow({ ...input, posts: [post('100')] }).length, 0);
    assert.deepEqual(store.pruneJobs(), [queued.id]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()?.count, 20);
    assert.deepEqual(store.jobPage(999), { page: 4, pageSize: 5, total: 20, pages: 4 });
    assert.deepEqual(store.jobs(5, 15).map(job => job.post.post_id), ['106', '105', '104', '103', '102']);
  } finally { store.close(); }
});

test('scan decisions follow the actual dedupe and time checks without changing acceptance', () => {
  const f = fixture(), decisions: ScanDecision[] = [];
  try {
    const jobs = f.store.acceptWindow({ ...f.input, posts: [post('1', 90), post('7', 99), post('6')], onDecision: decision => decisions.push(decision) });
    assert.deepEqual(decisions.map(d => d.reason), ['previous_window', 'older_than_session', 'accepted']);
    assert.equal(decisions[2].jobId, jobs[0].id);
    decisions.length = 0;
    assert.equal(f.store.acceptWindow({ ...f.input, previous: new Set(), posts: [post('6')], onDecision: decision => decisions.push(decision) }).length, 0);
    assert.equal(decisions[0].reason, 'already_seen');
    decisions.length = 0;
    assert.throws(() => f.store.acceptWindow({ ...f.input, posts: [post('8', 999)], onDecision: decision => decisions.push(decision) }), /POST_TIME_INVALID/);
    assert.equal(decisions[0].reason, 'future_time'); assert.equal(f.store.jobs().length, 1);
  } finally { f.store.close(); }
});

test('scan snapshots persist separately from job/status data with bounded retention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'facebook-tool-scan-')), path = join(dir, 'test.sqlite');
  const snapshot: ScanSnapshot = { version: 1, capacity: 60, context: { sessionId: null, accountId: null, sourceId: '20', serverFloor: null }, reads: [] };
  try {
    const f = fixture(path), [job] = f.store.acceptWindow(f.input);
    for (let i = 0; i <= SCAN_SNAPSHOT_LIMIT; i++) f.store.saveScanSnapshot('detection', job.id, snapshot);
    assert.equal(f.store.scanSnapshots(1000).length, SCAN_SNAPSHOT_LIMIT);
    assert.equal(f.store.scanSnapshots(1)[0].jobId, job.id);
    assert.equal('scanHistory' in f.store.job(job.id)!, false);
    f.store.close();
    const reopened = new Store(path);
    try { assert.deepEqual(reopened.scanSnapshots(1)[0].snapshot, snapshot); }
    finally { reopened.close(); }
  } finally { assert.ok(isAbsolute(dir) && dir.startsWith(join(tmpdir(), 'facebook-tool-scan-'))); rmSync(dir, { recursive: true, force: true }); }
});
test('durable dedupe outlives the five-post window and preserves assigned contents', () => {
  const f = fixture();
  const [j] = f.store.acceptWindow(f.input);
  assert.equal(j.plan.comment, 'test 1');
  assert.equal(f.store.nextPlan().comment, 'test 2');
  assert.equal(f.store.acceptWindow(f.input).length, 0);
  f.store.saveConfig({ ...f.input.config, comments: ['nội dung mới'] });
  assert.equal(f.store.job(j.id)!.plan.comment, 'test 1');
  assert.equal(f.store.nextPlan().comment, 'nội dung mới');
  const older = { ...f.input, previous: new Set<string>(), posts: [post('6'), post('7', 99), ...f.input.posts.slice(1, 4)] };
  assert.equal(f.store.acceptWindow(older).length, 0);
  assert.equal(f.store.hasSeen('10','20','7'), true);
  assert.equal(f.store.jobs().length, 1);
  f.store.close();
});
test('window receipt, jobs, comment cursor and dedupe roll back together on a rejected post', () => {
  const f = fixture();
  assert.throws(() => f.store.acceptWindow({ ...f.input, posts: [post('6'),post('7',999),...f.input.posts.slice(1,4)] }), /POST_TIME_INVALID/);
  assert.equal(f.store.jobs().length, 0);
  assert.equal(f.store.hasSeen('10','20','6'), false);
  assert.equal(f.store.nextPlan().comment, 'test 1');
  assert.equal(f.store.acceptWindow(f.input).length, 1);
  f.store.close();
});
test('crash recovery never resubmits an uncertain action and retains an unsent action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'facebook-tool-store-')), path = join(dir, 'test.sqlite');
  try {
    const f = fixture(path), [job] = f.store.acceptWindow(f.input);
    f.store.transition(job.id,'like',['ready'],'preparing');
    f.store.transition(job.id,'like',['preparing'],'submitting');
    f.store.transition(job.id,'like',['submitting'],'succeeded');
    f.store.transition(job.id,'share',['ready'],'preparing');
    f.store.transition(job.id,'share',['preparing'],'submitting');
    f.store.evidence(job.id,'share',{externalId:'shared_post_1',externalUrl:'https://www.facebook.com/permalink.php?story_fbid=1&id=10'});
    f.store.transition(job.id,'comment',['ready'],'preparing');
    f.store.close();
    const reopened = new Store(path), result = reopened.job(job.id)!;
    assert.equal(result.actions.find(a=>a.name==='like')!.state,'succeeded');
    assert.equal(result.actions.find(a=>a.name==='share')!.state,'unknown');
    assert.equal(result.actions.find(a=>a.name==='share')!.externalId,'shared_post_1');
    assert.equal(result.actions.find(a=>a.name==='comment')!.state,'ready');
    assert.equal(reopened.transition(job.id,'share',['ready'],'preparing'), false);
    assert.equal(reopened.nextPlan().comment,'test 2');
    assert.equal(reopened.config().mode,'test');
    assert.equal(reopened.hasSeen('10','20','6'),true);
    reopened.resolve(job.id,'share','not_sent');
    assert.equal(reopened.job(job.id)!.actions.find(a=>a.name==='share')!.state,'ready');
    reopened.close();
  } finally { assert.ok(isAbsolute(dir) && dir.startsWith(join(tmpdir(),'facebook-tool-store-'))); rmSync(dir,{recursive:true,force:true}); }
});

test('calibrated timing persists atomically and existing-post tests never become detection samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'facebook-tool-store-timing-')), path = join(dir, 'test.sqlite');
  try {
    const f = fixture(path);
    const timing: JobTiming = { version: 2, origin: 'watch', requestedAt: '2026-11-09T02:46:24Z', detectedAt: '2026-11-09T02:46:23Z',
      publicationDelayMs: 4500, uncertaintyMs: 600, clockOffsetMs: -240000, readStartedAt: '2026-11-09T02:46:22Z',
      readCompletedAt: '2026-11-09T02:46:23Z', previousReadCompletedAt: '2026-11-09T02:46:17Z',
      readDurationMs: 1000, readIntervalMs: 6000, pollWaitMs: 5000, pollSeconds: 5 };
    const [job] = f.store.acceptWindow({ ...f.input, timings: { '6': timing } });
    const actionTiming: ActionTiming = { version: 2, startedAt: '2026-11-09T02:46:24Z', finishedAt: '2026-11-09T02:46:25Z',
      queueMs: 200, processingMs: 1000, fromDetectionMs: 1200, fromRequestMs: 1000, fromPublicationMs: 5700, uncertaintyMs: 600 };
    assert.equal(f.store.transition(job.id, 'like', ['ready'], 'succeeded', { timing: actionTiming }), true);
    assert.equal(f.store.transition(job.id, 'like', ['ready'], 'succeeded', { timing: { ...actionTiming, processingMs: 999999 } }), false);
    const existing = f.store.testJob('10', '20', f.input.sessionId, post('1', 90), f.input.config);
    assert.equal(existing.origin, 'existing-test');
    assert.equal(existing.timing!.publicationDelayMs, null);
    assert.equal(existing.timing!.detectedAt, null);
    f.store.close();
    const reopened = new Store(path), persisted = reopened.job(job.id)!;
    assert.deepEqual(persisted.timing, timing);
    assert.deepEqual(persisted.actions.find(a => a.name === 'like')!.timing, actionTiming);
    reopened.transition(job.id, 'like', ['succeeded'], 'unknown');
    reopened.resolve(job.id, 'like', 'not_sent');
    assert.equal(reopened.job(job.id)!.actions.find(a => a.name === 'like')!.timing, null);
    reopened.close();
  } finally { assert.ok(isAbsolute(dir) && dir.startsWith(join(tmpdir(), 'facebook-tool-store-timing-'))); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy jobs keep their proven origin without inventing calibrated publication delays', () => {
  const f = fixture();
  try {
    const [watch] = f.store.acceptWindow(f.input);
    assert.equal(watch.origin, 'watch'); assert.equal(watch.timing, null);
    const manual = f.store.testJob('10', '20', f.input.sessionId, post('1', 90), f.input.config);
    f.store.db.prepare('DELETE FROM job_timings WHERE job_id=?').run(manual.id);
    const legacy = f.store.job(manual.id)!;
    assert.equal(legacy.origin, 'existing-test'); assert.equal(legacy.timing, null);
  } finally { f.store.close(); }
});
