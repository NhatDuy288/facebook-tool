import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_ID, inspectAuthWindow } from './capture.ts';
import { normalizeRefetchRoot } from './refetch-root.ts';
const edge = (id: string, text = 'old') => ({ node: { __typename: 'Story', id: `story-${id}`, post_id: id,
  creation_time: 1793850629, actors: [{ id: SOURCE_ID }], message: { text } } });
function initial() { return { data: { node: { id: SOURCE_ID, timeline_list_feed_units: { edges: [edge('101')] } } },
  extensions: { is_final: false } }; }
function patch(): any { return { path: ['node', 'timeline_list_feed_units', 'edges', 1], data: edge('102', 'fresh-marker'),
  extensions: { is_final: true } }; }
test('verified actual node root and exact streamed feed patch normalize without changing originals', () => {
  const records = [initial(), patch()];
  const result = inspectAuthWindow(records, 'fresh-marker');
  assert.equal(result.usable, true); assert.deepEqual(result.posts.map(p => p.post_id), ['101', '102']);
  assert.deepEqual(result.markerMatchIds, ['102']);
  assert.equal(result.safeInspection?.rootNormalization.mappedInitialRoots, 1);
  assert.equal(result.safeInspection?.rootNormalization.mappedScopedPatches, 1);
  assert.equal(Object.hasOwn(records[0].data!, 'node'), true); assert.equal(records[1].path[0], 'node');
});
test('wrong source, missing parent identity or missing actual connection fails closed', () => {
  const foreign = initial(); foreign.data.node.id = '999';
  assert.equal(inspectAuthWindow([foreign, patch()]).usable, false);
  const absent: any = initial(); delete absent.data.node.id;
  assert.equal(inspectAuthWindow([absent, patch()]).usable, false);
  const other: any = initial(); delete other.data.node.timeline_list_feed_units;
  assert.equal(inspectAuthWindow([other, patch()]).usable, false);
});
test('orphan and ambiguous roots cannot be mapped', () => {
  assert.equal(inspectAuthWindow([patch()]).usable, false);
  const both: any = initial(); both.data.user = { id: SOURCE_ID, timeline_list_feed_units: { edges: [edge('999')] } };
  assert.equal(inspectAuthWindow([both, patch()]).usable, false);
  const user = { data: { user: { id: SOURCE_ID, timeline_list_feed_units: { edges: [edge('101')] } } } };
  assert.equal(inspectAuthWindow([user, initial(), patch()]).usable, false);
});
test('unrelated node subfields are not feed patches and original errors/final evidence remain', () => {
  const off: any = patch(); off.path = ['node', 'other', 'edges', 1];
  const result = inspectAuthWindow([initial(), off], 'fresh-marker');
  assert.equal(result.usable, true); assert.deepEqual(result.markerMatchIds, []); assert.equal(result.posts.length, 1);
  const errored: any = patch(); errored.errors = [{ message: 'Not logged in', path: ['node'] }];
  assert.equal(inspectAuthWindow([initial(), errored]).reasonCode, 'CRITICAL_RESPONSE_ERROR');
  const pending: any = patch(); pending.extensions.is_final = false;
  assert.equal(inspectAuthWindow([initial(), pending]).reasonCode, 'FINAL_FRAME_REQUIRED');
  const raw = initial(); const normalized = normalizeRefetchRoot([raw], SOURCE_ID);
  assert.equal(normalized.records[0].data.user.id, SOURCE_ID); assert.equal(normalized.records[0].extensions.is_final, false);
});
