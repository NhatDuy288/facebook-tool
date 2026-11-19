import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readThroughBrowser } from './browser-read.ts';
import { QUERY_NAME, SOURCE_ID, SOURCE_URL } from './capture.ts';

test('browser transport captures only the current fetch and bounded cache evidence without an extra request', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    let reads = 0;
    const payload = JSON.stringify({ diagnostic: 'private-response-value' });
    // Every URL is intercepted; this test never accesses Facebook or a logged-in profile.
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/graphql/') {
        reads++;
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/json',
          date: 'Thu, 19 Nov 2026 03:00:19 GMT', age: '12', 'x-cache': 'HIT from private-proxy-host',
          'cache-control': 'private, no-store', 'set-cookie': 'private-cookie=1' }, body: payload });
      } else if (request.isNavigationRequest()) await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Read transport fixture</title>' });
      else await route.abort();
    });
    await page.goto(SOURCE_URL);
    await page.evaluate(async () => {
      // Fill the timeline before the measured read, as happens during a long monitoring session.
      performance.setResourceTimingBufferSize(1);
      await fetch('/api/graphql/', { method: 'POST', body: 'fixture=unrelated-before' });
    });
    const before = reads;
    const form = new URLSearchParams({ doc_id: '123', fb_api_req_friendly_name: QUERY_NAME,
      variables: JSON.stringify({ userID: SOURCE_ID }), __user: '10' });
    const response = await readThroughBrowser(page, form);
    assert.equal(reads, before + 1);
    assert.equal((await response.body()).toString(), payload);
    const d = response.transport!;
    assert.equal(d.requestCacheMode, 'no-store'); assert.equal(d.sharedCache, 'hit_or_stale_reported');
    assert.equal(d.ageSeconds, 12); assert.equal(d.resource.match, 'matched');
    assert.ok(d.headersMs! >= 0); assert.ok(d.bodyMs! >= 0);
    assert.doesNotMatch(JSON.stringify(d), /private-response-value|private-cookie|private-proxy-host|facebook|doc_id|__user/);
    await response.dispose();
    await assert.rejects(response.body(), /READ_FAILED/);
  } finally { await browser.close(); }
});
