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

function videoInitial(root = 'user'): any {
  const item = edge('101');
  const attachment = { styles: { attachment: { media: { __typename: 'Video', id: 'video-101' } } } };
  item.node.attachments = [structuredClone(attachment)];
  item.node.comet_sections = { content: { story: { id: item.node.id, attachments: [structuredClone(attachment)] } } };
  return { data: { [root]: { id: SOURCE_ID, timeline_list_feed_units: { edges: [item] } } },
    extensions: { is_final: false } };
}
function videoPatch(mirror = false, data: any = { id: 'video-101', can_viewer_share: true }): any {
  return { path: ['user', 'timeline_list_feed_units', 'edges', 0, 'node',
    ...(mirror ? ['comet_sections', 'content', 'story'] : []), 'attachments', 0, 'styles', 'attachment', 'media'],
    data, extensions: { is_final: true } };
}

test('deferred Video fields on an existing edge and its anchored story mirror do not replace post metadata or markers', () => {
  const first = videoInitial('node'), direct = videoPatch(false, { id: 'video-101', info: { message: { text: 'fresh-marker' } },
    creation_story: { __typename: 'Story', post_id: '999', creation_time: 1, actors: [{ id: '999' }], message: { text: 'fresh-marker' } } });
  const mirror = videoPatch(true, { is_looping: false });
  direct.path[0] = mirror.path[0] = 'node'; direct.extensions.is_final = false;
  const records = [first, direct, mirror], snapshot = structuredClone(records);
  const result = inspectAuthWindow(records, 'fresh-marker');
  assert.equal(result.usable, true); assert.equal(result.safeInspection?.assembly.ignoredVideoPatches, 2);
  assert.deepEqual(result.posts.map(post => [post.post_id, post.creation_time]), [['101', 1793850629]]);
  assert.deepEqual(result.markerMatchIds, []); assert.deepEqual(records, snapshot);
  const normalized = normalizeStreamFrames([videoInitial(), videoPatch()]);
  assert.deepEqual(normalized.records[1].data, {});
  assert.deepEqual(normalized.orderedEdges[0].node.attachments[0].styles.attachment.media,
    { __typename: 'Video', id: 'video-101' });
});

test('incremental deferred Video frames require an already registered edge, including streamed edges', () => {
  const first = videoInitial(), item = first.data.user.timeline_list_feed_units.edges.pop();
  const registered = patch(0, item), deferred = videoPatch();
  const final = { incremental: [deferred], extensions: { is_final: true } };
  const result = inspectAuthWindow([first, registered, final]);
  assert.equal(result.usable, true); assert.equal(result.safeInspection?.assembly.convertedEdgePatches, 1);
  assert.equal(result.safeInspection?.assembly.ignoredVideoPatches, 1);
  assert.equal(inspectAuthWindow([first, final, { ...registered, extensions: { is_final: true } }]).usable, false);
  assert.equal(inspectAuthWindow([final]).usable, false);
});

test('video controls under lightweight attachment style info preserve the three verified timeline posts', () => {
  const first = videoInitial();
  const edges = first.data.user.timeline_list_feed_units.edges;
  edges.push(edge('102'), edge('103'));
  const story = edges[0].node;
  for (const owner of [story, story.comet_sections.content.story]) {
    const renderer = owner.attachments[0].styles;
    renderer.__typename = 'StoryAttachmentUnifiedLightweightVideoStyleRenderer';
    renderer.attachment.style_infos = [{ __typename: 'VideoAttachmentStyleInfo', containing_story: {
      id: 'video-controls-story', attachments: [{ media: { __typename: 'Video', id: 'controls-video' } }],
    } }];
  }
  const records = [first];
  for (const mirror of [false, true]) {
    for (const data of [{ dubbed_track_mapping: { message: { text: 'video-marker' } } },
      { id: 'controls-video', instream_extra_config: {}, instream_video_ad_breaks_comet: {} }]) {
      const deferred = videoPatch(mirror, data);
      deferred.path.splice(-1, 1, 'style_infos', 0, 'containing_story', 'attachments', 0, 'media');
      deferred.extensions.is_final = false;
      records.push(deferred);
    }
  }
  records.at(-1).extensions.is_final = true;
  const result = inspectAuthWindow(records, 'video-marker');
  assert.equal(result.usable, true);
  assert.equal(result.safeInspection?.assembly.ignoredVideoPatches, 4);
  assert.deepEqual(result.posts.map(post => post.post_id), ['101', '102', '103']);
  assert.deepEqual(result.markerMatchIds, []);

  for (const change of [(frame: any) => { frame.data.id = 'other-video'; },
    (frame: any) => { frame.data.creation_time = 1; }, (frame: any) => { frame.path[frame.path.length - 2] = 1; }]) {
    const invalid = structuredClone(records);
    change(invalid.at(-1));
    assert.equal(inspectAuthWindow(invalid).reasonCode, 'UNVERIFIED_WINDOW');
  }
});

