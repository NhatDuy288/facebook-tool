import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { SOURCE_ID, SOURCE_URL, FB_ORIGIN } from './capture.ts';
import type { ObservedContinuation } from './observed-query-store.ts';
import { readCompleteWindow, scopedPageInfo } from './read-complete-window.ts';

function template(): ObservedContinuation {
  const variables = { id: SOURCE_ID, count: 3, stream_count: 1, cursor: 'observed-old-cursor', omitPinnedPost: false };
  const friendlyName = 'ProfileCometTimelineFeedRefetchQuery';
  return { endpoint: FB_ORIGIN + '/api/graphql/', friendlyName, variables, authenticated: true, responseVerified: true,
    artifact: { operationMatched: true, headCursorNullAllowed: true, cursorArgumentName: 'cursor', countFeedsFirst: true, cursorFeedsAfter: true },
    form: new URLSearchParams({ doc_id: '123456', fb_api_req_friendly_name: friendlyName, variables: JSON.stringify(variables), __user: '111111111' }) };
}
function head(t = template(), count: 3 | 5 = 5) { return new URLSearchParams({ doc_id: '123456', fb_api_req_friendly_name: t.friendlyName,
  variables: JSON.stringify({ ...t.variables, count, stream_count: count, cursor: null }), __user: '111111111', fb_dtsg: 'fresh-secret' }); }
function records(ids: string[], cursor = 'actual-fresh-end', hasNext = true, markerID?: string): any[] {
  return [{ data: { node: { id: SOURCE_ID, timeline_list_feed_units: { edges: ids.map((id, i) => ({ node: {
    __typename: 'Story', id: `story-${id}`, post_id: id, creation_time: 1793850629 - Number(id), actors: [{ id: SOURCE_ID }],
    message: { text: id === markerID ? 'fresh-marker' : 'old' } } })), page_info: { has_next_page: hasNext, end_cursor: cursor } } } },
    extensions: { is_final: true } }];
}
function fakePage(batches: any[][], after?: (index: number) => void, sourceUrl: string = SOURCE_URL,
  evidence?: Array<{ date?: string; timing?: { requestStartedAt: number; headersReceivedAt: number } }>) {
  const sent: URLSearchParams[] = [];
  const page = { url: () => sourceUrl, evaluate: async (_fn: unknown, args: any) => {
    const index = sent.length; sent.push(new URLSearchParams(args.formText)); after?.(index);
    if (!batches[index]) throw Error('unexpected-request');
    return { kind: 'response', status: 200, date: 'Fri, 06 Nov 2026 07:00:00 GMT',
      ...evidence?.[index],
      bodyBase64: Buffer.from(JSON.stringify(batches[index])).toString('base64') };
  } } as unknown as Page;
  return { page, sent };
}
test('logical five uses fresh actual main cursor in exactly two sequential batches and no cursor output', async () => {
  const t = template(), { page, sent } = fakePage([records(['1', '2', '3']), records(['4', '5'], 'next-private-cursor', false, '4')]);
  const result = await readCompleteWindow(page, head(t), { observedTemplate: t, marker: 'fresh-marker' });
  assert.equal(result.usable, true); assert.deepEqual(result.posts.map(p => p.post_id), ['1', '2', '3', '4', '5']);
  assert.deepEqual(result.markerMatchIds, ['4']); assert.equal(result.queryPOSTsIssued, 2);
  assert.equal(result.batches[0].serverSeconds, Date.parse('Fri, 06 Nov 2026 07:00:00 GMT') / 1000);
  const second = JSON.parse(sent[1].get('variables')!);
  assert.equal(second.cursor, 'actual-fresh-end'); assert.equal(second.count, 2); assert.equal(second.stream_count, 2);
  assert.equal(sent[1].get('fb_dtsg'), 'fresh-secret'); assert.equal(result.batches[1].returnedPostCount, 2);
  assert.equal(JSON.stringify(result).includes('actual-fresh-end'), false); assert.equal(JSON.stringify(result).includes('fresh-secret'), false);
});

