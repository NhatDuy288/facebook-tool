import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStreamFrames } from './stream-frames.ts';
import { SOURCE_ID, inspectAuthWindow } from './capture.ts';
const edge = (id: string, text = 'old'): any => ({ node: { __typename: 'Story', id: `story-${id}`, post_id: id,
  creation_time: 1793850629, actors: [{ id: SOURCE_ID }], message: { text } } });
const initial = () => ({ data: { user: { id: SOURCE_ID, timeline_list_feed_units: { edges: [edge('101')] } } },
  extensions: { is_final: false } });
const patch = (index: number, item = edge(String(101 + index)), final = false): any => ({
  path: ['user', 'timeline_list_feed_units', 'edges', index], data: item, extensions: { is_final: final } });
test('two exact indexed edge patches are accepted and marker remains main-story anchored', () => {
  const records = [initial(), patch(1), patch(2, edge('103', 'fresh-marker'), true)];
  const result = inspectAuthWindow(records, 'fresh-marker');
  assert.equal(result.usable, true); assert.deepEqual(result.posts.map(p => p.post_id), ['101', '102', '103']);
  assert.deepEqual(result.markerMatchIds, ['103']); assert.equal(result.safeInspection?.assembly.convertedEdgePatches, 2);
  assert.deepEqual(records[2].path, ['user', 'timeline_list_feed_units', 'edges', 2]);
  assert.equal(result.safeInspection?.response.records.at(-1)?.isFinal, true);
});
test('holes, conflicting index, metadata replacement and bad indexes fail', () => {
  for (const records of [[initial(), patch(2, edge('103'), true)],
    [initial(), patch(0, edge('999'), true)], [initial(), patch(-1, edge('999'), true)],
    [initial(), patch(1.5, edge('999'), true)], [initial(), patch(5, edge('999'), true)]]) {
    assert.equal(inspectAuthWindow(records).usable, false);
  }
  const replacement = edge('101'); replacement.node.creation_time++;
  assert.equal(inspectAuthWindow([initial(), patch(0, replacement, true)]).usable, false);
});
test('bare Story, nested/deeper patch or off-feed edge never become accepted source posts', () => {
  assert.equal(inspectAuthWindow([initial(), patch(1, edge('102').node, true)]).usable, false);
  const nested = patch(1, edge('102', 'fresh-marker'), true); nested.path.push('node');
  assert.equal(inspectAuthWindow([initial(), nested], 'fresh-marker').usable, false);
  const off = patch(1, edge('102', 'fresh-marker'), true); off.path = ['viewer', 'feed', 'edges', 1];
  const result = inspectAuthWindow([initial(), off], 'fresh-marker');
  assert.equal(result.usable, true); assert.deepEqual(result.markerMatchIds, []); assert.equal(result.posts.length, 1);
});
test('actual final marker, original auth errors and original parent conflicts remain mandatory', () => {
  assert.equal(inspectAuthWindow([initial(), patch(1)]).reasonCode, 'FINAL_FRAME_REQUIRED');
  const errored = patch(1, edge('102'), true); errored.errors = [{ message: 'Not logged in' }];
  assert.equal(inspectAuthWindow([initial(), errored]).reasonCode, 'CRITICAL_RESPONSE_ERROR');
  const foreign = initial(); foreign.data.user.id = '999';
  assert.equal(inspectAuthWindow([foreign, patch(1, edge('102'), true)]).usable, false);
});
test('identical duplicate indexes are idempotent; final whole-connection must agree', () => {
  const identical = [initial(), patch(1), patch(1, edge('102'), true)];
  assert.equal(inspectAuthWindow(identical).usable, true);
  const full = { path: ['user', 'timeline_list_feed_units'], data: { edges: [edge('101'), edge('999')] }, extensions: { is_final: true } };
  assert.equal(inspectAuthWindow([initial(), patch(1), full]).usable, false);
  const normalized = normalizeStreamFrames([initial(), patch(1)]);
  assert.equal(normalized.diagnostics.assembledPositions, 2);
});
test('scoped standard items and incremental edge frames obey the same position and source checks', () => {
  const items = { path: ['user', 'timeline_list_feed_units', 'edges', 1], items: [edge('102'), edge('103', 'fresh-marker')],
    extensions: { is_final: true } };
  const result = inspectAuthWindow([initial(), items], 'fresh-marker');
  assert.equal(result.usable, true); assert.deepEqual(result.markerMatchIds, ['103']);
  const incremental = { incremental: [{ path: ['user', 'timeline_list_feed_units', 'edges', 1], data: edge('102', 'fresh-marker') }],
    extensions: { is_final: true } };
  assert.deepEqual(inspectAuthWindow([initial(), incremental], 'fresh-marker').markerMatchIds, ['102']);
  const invalid = { ...items, items: [edge('102').node] };
  assert.equal(inspectAuthWindow([initial(), invalid]).usable, false);
});
test('out-of-order streamed edges retain explicit slot order before selecting a partial page', () => {
  const first = initial(), second = patch(1, edge('102', 'fresh-marker'));
  const third = patch(2, edge('103'));
  // Deliberately nonchronological metadata proves this is an index order, not a time sort.
  first.data.user.timeline_list_feed_units.edges[0].node.creation_time = 300;
  second.data.node.creation_time = 100; third.data.node.creation_time = 200;
  const records = [first, third, second, { extensions: { is_final: true } }];
  const result = inspectAuthWindow(records, 'fresh-marker');
  assert.equal(result.usable, true);
  assert.deepEqual(result.posts.map(post => post.post_id), ['101', '102', '103']);
  assert.deepEqual(result.posts.slice(0, 2).map(post => post.post_id), ['101', '102']);
  assert.deepEqual(result.markerMatchIds, ['102']);
  assert.equal(result.safeInspection?.window.receivedOrderChronologicalDescending, false);
  assert.deepEqual(records[1].path, ['user', 'timeline_list_feed_units', 'edges', 2]);
});
test('out-of-order incremental edges in one frame keep positions and exact main-story markers', () => {
  const records = [initial(), { incremental: [
    { path: ['user', 'timeline_list_feed_units', 'edges', 2], data: edge('103') },
    { path: ['user', 'timeline_list_feed_units', 'edges', 1], data: edge('102', 'fresh-marker') },
  ], extensions: { is_final: true } }];
  const result = inspectAuthWindow(records, 'fresh-marker');
  assert.equal(result.usable, true);
  assert.deepEqual(result.posts.map(post => post.post_id), ['101', '102', '103']);
  assert.deepEqual(result.markerMatchIds, ['102']);
});
