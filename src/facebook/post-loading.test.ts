import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { loadingFixture } from './post-loading.fixture.ts';
import { PostLoader, postReadyProbe, CONTENT_MEDIA_URLS } from './post-loading.ts';

test('media filtering preserves real HTTP cache, including after a temporary write guard', { timeout: 20_000 }, async () => {
  const fixture = await loadingFixture(), browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext(), warmup = await context.newPage();
    await warmup.goto(fixture.origin + '/post', { waitUntil: 'load' });
    const page = await context.newPage();
    const loader = new PostLoader({ blockedUrls: fixture.blockedUrls });
    const expected = { postId: '30', sourceId: '20', actorId: '10', need: 'actions' as const, origin: fixture.origin };
    await loader.load(page, fixture.origin + '/post?second', expected);
    assert.deepEqual(await page.evaluate(postReadyProbe, expected), { feedbackIds: ['feedback-30'] });
    await page.waitForLoadState('load');
    for (const path of ['/critical.js', '/styles.css', '/icon.svg']) assert.equal(fixture.hits.get(path), 1, path + ' must remain cached');
    for (const path of ['/photo.svg', '/video.bin']) assert.equal(fixture.hits.get(path), 1, path + ' must be blocked after warmup');
    const metrics = loader.diagnostics(page) as any;
    assert.ok(metrics.blocked >= 2); assert.ok(metrics.cacheHits >= 3); assert.equal(metrics.fallback, false);
    const guard = async (route: import('playwright-core').Route) => { await route.continue(); };
    await page.route(fixture.origin + '/write', guard);
    await page.evaluate(() => fetch('/write', { method: 'POST' }));
    await page.unroute(fixture.origin + '/write', guard);
    await loader.load(page, fixture.origin + '/post?third', expected);
    await page.waitForLoadState('load');
    for (const path of ['/critical.js', '/styles.css', '/icon.svg']) assert.equal(fixture.hits.get(path), 1, path + ' cache restored after unroute');
    assert.ok(!CONTENT_MEDIA_URLS.some(pattern => pattern.includes('static.')));
  } finally { await browser.close(); await fixture.close(); }
});

test('readiness waits for verified controls, rejects wrong actor/source and aborts its own page', { timeout: 15_000 }, async () => {
  const fixture = await loadingFixture(), browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext(), loader = new PostLoader({ blockedUrls: fixture.blockedUrls });
    const expected = { postId: '30', sourceId: '20', actorId: '10', need: 'actions' as const, origin: fixture.origin };
    const page = await context.newPage();
    await loader.load(page, fixture.origin + '/post?ready=180', expected);
    assert.equal(await page.getByRole('button', { name: 'Like', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').map(e => (e as PerformanceNavigationTiming).domContentLoadedEventEnd)[0]), 0, 'unrelated deferred script must not delay verified controls');
    await assert.rejects(loader.load(page, fixture.origin + '/post?actor=11', expected), /ACTOR_CHANGED/);
    await assert.rejects(loader.load(page, fixture.origin + '/post?owner=21', expected), /POST_UNVERIFIED/);
    const other = await context.newPage(), controller = new AbortController();
    const loading = loader.load(page, fixture.origin + '/post?ready=10000', expected, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(loading); assert.equal(page.isClosed(), true); assert.equal(other.isClosed(), false);
  } finally { await browser.close(); await fixture.close(); }
});

test('filtered readiness timeout retries unfiltered and keeps later navigation diagnostics accurate', { timeout: 25_000 }, async () => {
  const fixture = await loadingFixture(), browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    fixture.requireMedia(true);
    const page = await browser.newPage(), loader = new PostLoader({ blockedUrls: fixture.blockedUrls });
    const expected = { postId: '30', sourceId: '20', actorId: '10', need: 'actions' as const, origin: fixture.origin };
    await loader.load(page, fixture.origin + '/post', expected);
    assert.equal(await page.getByRole('button', { name: 'Like', exact: true }).count(), 1);
    assert.equal((loader.diagnostics(page) as any).fallback, true);
    await loader.load(page, fixture.origin + '/post?again', expected);
    assert.equal((loader.diagnostics(page) as any).mediaFilter, false);
    assert.equal((loader.diagnostics(page) as any).fallback, false);
  } finally { await browser.close(); await fixture.close(); }
});