test('three-post head requests exactly three, ignores off-feed/attached featured items and does not expand false flags', async () => {
  const t = template(), data = records(['1', '2', '3']);
  const main = data[0].data.node.timeline_list_feed_units.edges[0].node;
  main.is_pinned = false; main.is_featured = false;
  main.attached_story = { __typename: 'Story', post_id: '99', creation_time: 1794217905, is_featured: true, actors: [{ id: SOURCE_ID }] };
  data[0].data.featured = { node: { ...main, post_id: '98', is_featured: true } };
  const { page, sent } = fakePage([data]);
  const result = await readCompleteWindow(page, head(t, 3), { observedTemplate: t, windowSize: 3, expandOnRisk: true });
  assert.equal(result.usable, true); assert.equal(result.queryPOSTsIssued, 1);
  assert.deepEqual(result.posts.map(p => p.post_id), ['1', '2', '3']);
  assert.equal(result.windowSize, 3); assert.equal(result.expansionReason, null);
  assert.equal(JSON.parse(sent[0].get('variables')!).count, 3);
  assert.equal(JSON.parse(sent[0].get('variables')!).stream_count, 3);
  assert.equal(result.actualNewestFiveGuaranteed, false, 'response order is never a claim about the entire feed');
});

test('pin or featured evidence extends the same verified cursor chain to five with at most two requests', async () => {
  for (const flag of ['is_pinned', 'is_featured']) {
    const t = template(), first = records(['1', '2', '3']);
    first[0].data.node.timeline_list_feed_units.edges[0].node[flag] = true;
    const { page, sent } = fakePage([first, records(['4', '5'], 'next', false)]);
    const result = await readCompleteWindow(page, head(t, 3), { observedTemplate: t, windowSize: 3, expandOnRisk: true });
    assert.equal(result.usable, true); assert.equal(result.windowSize, 5); assert.equal(result.expansionReason, 'promotion_evidence');
    assert.equal(sent.length, 2);
    const followup = JSON.parse(sent[1].get('variables')!);
    assert.equal(followup.count, 2); assert.equal(followup.stream_count, 2); assert.equal(followup.cursor, 'actual-fresh-end');
    assert.deepEqual(result.posts.map(p=>p.post_id), ['1','2','3','4','5']);
  }
});

test('old reordered item cannot hide a single fresh main-feed post within the bounded extended read', async () => {
  const t = template(), first = records(['1', '2', '3']), second = records(['4', '5'], 'next', false);
  first[0].data.node.timeline_list_feed_units.edges[0].node.creation_time -= 10000;
  second[0].data.node.timeline_list_feed_units.edges[0].node.creation_time += 20000;
  const { page, sent } = fakePage([first, second]);
  const result = await readCompleteWindow(page, head(t, 3), { observedTemplate: t, windowSize: 3, expandOnRisk: true });
  assert.equal(result.usable, true); assert.equal(result.expansionReason, 'non_chronological');
  assert.ok(result.posts.some(p=>p.post_id==='4')); assert.equal(sent.length, 2);
  assert.equal(result.posts[0].post_id, '1', 'transport retains actual order; display sorting cannot manufacture coverage');
});

test('uncertain three-post coverage never invents a cursor or accepts an incomplete expansion', async () => {
  const t = template(), first = records(['1', '2', '3'], '', true);
  first[0].data.node.timeline_list_feed_units.edges[0].node.is_featured = true;
  first[0].data.featured = { page_info: { has_next_page: true, end_cursor: 'unrelated-cursor' } };
  const missing = fakePage([first]);
  const rejected = await readCompleteWindow(missing.page, head(t, 3), { observedTemplate: t, windowSize: 3, expandOnRisk: true });
  assert.equal(rejected.usable, false); assert.equal(rejected.reasonCode, 'BASELINE_INCOMPLETE'); assert.equal(missing.sent.length, 1);
  const pending = records(['1', '2', '3']); pending[0].data.node.timeline_list_feed_units.edges[0].node.is_pinned = true;
  const short = fakePage([pending, records(['4'], 'next', true)]);
  const incomplete = await readCompleteWindow(short.page, head(t, 3), { observedTemplate: t, windowSize: 3, expandOnRisk: true });
  assert.equal(incomplete.usable, false); assert.equal(incomplete.reasonCode, 'BASELINE_INCOMPLETE'); assert.equal(short.sent.length, 2);
});

test('publication delay cancels a four-minute PC clock skew and includes download/validation time', async t => {
  const serverMs = Date.parse('Mon, 09 Nov 2026 02:42:23 GMT'), skewMs = 240_000;
  const observedMs = serverMs + skewMs + 1_100;
  t.mock.method(Date, 'now', () => observedMs);
  const data = records(['1', '2', '3', '4', '5']);
  for (const edge of data[0].data.node.timeline_list_feed_units.edges) edge.node.creation_time = serverMs / 1000 - 3;
  const { page } = fakePage([data], undefined, SOURCE_URL, [{ date: new Date(serverMs).toUTCString(),
    timing: { requestStartedAt: serverMs + skewMs, headersReceivedAt: serverMs + skewMs + 200 } }]);
  const result = await readCompleteWindow(page, head(), { observedTemplate: template() });
  const observation = result.observations['1'];
  assert.equal(result.usable, true);
  assert.equal(observation.observedAt, new Date(observedMs).toISOString());
  assert.equal(observation.clockSource, 'facebook-response');
  assert.equal(observation.clockOffsetMs, -239_600);
  assert.equal(observation.uncertaintyMs, 600);
  assert.equal(observation.publicationDelayMs, 4_500);
  assert.equal(typeof observation.observedMonoMs, 'number');
  // The former subtraction reports 244.1s for this same observation.
  assert.equal(observedMs - data[0].data.node.timeline_list_feed_units.edges[0].node.creation_time * 1000, 244_100);
});

