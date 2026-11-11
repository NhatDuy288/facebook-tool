import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionTrace } from './action-trace.ts';

test('action trace keeps independent steps, live snapshots and first response milestones', () => {
  let now = 100;
  const trace = new ActionTrace(now, () => now);
  trace.label('share-opening-adaptive-v1'); trace.label('ignored-overwrite');
  trace.enter('navigate_original_post'); now += 800;
  trace.enter('verify_original_post'); now += 25;
  trace.enter('prepare_submission'); now += 10;
  trace.mark('submitStarted'); trace.enter('submit'); now += 30;
  trace.mark('serverConfirmed');
  const live = trace.snapshot();
  assert.equal(live.finishedMs, null);
  assert.equal(live.steps.at(-1)!.status, 'running');
  assert.equal(live.milestones.serverConfirmed, 865);
  now += 100; trace.mark('serverConfirmed'); trace.enter('share_readback_navigate');
  now += 900; trace.finish();
  const final = trace.snapshot();
  assert.equal(final.implementation, 'share-opening-adaptive-v1');
  assert.equal(final.milestones.serverConfirmed, 865, 'later events cannot move the first confirmation');
  assert.equal(final.finishedMs, 1865);
  assert.equal(final.steps.reduce((sum, step) => sum + step.endMs - step.startMs, 0), 1865);
  assert.ok(final.steps.every(step => step.status === 'completed'));
  live.steps[0].endMs = 999999; live.milestones.submitStarted = 999999;
  assert.equal(trace.snapshot().steps[0].endMs, 800, 'snapshots cannot mutate the collector');
  assert.equal(trace.snapshot().milestones.submitStarted, 835);
});

test('an acknowledgement is distinct from confirmation and an interrupted step stays interrupted', () => {
  let now = 0;
  const trace = new ActionTrace(now, () => now);
  trace.enter('wait_server'); now = 0; trace.mark('serverAcknowledged');
  now = 100; trace.enter('comment_readback_navigate'); now = 200; trace.finish(true);
  now = 500; trace.enter('verify_like'); trace.mark('serverConfirmed');
  const final = trace.snapshot();
  assert.equal(final.milestones.serverAcknowledged, 0);
  assert.equal(final.milestones.serverConfirmed, undefined);
  assert.equal(final.steps.at(-1)!.status, 'interrupted');
  assert.equal(final.finishedMs, 200);
});
