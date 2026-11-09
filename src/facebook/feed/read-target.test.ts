import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesReadTargetUrl } from './read-target.ts';
import type { Page } from 'playwright-core';
import { readThroughBrowser } from './browser-read.ts';
import type { ObservedContinuation } from './observed-query-store.ts';
test('read targets allow only their exact Facebook source and a single valid locale', () => {
  assert.equal(matchesReadTargetUrl('https://www.facebook.com/examplepage', 'page'), true);
  assert.equal(matchesReadTargetUrl('https://www.facebook.com/examplepage/?locale=vi_VN', 'page'), true);
  for (const value of ['https://www.facebook.com/otherpage', 'https://example.com/examplepage',
    'https://www.facebook.com/examplepage?locale=vi_VN&locale=en_US', 'https://www.facebook.com/examplepage#x',
    'https://www.facebook.com/examplepage?next=anything', 'https://www.facebook.com/profile.php?id=123456789'])
    assert.equal(matchesReadTargetUrl(value, 'page'), false);
  assert.equal(matchesReadTargetUrl('https://www.facebook.com/examplepage', 'test-profile'), false);
});

test('Example Page transport refuses operation or actor substitutions before browser execution', async () => {
  let calls = 0;
  const page = { url: () => 'https://www.facebook.com/examplepage', evaluate: async () => { calls++; throw Error('unexpected'); } } as unknown as Page;
  const form = new URLSearchParams({ doc_id: '123', fb_api_req_friendly_name: 'ProfileCometTimelineFeedRefetchQuery',
    __user: '789', variables: JSON.stringify({ id: '987654321', cursor: 'observed', count: 3 }) });
  const observed: ObservedContinuation = { endpoint: 'https://www.facebook.com/api/graphql/', friendlyName: form.get('fb_api_req_friendly_name')!,
    form, variables: JSON.parse(form.get('variables')!), authenticated: true, responseVerified: true,
    artifact: { operationMatched: true, headCursorNullAllowed: true, cursorArgumentName: 'cursor', countFeedsFirst: true, cursorFeedsAfter: true } };
  for (const [field, value] of [['doc_id', '999'], ['__user', '456'], ['fb_api_req_friendly_name', 'ProfileCometTimelineFeedQuery']]) {
    const changed = new URLSearchParams(form); changed.set(field, value);
    await assert.rejects(readThroughBrowser(page, changed, { target: 'page', observedTemplate: observed }), /INITIAL_QUERY_UNAVAILABLE/);
  }
  assert.equal(calls, 0);
});
