import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { BrowserSession } from './browser.ts';
import { FacebookActions } from './actions.ts';
import { DEFAULT_CONFIG, planContent } from '../config.ts';
import type { Job } from '../types.ts';

const controls = `<title>Tool background worker test</title><label>Message<input aria-label="Message"></label>
  <button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button>
  <output></output><script>document.querySelector('input').onkeydown=e=>{if(e.key==='Enter')document.querySelector('output').textContent='entered'}</script>`;
const reconciliationHtml = `<script>globalThis.require=name=>name==='CurrentUserInitialData'
  ?{USER_ID:'10',ACCOUNT_ID:'10',NAME:'Test'}:name==='getAsyncParams'?()=>({__user:'10'}):null</script>
  <script type="application/json">{"__typename":"Story","post_id":"30","actors":[{"id":"20"}],"feedback":{"owning_profile":{"id":"20"}}}</script>
  <div role="dialog"><h1>Bài viết của Test</h1><button aria-label="Unlike">Unlike</button></div>`;
const reconciliationJob: Job = {
  id: 'background-reconciliation', sessionId: 'background-session', accountId: '10', sourceId: '20',
  post: { post_id: '30', creation_time: 10, permalink: null, sourceVerification: 'owner' },
  mode: 'test', createdAt: new Date().toISOString(), plan: planContent(DEFAULT_CONFIG, 0), actions: [],
};

async function fixture(headless = true, persistent = false) {
  const profile = persistent ? await mkdtemp(join(resolve(tmpdir()), 'facebook-background-test-')) : undefined;
  const persistentContext = profile ? await chromium.launchPersistentContext(profile,
    { channel: 'chrome', headless, viewport: null }) : undefined;
  const browser = persistentContext?.browser() || await chromium.launch({ channel: 'chrome', headless });
  const context = persistentContext || await browser.newContext({ viewport: null });
  // No test may contact Facebook or any other remote site.
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: new URL(route.request().url()).hostname === 'www.facebook.com' ? reconciliationHtml : controls }));
  const session = new BrowserSession();
  session.browser = browser;
  session.context = context;
  session.dashboard = context.pages()[0] || await context.newPage();
  await session.dashboard.goto('http://background.test/dashboard');
  return { browser, context, session, profile };
}

async function targetInfo(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  try { return (await cdp.send('Target.getTargetInfo')).targetInfo; }
  finally { await cdp.detach(); }
}

async function interact(page: Page, value: string) {
  await page.goto('http://background.test/controls');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(viewport.width > 400 && viewport.height > 200, 'background tabs retain a usable rendering area');
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill(value);
  await input.press('Enter');
  assert.equal(await page.locator('output').textContent(), 'entered');
  await page.getByRole('button', { name: 'Save' }).click();
  assert.equal(await page.locator('output').textContent(), value);
}

test('concurrent background tabs belong to the exact context and retain its session', { timeout: 30_000 }, async () => {
  const { browser, context, session } = await fixture();
  try {
    await context.addCookies([{ name: 'background-session', value: 'own-context', url: 'http://background.test/' }]);
    const foreignContext = await browser.newContext();
    const foreignPage = await foreignContext.newPage();
    const owner = await targetInfo(context, session.dashboard);
    const cdp = await browser.newBrowserCDPSession();
    // An unrelated target races the requests. A generic first-page/last-page adoption is incorrect.
    const unrelated = cdp.send('Target.createTarget', { url: 'about:blank#unrelated', background: true,
      browserContextId: owner.browserContextId });
    const pages = await Promise.all(Array.from({ length: 6 }, () => session.newBackgroundPage()));
    const unrelatedId = (await unrelated).targetId;
    await cdp.detach();
    assert.equal(new Set(pages).size, 6);
    assert.ok(pages.every(page => page.context() === context && page !== session.dashboard && page !== foreignPage));
    const targets = await Promise.all(pages.map(page => targetInfo(context, page)));
    assert.equal(new Set(targets.map(target => target.targetId)).size, 6);
    assert.ok(targets.every(target => target.targetId !== unrelatedId && target.browserContextId === owner.browserContextId));
    await Promise.all(pages.map(async (page, index) => {
      await interact(page, 'worker-' + index);
      assert.equal(await page.evaluate(() => document.cookie), 'background-session=own-context');
    }));
  } finally { await browser.close(); }
});

