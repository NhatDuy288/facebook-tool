// Reuse the verified, fail-closed parser/transport. Request templates and tokens stay in RAM.
import { READ_WINDOW_SIZE } from '../config.ts';
import { scanBatches } from '../scan-history.ts';
import type { Page, Response } from 'playwright-core';
import { performance } from 'node:perf_hooks';
import { BrowserSession, activeAccount } from './browser.ts';
import type { Account, Reader, WindowRead } from '../types.ts';
import { READ_TARGETS, assertTargetConfigured, matchesReadTargetUrl, type ReadTarget } from './feed/read-target.ts';
import type { ObservedContinuation } from './feed/observed-query-store.ts';
import { inspectAuthWindow } from './feed/capture.ts';
import { COMMON_PARAM_KEYS } from './feed/protocol-params.ts';
import { readCompleteWindow } from './feed/read-complete-window.ts';
import { parseRecords } from './feed/query-parser.mjs';
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(done, ms);
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); reject(Error('STOPPED')); }
  signal.addEventListener('abort', abort, { once: true });
});
export class FacebookReader implements Reader {
  session: BrowserSession;
  target: ReadTarget = 'test-profile';
  template: ObservedContinuation | null = null;
  account: Account | null = null;
  constructor(session: BrowserSession) { this.session = session; }
  async openLogin() { await this.session.openLogin(); }
  async close() { this.template = null; }
  async prepare(target: ReadTarget, signal: AbortSignal): Promise<Account> {
    assertTargetConfigured(target);
    this.target = target; this.template = null; this.account = null;
    const page = await this.session.sourcePage(), source = READ_TARGETS[target];
    let captured: ObservedContinuation | null = null, observing = true;
    const pending = new Set<Promise<void>>();
    const responseListener = (response: Response) => {
      const task = (async () => {
        if (!observing || signal.aborted || captured) return;
        const request = response.request(), url = new URL(request.url());
        if (url.origin !== 'https://www.facebook.com' || url.pathname !== '/api/graphql/' || request.method() !== 'POST') return;
        const body = request.postData(); if (!body || body.length > 8 * 1024 * 1024) return;
        const form = new URLSearchParams(body), name = form.get('fb_api_req_friendly_name') || '';
        if (!/^[A-Za-z_][A-Za-z0-9_]*Timeline[A-Za-z0-9_]*Query$/.test(name)) return;
        const vars = JSON.parse(form.get('variables') || '{}');
        const ids = ['id', 'userID', 'profileID'].map(k => vars[k]).filter(v => typeof v === 'string' && /^\d+$/.test(v));
        if (!ids.includes(source.sourceId) || ids.some(id => id !== source.sourceId)
          || typeof vars.cursor !== 'string' || !vars.cursor || !Number.isSafeInteger(vars.count) || vars.count < 1
          || !/^[1-9]\d*$/.test(form.get('__user') || '') || !/^\d+$/.test(form.get('doc_id') || '') || !response.ok()) return;
        const raw = await response.body();
        if (!observing || signal.aborted || raw.byteLength > 8 * 1024 * 1024) return;
        const inspected = inspectAuthWindow(parseRecords(raw.toString('utf8')), undefined, source.sourceId);
        if (!inspected.usable) return;
        captured = { endpoint: 'https://www.facebook.com/api/graphql/', friendlyName: name,
          variables: vars, form, authenticated: true, responseVerified: true };
      })().catch(() => {});
      pending.add(task); void task.finally(() => pending.delete(task));
    };
    page.on('response', responseListener);
    try {
      signal.throwIfAborted();
      await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await pause(1200, signal);
      this.account = await activeAccount(page);
      if (!matchesReadTargetUrl(page.url(), target)) throw Error('SOURCE_PAGE_UNAVAILABLE');
      // Only initial discovery scrolls the visible source page; periodic reads never reload or scroll.
      for (let round = 0; round < 3 && !captured; round++) {
        signal.throwIfAborted();
        await page.evaluate(() => {
          const doc = document.scrollingElement || document.documentElement;
          const main = document.querySelector('[role="main"],main') || document.body;
          const choices = [doc, ...main.querySelectorAll('div')].filter(el => {
            const b = el.getBoundingClientRect(); return b.width > 400 && b.height > 200 && el.scrollHeight > el.clientHeight + 100
              && (el === doc || ['auto', 'scroll'].includes(getComputedStyle(el).overflowY));
          }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
          const container = choices[0] as HTMLElement | undefined;
          if (container) container.scrollTop += 1200;
        });
        for (let wait = 0; wait < 40 && !captured; wait++) await pause(150, signal);
      }
      if (!captured) throw Error('OBSERVED_QUERY_NOT_VERIFIED');
      const template = captured as ObservedContinuation;
      if (template.form.get('__user') !== this.account.id) throw Error('ACTOR_CHANGED');
      const proof = await proveOperation(page, template);
      if (!proof.operationMatched || !proof.headCursorNullAllowed || !proof.countFeedsFirst || !proof.cursorFeedsAfter)
        throw Error('HEAD_QUERY_UNVERIFIED');
      signal.throwIfAborted();
      this.template = { ...template, artifact: { operationMatched: true, headCursorNullAllowed: true,
        cursorArgumentName: 'cursor', countFeedsFirst: true, cursorFeedsAfter: true } };
      return this.account;
    } finally { observing = false; page.off('response', responseListener); }
  }
  async read(signal: AbortSignal): Promise<WindowRead> {
    signal.throwIfAborted();
    const page = await this.session.sourcePage(), template = this.template;
    if (!template || !this.account) throw Error('OBSERVED_QUERY_NOT_VERIFIED');
    if (!matchesReadTargetUrl(page.url(), this.target)) throw Error('SOURCE_PAGE_UNAVAILABLE');
    await activeAccount(page, this.account.id);
    const started = performance.now(), form = await freshHead(page, template);
    signal.throwIfAborted();
    const result = await readCompleteWindow(page, form, { target: this.target, observedTemplate: template, maxBatches: 2, signal, windowSize: READ_WINDOW_SIZE, expandOnRisk: true });
    return { posts: [...result.posts].sort((a, b) => b.creation_time - a.creation_time).slice(0, READ_WINDOW_SIZE),
      verifiedPosts: result.posts, windowPolicy: { requestedCount: READ_WINDOW_SIZE, verifiedCount: result.posts.length,
        expanded: result.windowSize > READ_WINDOW_SIZE, expansionReason: result.expansionReason }, usable: result.usable, reasonCode: result.reasonCode, serverSeconds: result.serverSeconds,
      firstSeenAt: result.firstSeenAt, observations: result.observations,
      queryPOSTsIssued: result.queryPOSTsIssued, queryMs: Math.round(performance.now() - started),
      decodedBodyBytes: result.batches.reduce((sum, b) => sum + b.decodedBodyBytes, 0),
      scanBatches: scanBatches(result.batches.map(batch => ({ ...batch, parser: batch.inspection ? {
        mainTimelineEdgesObserved: batch.inspection.window.mainTimelineEdgesObserved,
        parentSourceConflict: batch.inspection.window.parentSourceConflict, poisonedPostIds: batch.inspection.window.poisonedPostIds,
        unsupportedPatchCount: batch.inspection.window.unsupportedMainTimelinePatchPaths.length,
        rejectedEdges: batch.inspection.window.rejectedEdges.map((edge: any) => ({ observedPostIds: edge.observedPostIds ?? [], classification: edge.classification })) } : null }))) };
  }
}
async function proveOperation(page: Page, observed: ObservedContinuation) {
  return page.evaluate(({ name, docId }) => {
    const loader = (globalThis as any).require;
    let artifact: any; try { artifact = loader(name + '.graphql'); artifact = artifact?.default || artifact; } catch {}
    const cursor = (artifact?.operation?.argumentDefinitions || []).filter((v: any) => v.kind === 'LocalArgument' && v.name === 'cursor');
    const fields: any[] = [], stack = [artifact?.operation?.selections]; let visited = 0;
    while (stack.length) {
      const value = stack.pop(); if (++visited > 30000) throw Error('HEAD_QUERY_UNVERIFIED');
      if (!value || typeof value !== 'object') continue;
      if (value.kind === 'LinkedField' && (value.alias === 'timeline_list_feed_units' || value.name === 'timeline_list_feed_units')) fields.push(value);
      for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
    }
    const args = fields[0]?.args || [];
    return { operationMatched: artifact?.params?.id === docId && artifact?.params?.name === name && artifact?.params?.operationKind === 'query',
      headCursorNullAllowed: cursor.length === 1 && cursor[0].defaultValue === null,
      countFeedsFirst: fields.length === 1 && args.some((v: any) => v.kind === 'Variable' && v.name === 'first' && v.variableName === 'count'),
      cursorFeedsAfter: fields.length === 1 && args.some((v: any) => v.kind === 'Variable' && v.name === 'after' && v.variableName === 'cursor') };
  }, { name: observed.friendlyName, docId: observed.form.get('doc_id') });
}
async function freshHead(page: Page, original: ObservedContinuation): Promise<URLSearchParams> {
  const active = await page.evaluate(keys => {
    const loader = (globalThis as any).require;
    const load = (name: string) => { try { return loader(name); } catch { return null; } };
    const raw = load('getAsyncParams')?.('POST') || {}, result: Record<string, string> = {};
    for (const key of keys) if (['string', 'number', 'boolean'].includes(typeof raw[key])) result[key] = String(raw[key]);
    const token = load('DTSG')?.getToken?.() || load('DTSGInitialData')?.token;
    if (typeof token === 'string') result.fb_dtsg = token;
    const lsd = load('LSD')?.token; if (typeof lsd === 'string') result.lsd = lsd;
    return result;
  }, [...COMMON_PARAM_KEYS]);
  if (!active.fb_dtsg || active.__user !== original.form.get('__user')) throw Error('FRESH_PROTOCOL_UNAVAILABLE');
  const form = new URLSearchParams(original.form);
  for (const [key, value] of Object.entries(active)) form.set(key, value);
  form.set('variables', JSON.stringify({ ...original.variables, count: READ_WINDOW_SIZE,
    ...(Object.hasOwn(original.variables, 'stream_count') ? { stream_count: READ_WINDOW_SIZE } : {}), cursor: null }));
  return form;
}