test('continuation retains each post first verification time and calibrates against its own response', async t => {
  const serverMs = Date.parse('Mon, 09 Nov 2026 02:42:23 GMT'), skewMs = 240_000;
  let observedMs = serverMs + skewMs + 1_100;
  t.mock.method(Date, 'now', () => observedMs);
  const first = records(['1', '2', '3']), second = records(['4', '5'], 'next', false);
  for (const data of [first, second])
    for (const edge of data[0].data.node.timeline_list_feed_units.edges) edge.node.creation_time = serverMs / 1000 - 3;
  const { page } = fakePage([first, second], index => {
    if (index === 1) observedMs = serverMs + skewMs + 9_100;
  }, SOURCE_URL, [0, 8_000].map(delta => ({ date: new Date(serverMs + delta).toUTCString(),
    timing: { requestStartedAt: serverMs + skewMs + delta, headersReceivedAt: serverMs + skewMs + delta + 200 } })));
  const result = await readCompleteWindow(page, head(), { observedTemplate: template() });
  assert.equal(result.usable, true);
  assert.equal(result.firstSeenAt, new Date(serverMs + skewMs + 1_100).toISOString());
  assert.equal(result.observations['1'].observedAt, result.firstSeenAt);
  assert.equal(result.observations['1'].publicationDelayMs, 4_500);
  assert.equal(result.observations['4'].observedAt, new Date(serverMs + skewMs + 9_100).toISOString());
  assert.equal(result.observations['4'].publicationDelayMs, 12_500);
  assert.equal(result.observations['4'].clockOffsetMs, -239_600);
});

test('missing or invalid time evidence never falls back to skewed PC publication deltas', async t => {
  const serverMs = Date.parse('Mon, 09 Nov 2026 02:42:23 GMT'), local = serverMs + 240_000;
  t.mock.method(Date, 'now', () => local + 1_100);
  const validTiming = { requestStartedAt: local, headersReceivedAt: local + 200 };
  for (const evidence of [
    { date: new Date(serverMs).toUTCString() },
    { date: undefined, timing: validTiming },
    { date: '2026-11-09', timing: validTiming },
    { date: 'Mon, 32 Nov 2026 02:42:23 GMT', timing: validTiming },
    { date: new Date(serverMs).toUTCString(), timing: { requestStartedAt: local + 300, headersReceivedAt: local } },
    { date: new Date(serverMs).toUTCString(), timing: { requestStartedAt: local, headersReceivedAt: local + 2_000 } },
  ]) {
    const { page } = fakePage([records(['1', '2', '3', '4', '5'])], undefined, SOURCE_URL, [evidence]);
    const result = await readCompleteWindow(page, head(), { observedTemplate: template() });
    assert.equal(result.observations['1'].publicationDelayMs, null);
    assert.equal(result.observations['1'].clockSource, 'unavailable');
    assert.equal(result.observations['1'].clockOffsetMs, null);
    assert.equal(result.observations['1'].uncertaintyMs, null);
  }
});

