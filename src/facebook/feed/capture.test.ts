import test from 'node:test';
import assert from 'node:assert/strict';
import { FB_ORIGIN, SOURCE_ID, QUERY_NAME, readAdvertisedPreparation, readAdvertisedDocuments, readObservedQuery, makeReadForm, inspectAuthWindow } from './capture.ts';
const vars = { userID: SOURCE_ID, count: 1, stream_count: 1, cursor: null, omitPinnedPost: true };
function form(variables: object = vars, extra: Record<string, string> = {}) {
  return new URLSearchParams({ doc_id: '12345', variables: JSON.stringify(variables), fb_api_req_friendly_name: QUERY_NAME,
    __user: '111111111', fb_dtsg: 'private-ram-token', ...extra }).toString();
}
const observed = (variables: object = vars) => readObservedQuery(`${FB_ORIGIN}/api/graphql/`, 'POST', form(variables))!;
const prep = (variables: object = vars) => readAdvertisedPreparation(`<script type="application/json">${JSON.stringify({
  initial: { queryName: QUERY_NAME, queryID: '56789', variables }, config: { graphURI: '/api/graphql/', actorID: '111111111' },
  tokens: { token: 'must-not-return' } })}</script>`);
test('only actual source query POST is eligible, never mutations or foreign origin/source', () => {
  assert.ok(observed());
  assert.equal(readObservedQuery(`${FB_ORIGIN}/api/graphql/`, 'GET', form()), null);
  assert.equal(readObservedQuery('https://facebook.com.evil/api/graphql/', 'POST', form()), null);
  assert.equal(readObservedQuery(`${FB_ORIGIN}/api/graphql/`, 'POST', form(vars, { fb_api_req_friendly_name: 'CometUFICreateCommentMutation' })), null);
  assert.equal(readObservedQuery(`${FB_ORIGIN}/api/graphql/`, 'POST', form({ ...vars, userID: '999' })), null);
  assert.equal(readObservedQuery(`${FB_ORIGIN}/api/graphql/`, 'POST', form() + '&doc_id=999'), null);
});
test('preparation parses complete JSON only and omits token/config output', () => {
  const p = prep(); assert.equal(p.authenticated, true); assert.equal(p.descriptor?.queryID, '56789');
  assert.equal(JSON.stringify(p).includes('must-not-return'), false);
  assert.equal(readAdvertisedPreparation(`<script>window.config=${JSON.stringify({ queryName: QUERY_NAME, queryID: '5', variables: vars })}</script>`).descriptor, null);
  assert.equal(readAdvertisedPreparation('<script type="application/json">{"queryName":').descriptor, null);
  assert.equal(prep({ ...vars, userID: '999' }).descriptor, null);
});
test('observed JSON script text shares exact descriptor/auth checks, limits and no token output', () => {
  const scripts = [JSON.stringify({ queryName: QUERY_NAME, queryID: '56789', variables: vars }),
    JSON.stringify({ config: { graphURI: '/api/graphql/', actorID: '111111111' }, token: 'must-not-return' })];
  const p = readAdvertisedDocuments(scripts);
  assert.equal(p.descriptor?.queryID, '56789'); assert.equal(p.authenticated, true);
  assert.equal(JSON.stringify(p).includes('must-not-return'), false);
  assert.deepEqual(readAdvertisedDocuments(['{"queryName":', 'window.config = {}']), { descriptor: null, authenticated: false });
  assert.throws(() => readAdvertisedDocuments([' '.repeat(4 * 1024 * 1024), ' '.repeat(4 * 1024 * 1024 + 1)]), /CAPTURE_LIMIT/);
  assert.equal(readAdvertisedDocuments([JSON.stringify({ queryName: QUERY_NAME, queryID: '5', variables: { ...vars, userID: '999' } })]).descriptor, null);
});
test('initial advertised query replaces observed pagination variables, only declared counts become 5', () => {
  const o = observed({ ...vars, cursor: 'private-pagination-cursor' });
  const actual = makeReadForm(o, prep()); const result = JSON.parse(actual.get('variables')!);
  assert.equal(actual.get('doc_id'), '56789'); assert.equal(result.count, 5); assert.equal(result.stream_count, 5);
  assert.equal(result.cursor, null); assert.equal(result.omitPinnedPost, true);
  assert.equal(actual.get('fb_dtsg'), 'private-ram-token');
  assert.equal(o.variables.count, 1); assert.equal(o.form.get('doc_id'), '12345');
  assert.throws(() => makeReadForm(o, { descriptor: null, authenticated: true }), /INITIAL_QUERY_UNAVAILABLE/);
  const countOnly = JSON.parse(makeReadForm(observed({ userID: SOURCE_ID, count: 1 }), { descriptor: null, authenticated: true }).get('variables')!);
  assert.equal(countOnly.count, 5); assert.equal(Object.hasOwn(countOnly, 'stream_count'), false);
  assert.throws(() => makeReadForm(observed({ userID: SOURCE_ID, stream_count: 1 }), { descriptor: null, authenticated: true }), /COUNT_FIELDS_UNAVAILABLE/);
  for (const stream_count of [null, '1', 0, -1, 1.5])
    assert.throws(() => makeReadForm(observed({ userID: SOURCE_ID, count: 1, stream_count }), { descriptor: null, authenticated: true }), /COUNT_FIELDS_UNAVAILABLE/);
});
test('authentication is required from observed actor or advertised config', () => {
  const o = readObservedQuery(`${FB_ORIGIN}/api/graphql/`, 'POST', form(vars, { __user: '0' }))!;
  assert.throws(() => makeReadForm(o, { descriptor: null, authenticated: false }), /LOGIN_REQUIRED/);
  assert.equal(makeReadForm(o, prep()).get('doc_id'), '56789');
});
test('advertised runWithContinuationKey execution flag is retained, real continuation tokens are rejected', () => {
  const initial = { ...vars, runWithContinuationKey: true };
  const result = JSON.parse(makeReadForm(observed(initial), { descriptor: null, authenticated: true }).get('variables')!);
  assert.equal(result.runWithContinuationKey, true); assert.equal(result.count, 5);
  for (const key of ['after', 'before', 'start_cursor', 'endCursor', 'continuation', 'continuation_token', 'continuationKey']) {
    assert.throws(() => makeReadForm(observed({ ...initial, [key]: 'actual-token' }), { descriptor: null, authenticated: true }), /INITIAL_QUERY_UNAVAILABLE/);
  }
});
function story(id = '101', text = 'new-marker', source = SOURCE_ID): any {
  return { __typename: 'Story', id: `story-${id}`, post_id: id, creation_time: 1793850629,
    actors: [{ id: source }], message: { text } };
}
function frames(edges: any[] = [{ node: story() }]): any[] {
  return [{ data: { user: { id: SOURCE_ID, timeline_list_feed_units: { edges } } }, extensions: { is_final: true } }];
}
test('accepted main feed exact marker matches; attached/off-feed text and substring do not', () => {
  const valid = inspectAuthWindow(frames(), 'new-marker'); assert.equal(valid.usable, true); assert.deepEqual(valid.markerMatchIds, ['101']);
  const node = story('101', 'old'); node.attached_story = story('202', 'new-marker');
  const off = frames([{ node }]); off[0].data.other = { node: story('303', 'new-marker') };
  assert.deepEqual(inspectAuthWindow(off, 'new-marker').markerMatchIds, []);
  assert.deepEqual(inspectAuthWindow(frames([{ node: story('101', 'new-marker-extra') }]), 'new-marker').markerMatchIds, []);
});
test('only anchored main Story fragment qualifies', () => {
  const node = story('101', 'old'); node.comet_sections = { content: { story: { __typename: 'Story', id: node.id, message: { text: 'new-marker' } } } };
  assert.deepEqual(inspectAuthWindow(frames([{ node }]), 'new-marker').markerMatchIds, ['101']);
  node.comet_sections.content.story.id = 'unrelated-story';
  assert.deepEqual(inspectAuthWindow(frames([{ node }]), 'new-marker').markerMatchIds, []);
});