test('source recovery, worker batches and reconciliation only create background tabs', { timeout: 45_000 }, async () => {
  const { browser, context, session } = await fixture();
  const normalNewPage = context.newPage.bind(context);
  context.newPage = async () => { throw Error('Foreground newPage must not be used during automatic operation'); };
  const actions = new FacebookActions(session);
  try {
    const source = await session.sourcePage();
    assert.equal(await session.sourcePage(), source);
    await source.close();
    const recovered = await session.sourcePage();
    assert.notEqual(recovered, source);
    assert.equal(recovered.context(), context);
    for (let round = 0; round < 2; round++) {
      await actions.prepare({ id: '10', name: 'Test' });
      assert.equal(actions.pages.size, 3);
      assert.equal(new Set(actions.pages.values()).size, 3);
      const workers = [...actions.pages.values()];
      await Promise.all(workers.map((page, index) => interact(page, `${round}-${index}`)));
      await actions.release();
      assert.equal(actions.pages.size, 0);
      assert.ok(workers.every(page => page.isClosed()));
      const countBefore = context.pages().length;
      assert.deepEqual(await actions.reconcile('like', reconciliationJob), { code: 'ALREADY_LIKED' });
      assert.equal(context.pages().length, countBefore, 'reconciliation tab is closed after verification');
    }
  } finally { context.newPage = normalNewPage; await actions.close(); await browser.close(); }
});