test('future publication timestamps are unknown instead of negative or clamped-to-zero delays', async t => {
  const serverMs = Date.parse('Mon, 09 Nov 2026 02:42:23 GMT'), local = serverMs + 240_000;
  t.mock.method(Date, 'now', () => local + 1_100);
  const data = records(['1', '2', '3', '4', '5']);
  data[0].data.node.timeline_list_feed_units.edges[0].node.creation_time = serverMs / 1000 + 60;
  const { page } = fakePage([data], undefined, SOURCE_URL, [{ date: new Date(serverMs).toUTCString(),
    timing: { requestStartedAt: local, headersReceivedAt: local + 200 } }]);
  const result = await readCompleteWindow(page, head(), { observedTemplate: template() });
  assert.equal(result.observations['1'].publicationDelayMs, null);
  assert.equal(result.observations['1'].clockSource, 'facebook-response');
});
test('server extra returned post is validated but selected count remains only current five', async () => {
  const { page } = fakePage([records(['1', '2', '3']), records(['4', '5', '6'], 'next', false)]);
  const result = await readCompleteWindow(page, head(), { observedTemplate: template() });
  assert.equal(result.usable, true); assert.equal(result.batches[1].returnedPostCount, 3);
  assert.equal(result.batches[1].selectedPostCount, 2); assert.equal(result.posts.length, 5);
});
test('missing main cursor, unrelated cursor and short final page never invent a third batch', async () => {
  const noCursor = records(['1', '2', '3'], '', true); noCursor[0].data.viewer = { page_info: { end_cursor: 'off-feed-secret', has_next_page: true } };
  const first = fakePage([noCursor]);
  const missing = await readCompleteWindow(first.page, head(), { observedTemplate: template() });
  assert.equal(missing.reasonCode, 'BASELINE_INCOMPLETE'); assert.equal(first.sent.length, 1);
  const short = fakePage([records(['1', '2', '3']), records(['4'], 'next', true)]);
  const incomplete = await readCompleteWindow(short.page, head(), { observedTemplate: template() });
  assert.equal(incomplete.reasonCode, 'BASELINE_INCOMPLETE'); assert.equal(short.sent.length, 2);
  assert.equal(scopedPageInfo(noCursor).endCursor, null);
});
test('overlap, conflicting metadata and invalid second response fail with actual per-batch evidence', async () => {
  const overlap = fakePage([records(['1', '2', '3']), records(['3', '4'], 'next', false)]);
  assert.equal((await readCompleteWindow(overlap.page, head(), { observedTemplate: template() })).reasonCode, 'WINDOW_CHAIN_OVERLAP');
  const conflictRecords = records(['3', '4']); conflictRecords[0].data.node.timeline_list_feed_units.edges[0].node.creation_time++;
  const conflict = fakePage([records(['1', '2', '3']), conflictRecords]);
  assert.equal((await readCompleteWindow(conflict.page, head(), { observedTemplate: template() })).reasonCode, 'WINDOW_CHAIN_CONFLICT');
  const bad = records(['4', '5']); bad[0].errors = [{ message: 'Not logged in' }];
  const invalid = fakePage([records(['1', '2', '3']), bad]);
  const result = await readCompleteWindow(invalid.page, head(), { observedTemplate: template() });
  assert.equal(result.usable, false); assert.equal(result.queryPOSTsIssued, 2); assert.equal(result.batches.length, 2);
  assert.equal(result.batches[1].reasonCode, 'CRITICAL_RESPONSE_ERROR'); assert.deepEqual(result.markerMatchIds, []);
});
test('abort prevents continuation request; direct five needs only one batch', async () => {
  const abort = new AbortController(), stopped = fakePage([records(['1', '2', '3'])], () => abort.abort());
  const result = await readCompleteWindow(stopped.page, head(), { observedTemplate: template(), signal: abort.signal });
  assert.equal(result.reasonCode, 'READ_ABORTED'); assert.equal(stopped.sent.length, 1);
  const complete = fakePage([records(['1', '2', '3', '4', '5'])]);
  assert.equal((await readCompleteWindow(complete.page, head(), { observedTemplate: template() })).queryPOSTsIssued, 1);
});

test('Example Page uses its own verified identity and cannot consume the test-profile template or URL', async () => {
  const id = '987654321', url = 'https://www.facebook.com/examplepage';
  const t = template(); t.variables.id = id; t.form.set('variables', JSON.stringify(t.variables));
  const data = JSON.parse(JSON.stringify(records(['1', '2', '3', '4', '5'])).replaceAll(SOURCE_ID, id));
  const live = fakePage([data], undefined, url);
  const result = await readCompleteWindow(live.page, head(t), { observedTemplate: t, target: 'page' });
  assert.equal(result.usable, true); assert.equal(result.posts.length, 5);
  assert.equal(result.posts.every(p => p.sourceVerification === 'canonical_profile_main_actor_id'), true);
  const wrongTemplate = fakePage([data], undefined, url);
  await assert.rejects(readCompleteWindow(wrongTemplate.page, head(), { observedTemplate: template(), target: 'page' }), /HEAD_QUERY_UNVERIFIED/);
  assert.equal(wrongTemplate.sent.length, 0);
  const wrongUrl = fakePage([data]);
  await assert.rejects(readCompleteWindow(wrongUrl.page, head(t), { observedTemplate: t, target: 'page' }), /SOURCE_PAGE_UNAVAILABLE/);
  assert.equal(wrongUrl.sent.length, 0);
});