test('main content fragment may omit typename but must match identity without conflicts', () => {
  const node = story('101', 'old');
  const fragment: any = { id: node.id, post_id: node.post_id, message: { text: 'new-marker' } };
  node.comet_sections = { content: { story: fragment } };
  const inspect = () => inspectAuthWindow(frames([{ node }]), 'new-marker').markerMatchIds;
  assert.deepEqual(inspect(), ['101']);
  fragment.__typename = 'Comment'; assert.deepEqual(inspect(), []);
  delete fragment.__typename;
  fragment.id = 'different-story'; assert.deepEqual(inspect(), []);
  fragment.id = node.id; fragment.post_id = '202'; assert.deepEqual(inspect(), []);
  delete fragment.id; delete fragment.post_id; assert.deepEqual(inspect(), []);
});
test('a response larger than the requested five is not a verified five-post window', () => {
  const result = inspectAuthWindow(frames(Array.from({ length: 6 }, (_, i) => ({ node: story(String(101 + i)) }))), 'new-marker');
  assert.equal(result.usable, false);
  assert.equal(result.reasonCode, 'WINDOW_COUNT_EXCEEDED');
  assert.deepEqual(result.markerMatchIds, []);
});
test('no usable output before final frame, with critical error, wrong owner or unsupported scoped patch', () => {
  const pending = frames(); pending[0].extensions.is_final = false;
  assert.equal(inspectAuthWindow(pending).reasonCode, 'FINAL_FRAME_REQUIRED');
  assert.equal(inspectAuthWindow(frames([{ node: story('101', 'new-marker', '999') }])).usable, false);
  const errored = frames(); errored[0].errors = [{ message: 'Not logged in', path: ['user'] }];
  assert.equal(inspectAuthWindow(errored).reasonCode, 'CRITICAL_RESPONSE_ERROR');
  const patch = frames(); patch.unshift({ path: ['user', 'timeline_list_feed_units', 'edges', 0], data: story() });
  assert.equal(inspectAuthWindow(patch).reasonCode, 'UNVERIFIED_WINDOW');
});
