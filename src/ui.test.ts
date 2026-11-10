import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { DEFAULT_CONFIG } from './config.ts';
import { READ_TARGETS, renderSourceOptions } from './facebook/feed/read-target.ts';

test('source selection stays consistent across refresh, save and baseline/start commands', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replaceAll('__TOOL_NONCE__', 'test').replaceAll('__SOURCE_OPTIONS__', renderSourceOptions());
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    for (const action of ['baseline', 'start']) {
      const page = await browser.newPage();
      let config = { ...DEFAULT_CONFIG, target: 'page' as const } as typeof DEFAULT_CONFIG;
      const calls: string[] = [];
      let rejectSave = false;
      await page.route('http://tool.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (path === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: app });
        if (path === '/api/status') return route.fulfill({ json: {
          config, phase: 'idle', note: '', account: null, source: READ_TARGETS[config.target], posts: [], jobs: [], logs: [],
          metrics: { reads: 0, queries: 0, decodedBytes: 0, lastQueryMs: null }, nextComment: '',
        } });
        if (path === '/api/config') {
          calls.push('save');
          if (rejectSave) return route.fulfill({ status: 400, json: { message: 'Không lưu được cấu hình' } });
          config = route.request().postDataJSON();
          return route.fulfill({ json: { config } });
        }
        if (path === '/api/command') {
          calls.push(route.request().postDataJSON().action + ':' + config.target);
          return route.fulfill({ json: {} });
        }
        return route.fulfill({ body: '' });
      });
      await page.goto('http://tool.test/');
      await page.waitForFunction(() => document.getElementById('saved')?.textContent === 'Đã lưu');
      assert.equal(await page.inputValue('#poll-seconds'), '2');
      assert.equal(await page.locator('#window-count').innerText(), '0 / 3');
      assert.equal(await page.locator('#baseline').innerText(), 'Lấy mốc 3 bài');
      await page.selectOption('#target', 'test-profile');
      assert.equal(await page.getAttribute('#source-url', 'href'), READ_TARGETS['test-profile'].url);
      await page.evaluate('refresh()');
      assert.equal(await page.inputValue('#target'), 'test-profile');
      assert.equal(await page.getAttribute('#source-url', 'href'), READ_TARGETS['test-profile'].url);
      const commanded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/command'
        && response.request().postDataJSON()?.action === action);
      await page.click('#' + action);
      await commanded;
      await page.waitForFunction('requestBusy === false');
      await page.waitForFunction(() => document.getElementById('saved')?.textContent === 'Đã lưu');
      assert.deepEqual(calls, ['save', action + ':test-profile']);

      // Saving errors must prevent starting with the old source.
      calls.length = 0; rejectSave = true;
      await page.selectOption('#target', 'page');
      await page.click('#' + action);
      await page.waitForFunction(() => document.getElementById('toast')?.textContent === 'Không lưu được cấu hình');
      assert.deepEqual(calls, ['save']);

      // The existing confirmation for public interactions remains required.
      calls.length = 0; rejectSave = false;
      await page.selectOption('#mode', 'live');
      page.once('dialog', dialog => dialog.dismiss());
      await page.click('#' + action);
      await page.evaluate('new Promise(resolve => setTimeout(resolve, 50))');
      assert.deepEqual(calls, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('timing tab measures from publication and only completes confirmed enabled actions', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replaceAll('__TOOL_NONCE__', 'test').replaceAll('__SOURCE_OPTIONS__', renderSourceOptions());
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
    const published = Date.parse('2026-11-09T02:46:00Z');
    const at = (seconds: number) => new Date(published + seconds * 1000).toISOString();
    const localAt = (seconds: number) => at(seconds + 236);
    const actionTime = (finished: number) => ({ version: 2, startedAt: localAt(5), finishedAt: localAt(finished),
      queueMs: 800, processingMs: (finished - 5) * 1000, fromDetectionMs: (finished - 4.2) * 1000,
      fromRequestMs: (finished - 4.2) * 1000, fromPublicationMs: finished * 1000, uncertaintyMs: 1100,
      preparation: { readRemainderMs: 600, dispatchWaitMs: 100, tabsMs: 100 },
      trace: { version: 1, finishedMs: (finished - 5) * 1000,
        milestones: { submitStarted: 4000, serverConfirmed: (finished - 6) * 1000 },
        steps: [{ stage: 'navigate_original_post', startMs: 0, endMs: 2000, status: 'completed' },
          { stage: 'wait_server', startMs: 2000, endMs: (finished - 6) * 1000, status: 'completed' },
          { stage: 'share_readback_verify', startMs: (finished - 6) * 1000, endMs: (finished - 5) * 1000, status: 'completed' }] } });
    const complete = {
      id: 'timing-example', sourceId: '123456789', mode: 'test', createdAt: localAt(4.2), origin: 'watch',
      timing: { version: 2, origin: 'watch', requestedAt: localAt(4.2), detectedAt: localAt(4.2), publicationDelayMs: 4200,
        uncertaintyMs: 1100, clockOffsetMs: -236000, readStartedAt: localAt(3), readCompletedAt: localAt(4.2),
        previousReadCompletedAt: localAt(-2), readDurationMs: 1200, readIntervalMs: 6200, pollWaitMs: 5000, pollSeconds: 5 },
      post: { post_id: '555555555', creation_time: published / 1000, permalink: null },
      plan: { comment: 'test', share: 'test' },
      actions: [
        { name: 'like', state: 'succeeded', startedAt: localAt(5), finishedAt: localAt(11.7), code: null, timing: actionTime(11.7) },
        { name: 'share', state: 'succeeded', startedAt: localAt(5), finishedAt: localAt(18.3), code: null, timing: actionTime(18.3) },
        { name: 'comment', state: 'succeeded', startedAt: localAt(5), finishedAt: localAt(18.8), code: null, timing: actionTime(18.8) },
      ],
    };
    const jobs = [complete,
      { ...complete, id: 'pending', actions: complete.actions.map(a => a.name === 'comment' ? { ...a, state: 'submitting', finishedAt: null } : a) },
      { ...complete, id: 'disabled', actions: complete.actions.map(a => a.name === 'comment' ? { ...a, state: 'skipped', finishedAt: null } : a) },
      { ...complete, id: 'manual', actions: complete.actions.map(a => a.name === 'comment' ? { ...a, code: 'MANUALLY_CONFIRMED' } : a) },
      { ...complete, id: 'failed', actions: complete.actions.map(a => a.name === 'share' ? { ...a, state: 'failed' } : a) },
      { ...complete, id: 'simulation', mode: 'dry-run', actions: complete.actions.map(a => ({ ...a, state: 'simulated', finishedAt: null })) },
      { ...complete, id: 'legacy', timing: null, actions: complete.actions.map(a => ({ ...a, timing: null })) },
      { ...complete, id: 'manual-existing', origin: 'existing-test', timing: { ...complete.timing, origin: 'existing-test', publicationDelayMs: null, detectedAt: null, clockOffsetMs: null } },
    ];
    await page.route('http://tool.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: app });
      if (path === '/style.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (path === '/api/status') return route.fulfill({ json: {
        config: DEFAULT_CONFIG, phase: 'watching', note: 'Đang theo dõi bài mới.', account: null,
        source: READ_TARGETS['test-profile'], posts: [], jobs, logs: [],
        metrics: { reads: 10, queries: 10, decodedBytes: 0, lastQueryMs: null }, nextComment: '',
      } });
      return route.fulfill({ body: '' });
    });
    await page.goto('http://tool.test/');
    await page.waitForFunction(() => document.getElementById('timing-count')?.textContent === '8 lượt xử lý');
    await page.click('#timing-tab');
    assert.equal(await page.locator('#overview-panel').isVisible(), false);
    assert.equal(await page.locator('#timing-tab').getAttribute('aria-selected'), 'true');
    const rows = page.locator('#timing-rows > .timing-job-row');
    const first = rows.nth(0).locator('td');
    assert.equal(await first.nth(2).innerText(), '≈ 4,2 giây');
    assert.match(await first.nth(3).innerText(), /^≈ 11,7 giây/);
    assert.match(await first.nth(4).innerText(), /^≈ 18,3 giây/);
    assert.match(await first.nth(5).innerText(), /^≈ 18,8 giây/);
    assert.equal(await first.nth(6).innerText(), '≈ 18,8 giây\nComment xong cuối');
    assert.equal(await rows.nth(1).locator('td').last().innerText(), '—\nĐang xử lý');
    assert.equal(await rows.nth(2).locator('td').last().innerText(), '≈ 18,3 giây\nShare xong cuối');
    assert.equal(await rows.nth(3).locator('td').last().innerText(), '—\nThiếu dữ liệu đo');
    assert.equal(await rows.nth(4).locator('td').last().innerText(), '—\nChưa hoàn tất');
    assert.equal(await rows.nth(5).locator('td').last().innerText(), '—\nChỉ ghi nhận');
    assert.equal(await rows.nth(6).locator('td').nth(2).innerText(), 'Thiếu dữ liệu đo');
    assert.equal(await rows.nth(6).locator('td').last().innerText(), '—\nThiếu dữ liệu đo');
    assert.equal(await rows.nth(7).locator('td').nth(2).innerText(), 'Thử bài có sẵn');
    assert.equal(await rows.nth(7).locator('td').last().innerText(), '—\nThử bài có sẵn');
    assert.equal(await page.locator('.timing-slowest').count(), 2);
    const invalid = await page.evaluate(job => (window as any).timingForJob(job), { ...complete,
      timing: { ...complete.timing, publicationDelayMs: null }, actions: complete.actions.map(a => ({ ...a, timing: { ...a.timing, fromPublicationMs: null } })) });
    assert.equal(invalid.detection, null);
    assert.equal(invalid.total, null);
    await page.locator('.timing-diagnostics summary').first().click();
    assert.match(await page.locator('.timing-diagnostics').first().innerText(), /Giờ máy nhanh hơn Facebook 3 phút 56 giây/);
    assert.doesNotMatch(await page.locator('.timing-diagnostics').first().innerText(), /Sai số|±/);
    const trace = page.locator('.timing-diagnostics').first().locator('.action-trace[data-action="share"]');
    assert.match(await trace.innerText(), /Facebook xác nhận\n≈ 17,3 giây từ lúc đăng/);
    assert.match(await trace.innerText(), /Tool xác minh xong\n≈ 18,3 giây từ lúc đăng/);
    assert.match(await trace.innerText(), /Từ phản hồi Facebook đến xác minh xong: 1 giây/);
    assert.equal(await trace.locator('.trace-table tbody tr').count(), 3);
    assert.equal(await trace.locator('.trace-longest').count(), 1);
    assert.match(await trace.locator('.trace-longest').innerText(), /Chờ và đọc phản hồi Facebook/);
    const acknowledgement = await page.evaluate(input => {
      const job: any = structuredClone(input), comment = job.actions.find((a: any) => a.name === 'comment');
      comment.timing.trace.milestones.serverAcknowledged = comment.timing.trace.milestones.serverConfirmed;
      delete comment.timing.trace.milestones.serverConfirmed;
      const view = (window as any).renderActionTrace('comment', (window as any).timingForJob(job));
      return view.querySelector('.trace-milestones').textContent;
    }, complete);
    assert.match(acknowledgement, /Facebook phản hồi · cần kiểm tra/);
    assert.doesNotMatch(acknowledgement, /Facebook xác nhận/);
    const unverified = await page.evaluate(input => {
      const job: any = structuredClone(input); job.actions.find((a: any) => a.name === 'share').state = 'unknown';
      return (window as any).renderActionTrace('share', (window as any).timingForJob(job)).querySelector('.trace-milestones').textContent;
    }, complete);
    assert.match(unverified, /Tool xác minh xong—/);
    await page.evaluate(() => (window as any).refresh());
    assert.equal(await page.locator('.timing-diagnostics').first().getAttribute('open'), '');
    assert.match(await page.locator('.timing-diagnostics').nth(6).textContent() || '', /chưa có dữ liệu đo từng bước/);
    await trace.screenshot({ path: 'data/timing-steps-preview.png' });
    assert.equal(await page.evaluate(() => (window as any).secondsText(244)), '4 phút 4 giây');
    await page.screenshot({ path: 'data/timing-preview.png', fullPage: true });
    await page.locator('#timing-tab').focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#overview-panel').isVisible(), true);
    const likeCard = page.locator('#jobs > .job').first().locator('.action-result').first();
    assert.match(await likeCard.innerText(), /Xử lý thao tác: 6,7 giây/);
    assert.match(await likeCard.innerText(), /Từ lúc đăng: ≈ 11,7 giây/);
  } finally { await browser.close(); }
});
