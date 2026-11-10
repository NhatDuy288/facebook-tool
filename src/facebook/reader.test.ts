import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { FacebookReader } from './reader.ts';
import { BrowserSession } from './browser.ts';
import { READ_TARGETS } from './feed/read-target.ts';

function fixture(expanded: boolean) {
  const source = READ_TARGETS['test-profile'], sent: URLSearchParams[] = [];
  const records = (ids: string[]) => [{ data: { node: { id: source.sourceId, timeline_list_feed_units: {
    edges: ids.map(id => ({ node: { __typename: 'Story', id: 'story-' + id, post_id: id,
      creation_time: expanded && id === '4' ? 1794217999 : 1794217900 - Number(id), actors: [{ id: source.sourceId }],
      ...(expanded && id === '1' ? { is_pinned: true } : {}) } })),
    page_info: { has_next_page: true, end_cursor: 'actual-source-cursor' } } } }, extensions: { is_final: true } }];
  const page = { isClosed: () => false, url: () => source.url, evaluate: async (_fn: unknown, args: any) => {
    if (Array.isArray(args)) return { __user: '10', fb_dtsg: 'fresh-test-value' };
    if (args?.formText) {
      const index = sent.length; sent.push(new URLSearchParams(args.formText));
      return { kind: 'response', status: 200, date: 'Mon, 09 Nov 2026 10:00:00 GMT',
        bodyBase64: Buffer.from(JSON.stringify(records(index ? ['4','5'] : ['1','2','3']))).toString('base64') };
    }
    return { id: '10', userId: '10', personal: true, name: 'Test' };
  } } as unknown as Page;
  const session = new BrowserSession(); session.sourcePage = async () => page;
  const reader = new FacebookReader(session); reader.account = { id: '10', name: 'Test' };
  const variables = { id: source.sourceId, count: 8, stream_count: 1, cursor: 'captured-old-cursor' };
  reader.template = { endpoint: 'https://www.facebook.com/api/graphql/', friendlyName: 'ProfileCometTimelineFeedRefetchQuery',
    variables, form: new URLSearchParams({ __user: '10', doc_id: '123456', fb_api_req_friendly_name: 'ProfileCometTimelineFeedRefetchQuery', variables: JSON.stringify(variables) }),
    authenticated: true, responseVerified: true, artifact: { operationMatched: true, headCursorNullAllowed: true,
      cursorArgumentName: 'cursor', countFeedsFirst: true, cursorFeedsAfter: true } };
  return { reader, sent };
}

test('production reader sends three to Facebook and displays only source-verified posts', async () => {
  const { reader, sent } = fixture(false), result = await reader.read(new AbortController().signal);
  assert.equal(result.usable, true); assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].get('variables')!).count, 3); assert.equal(JSON.parse(sent[0].get('variables')!).stream_count, 3);
  assert.equal(sent[0].get('fb_dtsg'), 'fresh-test-value');
  assert.equal(result.posts.length, 3); assert.equal(result.verifiedPosts!.length, 3);
  assert.deepEqual(result.windowPolicy, { requestedCount: 3, verifiedCount: 3, expanded: false, expansionReason: null });
});

test('expanded reader retains all verified posts for detection while displaying three ordered by original publication time', async () => {
  const { reader, sent } = fixture(true), result = await reader.read(new AbortController().signal);
  assert.equal(result.usable, true); assert.equal(sent.length, 2);
  assert.equal(JSON.parse(sent[1].get('variables')!).count, 2);
  assert.equal(result.posts.length, 3); assert.equal(result.posts[0].post_id, '4');
  assert.deepEqual(result.verifiedPosts!.map(p=>p.post_id), ['1','2','3','4','5']);
  assert.deepEqual(result.windowPolicy, { requestedCount: 3, verifiedCount: 5, expanded: true, expansionReason: 'promotion_evidence' });
  assert.ok(result.observations!['4'], 'timing evidence of the fresh post survives display selection');
});
