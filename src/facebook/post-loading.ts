import { performance } from 'node:perf_hooks';
import type { Page, CDPSession } from 'playwright-core';

// Content CDNs only. Keep static.xx.fbcdn.net (scripts, styles, icons), fonts and GraphQL.
export const CONTENT_MEDIA_URLS = ['https://scontent*.fbcdn.net/*', 'https://video*.fbcdn.net/*'];
export type LoadingOptions = { blockMedia?: boolean; fastReady?: boolean; blockedUrls?: string[] };
export type PostExpectation = { postId: string; sourceId: string; actorId: string; need: 'identity' | 'actions' | 'post' | 'published'; permalink?: string;
  /** Internal HTTP fixture override; production callers always use Facebook. */
  origin?: string };
type Probe = { feedbackIds: string[]; error?: string } | false;

// Serialized into the page. Cache only the proven identity during one load; account
// checks run on every poll, and verifyPost performs a fresh check before any write.
export function postReadyProbe(expected: PostExpectation & { cache?: boolean }): Probe {
  if (location.origin !== (expected.origin || 'https://www.facebook.com') || /\/(?:login|checkpoint|two_step_verification|confirmemail|recover)(?:[/.?]|$)/i.test(location.pathname))
    return { feedbackIds: [], error: 'LOGIN_OR_CHECKPOINT' };
  const loader = (globalThis as any).require;
  if (typeof loader !== 'function') return false;
  const load = (name: string) => { try { return loader(name); } catch { return null; } };
  const current = load('CurrentUserInitialData'), params = load('getAsyncParams')?.('POST');
  const actor = String(params?.__user || '');
  if (!/^[1-9]\d+$/.test(actor) || !current) return false;
  if (actor !== expected.actorId || current.USER_ID && String(current.USER_ID) !== actor) return { feedbackIds: [], error: 'ACTOR_CHANGED' };
  const personal = current.ACCOUNT_ID ? String(current.ACCOUNT_ID) === actor : !current.IS_WORK_USER && !current.IS_PAGE;
  if (!personal) return { feedbackIds: [], error: 'PERSONAL_ACCOUNT_REQUIRED' };
  const key = expected.postId + ':' + expected.sourceId;
  const cached = expected.cache ? (globalThis as any).__facebookToolLoadingProof : undefined;
  let proof: { feedbackIds: string[] } | undefined = cached?.key === key && cached.document === document ? cached.proof : undefined;
  if (!proof) {
    const stack: any[] = []; let bytes = 0, visited = 0;
    for (const script of document.querySelectorAll('script[type="application/json"],script[data-sjs]')) {
      const text = script.textContent || ''; if (!text.includes(expected.postId)) continue;
      bytes += new TextEncoder().encode(text).byteLength;
      if (bytes > 8 * 1024 * 1024) return { feedbackIds: [], error: 'POST_UNVERIFIED' };
      try { stack.push(JSON.parse(text)); } catch {}
    }
    while (stack.length) {
      const node = stack.pop(); if (++visited > 200000) return { feedbackIds: [], error: 'POST_UNVERIFIED' };
      if (!node || typeof node !== 'object') continue;
      if (node.__typename === 'Story' && node.post_id === expected.postId) {
        const owner = node.feedback?.owning_profile?.id, author = node.actors?.[0]?.id;
        if (owner && owner !== expected.sourceId || author && author !== expected.sourceId) return { feedbackIds: [], error: 'POST_UNVERIFIED' };
        if (owner === expected.sourceId || author === expected.sourceId) {
          const ids = new Set<string>();
          for (const view of [node, node.comet_sections?.feedback?.story, node.comet_sections?.context_layout?.story]) {
            if (!view) continue;
            if (view !== node && (!(!!node.id && view.id === node.id || view.post_id === expected.postId)
              || view.id && node.id && view.id !== node.id || view.post_id && view.post_id !== expected.postId)) continue;
            if (view.feedback?.owning_profile?.id && view.feedback.owning_profile.id !== expected.sourceId
              || Array.isArray(view.actors) && view.actors.some((a: any) => a.id !== expected.sourceId)) continue;
            if (typeof view.feedback?.id === 'string' && view.feedback.id) ids.add(view.feedback.id);
          }
          proof = { feedbackIds: [...ids] }; break;
        }
      }
      for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
    }
    if (!proof) return false;
    if (expected.cache) (globalThis as any).__facebookToolLoadingProof = { key, document, proof };
  }
  if (expected.need === 'identity') return proof;
  const visible = (node: Element) => { const b = node.getBoundingClientRect(), s = getComputedStyle(node); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(node => visible(node)
    && !node.querySelector('[role="dialog"]') && [...node.querySelectorAll('[role="heading"],h1,h2')]
      .some(h => /^(Bài viết của .+|.+['’]s [Pp]ost)$/.test(h.textContent?.trim() || '')));
  const scopes = dialogs.length ? dialogs : [...document.querySelectorAll('[role="main"],main')].filter(visible);
  if (scopes.length !== 1) return false;
  const scope = scopes[0];
  if (expected.need === 'post') return proof;
  if (expected.need === 'published') {
    const clean = (value: string) => { try { const u = new URL(value, location.href); for (const k of [...u.searchParams.keys()]) if (!['id','story_fbid'].includes(k)) u.searchParams.delete(k); u.hash = ''; return u.href; } catch { return ''; } };
    const link = [...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].some(a => visible(a) && (clean(a.href) === clean(expected.permalink || '')
      || new URL(a.href).searchParams.get('story_fbid') === expected.postId));
    return link && [...scope.querySelectorAll('[aria-label],[title]')].some(n => /Chỉ mình tôi|Only me|Công khai|Public|Bạn bè|Friends/i.test((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || ''))) ? proof : false;
  }
  const buttons = (node: Element, regex: RegExp) => [...node.querySelectorAll('[role="button"],button')].filter(n => visible(n) && regex.test((n.getAttribute('aria-label') || n.textContent || '').trim()));
  const comments = buttons(scope, /^(Bình luận|Comment|Bình luận về bài viết của .+|Comment on .+['’]s post.*)$/i);
  if (comments.length !== 1) return false;
  let bar: Element | null = comments[0].parentElement;
  for (let level = 1; bar && level <= 10 && scope.contains(bar); level++, bar = bar.parentElement) {
    const likes = buttons(bar, /^(Thích|Like|Bày tỏ cảm xúc Thích về bài viết của .+|Like .+['’]s post|Bỏ thích|Unlike|Đã thích|Liked|Gỡ lượt thích|Gỡ Thích khỏi bài viết của .+|Remove Like from .+['’]s post|(?:Gỡ|Xóa|Bỏ) cảm xúc Thích về bài viết của .+)$/i);
    if (likes.length === 1 && buttons(bar, /^(Bình luận|Comment|Bình luận về bài viết của .+|Comment on .+['’]s post.*)$/i).length === 1) return proof;
  }
  return false;
}

type NetworkCounters = { blocked: number; cacheHits: number; bytes: number };
export class PostLoader {
  options: Required<LoadingOptions>;
  private sessions = new WeakMap<Page, Promise<CDPSession | null>>();
  private counters = new WeakMap<Page, NetworkCounters>();
  private filtered = new WeakSet<Page>();
  private summaries = new WeakMap<Page, unknown>();
  constructor(options: LoadingOptions = {}) {
    this.options = { blockMedia: options.blockMedia ?? true, fastReady: options.fastReady ?? true, blockedUrls: options.blockedUrls ?? CONTENT_MEDIA_URLS };
  }
  async prepare(page: Page): Promise<CDPSession | null> {
    const previous = this.sessions.get(page); if (previous) return previous;
    const task = (async () => {
      let cdp: CDPSession | undefined;
      try {
        cdp = await page.context().newCDPSession(page);
        const counters = { blocked: 0, cacheHits: 0, bytes: 0 }; this.counters.set(page, counters);
        const cached = new Set<string>();
        const cacheHit = (id: string) => { if (!cached.has(id)) { cached.add(id); counters.cacheHits++; } };
        cdp.on('Network.loadingFailed', event => { if (event.blockedReason === 'inspector') counters.blocked++; });
        cdp.on('Network.requestServedFromCache', event => { cacheHit(event.requestId); });
        cdp.on('Network.responseReceived', event => { if (event.response.fromDiskCache || event.response.fromPrefetchCache) cacheHit(event.requestId); });
        cdp.on('Network.loadingFinished', event => { counters.bytes += event.encodedDataLength; });
        await cdp.send('Network.enable');
        if (this.options.blockMedia) { await cdp.send('Network.setBlockedURLs', { urls: this.options.blockedUrls }); this.filtered.add(page); }
        page.once('close', () => { void cdp?.detach().catch(() => {}); });
        return cdp;
      } catch { await cdp?.detach().catch(() => {}); return null; }
    })();
    this.sessions.set(page, task); return task;
  }
  diagnostics(page: Page) { return this.summaries.get(page) ?? null; }
  async load(page: Page, url: string, expected: PostExpectation, signal?: AbortSignal): Promise<void> {
    const cdp = await this.prepare(page), started = performance.now();
    const before = { ...(this.counters.get(page) ?? { blocked: 0, cacheHits: 0, bytes: 0 }) };
    signal?.throwIfAborted();
    const abort = () => { void page.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    let fallback = false;
    const filtered = this.filtered.has(page);
    try {
      const fast = this.options.fastReady;
      await page.goto(url, { waitUntil: fast ? 'commit' : 'domcontentloaded', timeout: 30000 });
      if (fast) {
        try {
          const handle = await page.waitForFunction(postReadyProbe, { ...expected, cache: true }, { polling: 50,
            timeout: Math.max(1, Math.min(filtered ? 15000 : 30000, 30000 - (performance.now() - started))) });
          const proof = await handle.jsonValue(); await handle.dispose();
          if (proof && proof.error) throw Error(proof.error);
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof Error) || error.name !== 'TimeoutError' || !cdp || !filtered) throw error;
          // Only retry before any submission, with the original unfiltered load.
          fallback = true; await cdp.send('Network.setBlockedURLs', { urls: [] }); this.filtered.delete(page);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, 30000 - (performance.now() - started)) });
        }
      }
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener('abort', abort);
      const after = this.counters.get(page) ?? before;
      this.summaries.set(page, { fastReady: this.options.fastReady, mediaFilter: filtered && !fallback, fallback,
        durationMs: performance.now() - started, blocked: after.blocked - before.blocked,
        cacheHits: after.cacheHits - before.cacheHits, bytes: after.bytes - before.bytes });
    }
  }
}