test('persistent profile creates background tabs inside its existing authenticated context', { timeout: 30_000 }, async () => {
  const temporaryRoot = resolve(tmpdir());
  const profile = await mkdtemp(join(temporaryRoot, 'facebook-background-test-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: null });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: controls }));
    await context.addCookies([{ name: 'persistent-session', value: 'own-profile', url: 'http://background.test/' }]);
    const session = new BrowserSession();
    session.context = context;
    session.dashboard = context.pages()[0] || await context.newPage();
    await session.dashboard.goto('http://background.test/dashboard');
    const owner = await targetInfo(context, session.dashboard);
    context.newPage = async () => { throw Error('Persistent automation must use background target creation'); };
    const pages = await Promise.all(Array.from({ length: 3 }, () => session.newBackgroundPage()));
    assert.equal(new Set(pages).size, 3);
    for (const [index, page] of pages.entries()) {
      assert.equal(page.context(), context);
      assert.equal((await targetInfo(context, page)).browserContextId, owner.browserContextId);
      await interact(page, 'persistent-' + index);
      assert.equal(await page.evaluate(() => document.cookie), 'persistent-session=own-profile');
    }
  } finally {
    await context?.close();
    // Delete only the newly created test directory directly inside the known temp root.
    assert.equal(dirname(resolve(profile)), temporaryRoot);
    assert.ok(basename(profile).startsWith('facebook-background-test-'));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a rejected background target never falls back to a foreground page', { timeout: 20_000 }, async () => {
  const { browser, context, session } = await fixture();
  const originalFactory = browser.newBrowserCDPSession.bind(browser);
  const originalPageSession = context.newCDPSession.bind(context);
  let ordinaryPages = 0, createAttempts = 0;
  const originalNewPage = context.newPage.bind(context);
  context.newPage = async () => { ordinaryPages++; return originalNewPage(); };
  // Cover either public CDP attachment strategy without changing non-creation calls.
  const rejectCreation = <T extends { send: (...args: any[]) => Promise<any> }>(cdp: T): T => {
    const originalSend = cdp.send.bind(cdp);
    cdp.send = ((method: string, parameters?: unknown) => {
      if (method === 'Target.createTarget') { createAttempts++; return Promise.reject(Error('TEST_BACKGROUND_CREATE_REJECTED')); }
      return originalSend(method, parameters);
    }) as T['send'];
    return cdp;
  };
  browser.newBrowserCDPSession = async () => rejectCreation(await originalFactory());
  context.newCDPSession = async page => rejectCreation(await originalPageSession(page));
  try {
    const countBefore = context.pages().length;
    await assert.rejects(session.newBackgroundPage());
    assert.ok(createAttempts > 0);
    assert.equal(ordinaryPages, 0);
    assert.equal(context.pages().length, countBefore);
  } finally {
    browser.newBrowserCDPSession = originalFactory;
    context.newCDPSession = originalPageSession;
    context.newPage = originalNewPage;
    await browser.close();
  }
});

function foregroundWindow(ownProcessId?: number): { hwnd: string; processId: number; kind: string } {
  const script = `$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ToolFocusReadOnly {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int length);
}
'@
$toolFocusHandle = [ToolFocusReadOnly]::GetForegroundWindow()
[uint32]$toolFocusProcess = 0
[void][ToolFocusReadOnly]::GetWindowThreadProcessId($toolFocusHandle, [ref]$toolFocusProcess)
$toolFocusKind = 'external'
if ($toolFocusProcess -eq ${ownProcessId ?? -1}) {
  $toolFocusTitle = New-Object System.Text.StringBuilder 1024
  [void][ToolFocusReadOnly]::GetWindowText($toolFocusHandle, $toolFocusTitle, $toolFocusTitle.Capacity)
  $toolFocusKind = if ($toolFocusTitle.ToString().Contains('Tool background focus test')) {'sentinel'} elseif ($toolFocusTitle.ToString().Contains('Tool background worker test')) {'worker'} else {'own-other'}
}
@{ hwnd=$toolFocusHandle.ToInt64().ToString(); processId=$toolFocusProcess; kind=$toolFocusKind } | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }));
}

test('headed Windows automation preserves the foreground app and minimized window', {
  skip: process.env.TOOL_FOCUS_TEST !== '1' || process.platform !== 'win32', timeout: 120_000,
}, async t => {
  const { browser, context, session, profile } = await fixture(false, true);
  const sentinelContext = await browser.newContext();
  const sentinel = await sentinelContext.newPage();
  const title = 'Tool background focus test ' + Date.now();
  await sentinel.setContent(`<title>${title}</title><h1>Foreground test window</h1>`);
  const cdp = await browser.newBrowserCDPSession();
  const ownProcessId = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(process => process.type === 'browser')?.id;
  assert.equal(typeof ownProcessId, 'number');
  const info = await targetInfo(context, session.dashboard);
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: info.targetId });
  const sentinelInfo = await targetInfo(sentinelContext, sentinel);
  const sentinelWindow = await cdp.send('Browser.getWindowForTarget', { targetId: sentinelInfo.targetId });
  assert.notEqual(sentinelWindow.windowId, windowId, 'the foreground sentinel belongs to a separate test window');
  const actions = new FacebookActions(session);
  const ordinaryNewPage = context.newPage.bind(context);
  context.newPage = async () => { throw Error('Foreground tab creation is forbidden'); };
  let externalWindowChanges = 0;
  try {
    for (const windowState of ['normal', 'minimized'] as const) {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
      let mustStayMinimized = windowState === 'minimized';
      // Observe the current app without forcing focus. The user can legitimately
      // switch between other apps while this test runs.
      // Native window creation/restoration completes asynchronously after CDP.
      // Establish a settled baseline before testing any automatic operation.
      let before = foregroundWindow(ownProcessId);
      for (let attempt = 0; attempt < 5; attempt++) {
        const next = foregroundWindow(ownProcessId);
        const stable = next.hwnd === before.hwnd;
        before = next;
        if (stable) break;
      }
      assert.notEqual(before.hwnd, '0', 'this opt-in test requires access to the interactive Windows desktop');
      const assertUnchanged = async (stage: string) => {
        const current = await cdp.send('Browser.getWindowBounds', { windowId });
        const foreground = foregroundWindow(ownProcessId);
        const sourceTarget = session.source && !session.source.isClosed() ? await targetInfo(context, session.source) : undefined;
        const sourceWindow = sourceTarget ? await cdp.send('Browser.getWindowForTarget', { targetId: sourceTarget.targetId }) : undefined;
        const evidence = `${windowState}/${stage}, windowState=${current.bounds.windowState}, foregroundIsOwnBrowser=${foreground.processId === ownProcessId}, foregroundKind=${before.kind}->${foreground.kind}, dashboardWindowId=${windowId}, sourceWindowId=${sourceWindow?.windowId}, sentinelWindowId=${sentinelWindow.windowId}`;
        if (foreground.processId === ownProcessId) {
          assert.equal(before.processId, ownProcessId, 'automatic operation must not activate a test browser window: ' + evidence);
          assert.equal(foreground.hwnd, before.hwnd, 'automatic operation must not replace the foreground test sentinel: ' + evidence);
        } else if (foreground.hwnd !== before.hwnd) externalWindowChanges++;
        // A person may minimize an ordinary window while the test runs. Once
        // minimized, no automatic page operation may restore it.
        if (mustStayMinimized)
          assert.equal(current.bounds.windowState, 'minimized', 'automatic operation must not restore the minimized tool window: ' + evidence);
        if (current.bounds.windowState === 'minimized') mustStayMinimized = true;
      };
      await assertUnchanged('baseline');
      // Repeated creation, editing, Enter, clicks, reconciliation and closure cover new-post cycles.
      for (let round = 0; round < 2; round++) {
        const source = await session.sourcePage();
        await assertUnchanged(`source-${round}`);
        await source.close();
        await actions.prepare({ id: '10', name: 'Test' });
        await assertUnchanged(`prepare-${round}`);
        await Promise.all([...actions.pages.values()].map((page, index) => interact(page, `${round}-${index}`)));
        await assertUnchanged(`interact-${round}`);
        await actions.release();
        await assertUnchanged(`release-${round}`);
        assert.deepEqual(await actions.reconcile('like', reconciliationJob), { code: 'ALREADY_LIKED' });
        await assertUnchanged(`reconcile-${round}`);
      }
    }
  } finally {
    context.newPage = ordinaryNewPage;
    await actions.close();
    await cdp.detach();
    await browser.close();
    if (profile) {
      assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
      assert.ok(basename(profile).startsWith('facebook-background-test-'));
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  if (externalWindowChanges) t.diagnostic(`Observed ${externalWindowChanges} external-app foreground changes; no automatic focus change into a test browser was observed.`);
});