test('ignored Video patches retain final-frame, continuation and original error requirements', () => {
  const pending = videoPatch(); pending.extensions.is_final = false;
  assert.equal(inspectAuthWindow([videoInitial(), pending]).reasonCode, 'FINAL_FRAME_REQUIRED');
  const more = videoPatch(); more.hasNext = true;
  assert.equal(inspectAuthWindow([videoInitial(), more]).reasonCode, 'FINAL_FRAME_REQUIRED');
  const auth = videoPatch(); auth.errors = [{ message: 'Not logged in', path: ['user'] }];
  assert.equal(inspectAuthWindow([videoInitial(), auth]).reasonCode, 'CRITICAL_RESPONSE_ERROR');
  const errored = videoPatch(); errored.error = { code: 1 };
  assert.equal(inspectAuthWindow([videoInitial(), errored]).reasonCode, 'GRAPHQL_ERROR');
  const incremental = { incremental: [auth], extensions: { is_final: true } };
  assert.equal(inspectAuthWindow([videoInitial(), incremental]).reasonCode, 'CRITICAL_RESPONSE_ERROR');
  const foreign = videoInitial(); foreign.data.user.id = '999';
  assert.equal(inspectAuthWindow([foreign, videoPatch()]).usable, false);
});

test('deferred Video mirror must preserve the registered story identity and optional metadata', () => {
  for (const change of [(story: any) => { story.id = 'other-story'; }, (story: any) => { delete story.id; },
    (story: any) => { story.__typename = 'Photo'; }, (story: any) => { story.post_id = '999'; }]) {
    const first = videoInitial(); change(first.data.user.timeline_list_feed_units.edges[0].node.comet_sections.content.story);
    const result = inspectAuthWindow([first, videoPatch(true)]);
    assert.equal(result.usable, false); assert.equal(result.safeInspection?.assembly.ignoredVideoPatches, 0);
  }
  const same = videoInitial(), story = same.data.user.timeline_list_feed_units.edges[0].node.comet_sections.content.story;
  story.__typename = 'Story'; story.post_id = '101';
  assert.equal(inspectAuthWindow([same, videoPatch(true)]).usable, true);
});

test('deferred Video recognition refuses photos, missing media identity and unrelated positions', () => {
  for (const change of [(media: any) => { media.__typename = 'Photo'; }, (media: any) => { delete media.id; }]) {
    const first = videoInitial(); change(first.data.user.timeline_list_feed_units.edges[0].node.attachments[0].styles.attachment.media);
    assert.equal(inspectAuthWindow([first, videoPatch()]).usable, false);
  }
  assert.equal(inspectAuthWindow([videoInitial(), videoPatch(false, { id: 'other-video', info: null })]).usable, false);
  for (const index of [-1, 0.5, 1, 5]) {
    const deferred = videoPatch(); deferred.path[3] = index;
    assert.equal(inspectAuthWindow([videoInitial(), deferred]).usable, false);
  }
  const missingAttachment = videoPatch(); missingAttachment.path[6] = 1;
  assert.equal(inspectAuthWindow([videoInitial(), missingAttachment]).usable, false);
});

test('unknown Video fields, identity updates and malformed payloads remain unsupported', () => {
  for (const data of [{ unknown_field: true }, { creation_time: 1 }, { post_id: '999' }, { actors: [{ id: SOURCE_ID }] },
    { __typename: 'Story' }, {}, null, [], { info: null, creation_time: 1 }]) {
    assert.equal(inspectAuthWindow([videoInitial(), videoPatch(false, data)]).usable, false);
  }
  const mixed = videoPatch(); mixed.items = [];
  assert.equal(inspectAuthWindow([videoInitial(), mixed]).usable, false);
  const identity = videoPatch(); identity.path = ['user', 'timeline_list_feed_units', 'edges', 0, 'node', 'creation_time'];
  identity.data = { info: null };
  assert.equal(inspectAuthWindow([videoInitial(), identity]).usable, false);
  const bareStory = videoPatch(); bareStory.path = ['user', 'timeline_list_feed_units', 'edges', 1]; bareStory.data = edge('102').node;
  assert.equal(inspectAuthWindow([videoInitial(), bareStory]).usable, false);
});

test('deferred media cannot supply missing main-story metadata or source evidence', () => {
  for (const field of ['creation_time', 'post_id', 'actors', '__typename']) {
    const first = videoInitial(); delete first.data.user.timeline_list_feed_units.edges[0].node[field];
    const deferred = videoPatch(false, { creation_story: edge('101').node, info: { creation_time: 1793850629 } });
    assert.equal(inspectAuthWindow([first, deferred]).usable, false);
  }
});
