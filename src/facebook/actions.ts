import type { Page, Locator, Response, Route } from 'playwright-core';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSession, activeAccount } from './browser.ts';
import { ACTIONS, type ActionName } from '../config.ts';
import type { Account, Job, ActionAdapter, SubmitHooks, ConfirmedResult } from '../types.ts';
import { mutationConfirmation, mutationActorAllowed, safeFacebookUrl, commentRequestProof, mutationHasErrors } from './confirmation.ts';
import { currentPageShareAudience } from './share-verification.ts';
import { PostLoader, postReadyProbe, type LoadingOptions } from './post-loading.ts';
import { parseRecords } from './feed/query-parser.mjs';
const LIKE = /^(Thích|Like|Bày tỏ cảm xúc Thích về bài viết của .+|Like .+['’]s post)$/i;
const LIKED = /^(Bỏ thích|Unlike|Đã thích|Liked|Gỡ lượt thích|Gỡ Thích khỏi bài viết của .+|Remove Like from .+['’]s post|(?:Gỡ|Xóa|Bỏ) cảm xúc Thích về bài viết của .+)$/i;
const SHARE = /^(Chia sẻ|Share|Chia sẻ bài viết của .+|Share .+['’]s post)$/i;
const COMMENT = /^(Bình luận|Comment|Bình luận về bài viết của .+|Comment on .+['’]s post.*)$/i;
const ONLY_ME = /Chỉ mình tôi|Only me/i, PUBLIC = /Công khai|Public/i;

async function oneVisible(locator: Locator, timeout = 6000): Promise<Locator> {
  const end = Date.now() + timeout;
  do {
    const found: Locator[] = [];
    for (let i = 0, count = await locator.count(); i < Math.min(count, 100); i++) if (await locator.nth(i).isVisible()) found.push(locator.nth(i));
    if (found.length === 1) return found[0];
    if (found.length > 1) throw Error('UI_UNSUPPORTED');
    await delay(100);
  } while (Date.now() < end);
  throw Error('UI_UNSUPPORTED');
}
async function postScope(page: Page): Promise<Locator> {
  const dialogs = page.locator('[role="dialog"]:not(:has([role="dialog"]))').filter({ visible: true })
    .filter({ has: page.getByRole('heading', { name: /^(Bài viết của .+|.+['’]s [Pp]ost)$/ }) });
  for (let i = 0; i < 40; i++) {
    if (await dialogs.count() === 1) return dialogs;
    await delay(100);
  }
  return oneVisible(page.getByRole('main'));
}
export function postUrl(job: Job): string {
  if (!/^\d+$/.test(job.post.post_id) || !/^\d+$/.test(job.sourceId)) throw Error('POST_UNVERIFIED');
  return `https://www.facebook.com/permalink.php?story_fbid=${job.post.post_id}&id=${job.sourceId}`;
}
export async function verifyPost(page: Page, postId: string, sourceId: string, actorId: string) {
  await activeAccount(page, actorId);
  const proof = await page.evaluate(postReadyProbe, { postId, sourceId, actorId, need: 'identity' as const });
  if (!proof) throw Error('POST_UNVERIFIED');
  if (proof.error) throw Error(proof.error);
  return { feedbackIds: proof.feedbackIds };
}

class MutationObserver {
  page: Page; action: ActionName; job: Job;
  armed = false; result: ConfirmedResult | null = null; failed = false; listener: (response: Response) => void;
  safeResponses: unknown[] = [];
  constructor(page: Page, action: ActionName, job: Job, feedbackIds: string[], onServerResponse?: SubmitHooks['onServerResponse']) {
    this.page = page; this.action = action; this.job = job;
    this.listener = response => {
      if (!this.armed) return;
      const request = response.request();
      let url: URL; try { url = new URL(request.url()); } catch { return; }
      if (url.origin !== 'https://www.facebook.com' || url.pathname !== '/api/graphql/' || request.method() !== 'POST') return;
      const body = request.postData(); if (!body || body.length > 2 * 1024 * 1024) return;
      const form = new URLSearchParams(body), name = form.get('fb_api_req_friendly_name') || '';
      if (!/Mutation$/.test(name) || form.get('__user') !== job.accountId) return;
      const expected = action === 'comment' ? /(?:Comment|UFI).*?(?:Create|Submit)|(?:Create|Submit).*Comment/i
        : action === 'like' ? /(?:React|Reaction|Like)/i : /(?:StoryCreate|CreateStory|Share)/i;
      if (!expected.test(name)) return;
      void (async () => {
        if (!response.ok()) { this.failed = true; return; }
        const raw = await response.body(); if (raw.byteLength > 8 * 1024 * 1024) return;
        const records = parseRecords(raw.toString('utf8'));
        const nodes: { type: string; keys: string[] }[] = [], stack = records.map((r: any) => r?.data); let visited = 0;
        while (stack.length && ++visited < 10000 && nodes.length < 15) {
          const node = stack.pop(); if (!node || typeof node !== 'object') continue;
          if (['Comment', 'Story', 'Feedback'].includes(node.__typename)) nodes.push({ type: node.__typename, keys: Object.keys(node).slice(0, 30) });
          for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
        }
        const diagnostic: Record<string, unknown> = { operation: name, status: response.status(), topKeys: records.map((r: any) => Object.keys(r?.data || {})), nodes,
          ...(action === 'comment' ? { createKeys: records.map((r: any) => Object.keys(r?.data?.comment_create || {})) } : {}),
          ...(action === 'share' ? { createKeys: records.map((r: any) => Object.keys(r?.data?.story_create || {})),
            privacyKeys: records.map((r: any) => Object.keys(r?.data?.story_create?.story?.privacy_scope || {})) } : {}) };
        this.safeResponses.push(diagnostic);
        if (mutationHasErrors(records)) { this.failed = true; return; }
        const proof = commentRequestProof(form, job, feedbackIds);
        if (action === 'comment') diagnostic.requestProof = { actorAndTextVerified: proof.commentTextAndActorVerified, targetVerified: proof.commentTargetVerified };
        if (action === 'comment' && !proof.commentRequestCompatible) { this.failed = true; return; }
        this.result = mutationConfirmation(records, action, job, proof);
        if (!this.result && action === 'comment' && records.some((r: any) => r?.data?.comment_create))
          this.result = { code: 'SERVER_ACK_REQUIRES_RECONCILIATION' };
        diagnostic.confirmation = this.result?.code ?? 'unconfirmed';
        if (this.result?.shareProof) diagnostic.shareProof = this.result.shareProof;
        if (this.result) onServerResponse?.(this.result.code === 'SERVER_ACK_REQUIRES_RECONCILIATION' ? 'acknowledged' : 'confirmed');
      })().catch(() => {});
    };
    page.on('response', this.listener);
  }
  async confirmed(signal: AbortSignal): Promise<ConfirmedResult> {
    const deadline = Date.now() + 18000;
    while (!this.result && !this.failed && Date.now() < deadline && !signal.aborted) await delay(100);
    if (!this.result || signal.aborted) throw Error('RESULT_UNCONFIRMED');
    return this.result;
  }
  close() { this.page.off('response', this.listener); }
}
export class FacebookActions implements ActionAdapter {
  session: BrowserSession; account: Account | null = null;
  pages = new Map<ActionName, Page>();
  lastDiagnostics: Record<string, unknown> = {};
  stages = new Map<ActionName, string>();
  lastMutations = new Map<ActionName, unknown[]>();
  postIds = new Map<ActionName, string>();
  shareBinding = new WeakMap<Page, string>();
  loader: PostLoader;
  constructor(session: BrowserSession, loading: LoadingOptions = {}) { this.session = session; this.loader = new PostLoader(loading); }
  async prepare(account: Account) {
    this.account = account;
    for (const name of ACTIONS) if (!this.pages.get(name) || this.pages.get(name)!.isClosed()) {
      const page = await this.session.newBackgroundPage(); await this.loader.prepare(page); this.pages.set(name, page);
    }
  }
  async execute(name: ActionName, job: Job, hooks: SubmitHooks): Promise<ConfirmedResult> {
    hooks.signal.throwIfAborted();
    if (!this.account || this.account.id !== job.accountId) throw Error('ACTOR_CHANGED');
    const page = this.pages.get(name); if (!page || page.isClosed()) throw Error('STOPPED');
    // Install only immediately before submitting, then remove before read-back navigation.
    // Routing disables HTTP cache, so it must not cover initial page/composer rendering.
    const writeGuard = async (route: Route) => {
      const request = route.request(), body = request.postData();
      let sendingAction = false;
      if (request.method() === 'POST' && body) {
        if (!mutationActorAllowed(new URLSearchParams(body), job.accountId)) { await route.abort('blockedbyclient'); return; }
        const form = new URLSearchParams(body);
        const operation = form.get('fb_api_req_friendly_name') || '';
        const expected = name === 'comment' ? /(?:Comment|UFI).*?(?:Create|Submit)|(?:Create|Submit).*Comment/i
          : name === 'like' ? /(?:React|Reaction|Like)/i : /(?:StoryCreate|CreateStory|Share)/i;
        sendingAction = observation.armed && /Mutation$/.test(operation) && expected.test(operation) && form.get('__user') === job.accountId;
        if (name === 'comment' && /(?:Comment|UFI).*?(?:Create|Submit)|(?:Create|Submit).*Comment/i.test(form.get('fb_api_req_friendly_name') || '')) {
          const proof = commentRequestProof(form, job, original.feedbackIds);
          if (!proof.commentRequestCompatible) {
            await route.abort('blockedbyclient'); return;
          }
        }
      }
      await route.continue();
      // The browser has released this action's allowed mutation to the network.
      // This records dispatch, independently of HTTP response or verification.
      if (sendingAction) hooks.onSubmitted?.();
    };
    const stage = (value: Parameters<NonNullable<SubmitHooks['onStage']>>[0]) => { this.stages.set(name, value); hooks.onStage?.(value); };
    stage('navigate_original_post'); this.postIds.set(name, job.post.post_id);
    await this.loader.load(page, postUrl(job), { postId: job.post.post_id, sourceId: job.sourceId, actorId: job.accountId, need: 'actions' }, hooks.signal);
    hooks.signal.throwIfAborted();
    stage('verify_original_post');
    const original = await verifyPost(page, job.post.post_id, job.sourceId, job.accountId);
    stage('find_post_scope');
    const main = await postScope(page);
    await main.waitFor({ state: 'visible' });
    // Comments use Reply controls, so the original post's unique Comment button anchors its action bar.
    // A missing Share control must not prevent the independent Like/Comment workers from running.
    stage('find_action_bar');
    const commentButton = await oneVisible(main.getByRole('button', { name: COMMENT }));
    let bar: Locator | null = null;
    for (let level = 1; level <= 10; level++) {
      const candidate = commentButton.locator('xpath=' + Array.from({ length: level }, () => '..').join('/'));
      const likeCount = await candidate.getByRole('button', { name: LIKE }).count() + await candidate.getByRole('button', { name: LIKED }).count();
      if (likeCount === 1 && await candidate.getByRole('button', { name: COMMENT }).count() === 1) { bar = candidate; break; }
    }
    if (!bar) throw Error('UI_UNSUPPORTED');
    const observation = new MutationObserver(page, name, job, original.feedbackIds, hooks.onServerResponse);
    const send = async (control: Locator, keyboard = false) => {
      stage('prepare_submission');
      hooks.signal.throwIfAborted(); await activeAccount(page, job.accountId);
      await page.route('https://www.facebook.com/api/graphql/', writeGuard);
      hooks.beforeSubmit(); hooks.signal.throwIfAborted(); observation.armed = true; stage('submit');
      if (keyboard) await control.press('Enter'); else await control.click({ timeout: 8000 });
      stage('wait_server');
    };
    const confirmed = async () => {
      const result = await observation.confirmed(hooks.signal);
      await page.unroute('https://www.facebook.com/api/graphql/', writeGuard);
      return result;
    };
    try {
      if (name === 'like') {
        stage('check_existing_reaction');
        const already = bar.getByRole('button', { name: LIKED });
        if (await already.count() === 1 && await already.isVisible()) return { code: 'ALREADY_LIKED' };
        const like = await oneVisible(bar.getByRole('button', { name: LIKE }));
        const pressed = await like.getAttribute('aria-pressed');
        if (pressed === 'true') return { code: 'ALREADY_LIKED' };
        const reaction = await this.reactionState(page, job.post.post_id);
        const addLabel = /^(Bày tỏ cảm xúc Thích về bài viết của |Like .+['’]s post)/i.test(await like.getAttribute('aria-label') || '');
        if (reaction === 'reacted' || pressed !== 'false' && reaction !== 'none' && !addLabel) throw Error('REACTION_UNVERIFIED');
        await send(like);
        const result = await confirmed();
        hooks.onServerConfirmed?.(result);
        stage('verify_like');
        const selected = bar.getByRole('button', { name: LIKED });
        if (!await selected.count() && await like.getAttribute('aria-pressed') !== 'true') throw Error('RESULT_UNCONFIRMED');
        return result;
      }
      if (name === 'comment') {
        if (!job.plan.comment) throw Error('CONFIG_INVALID');
        stage('open_comment_editor');
        await (await oneVisible(bar.getByRole('button', { name: COMMENT }))).click();
        const editor = await oneVisible(main.locator('[role="textbox"][contenteditable="true"]').filter({ visible: true }));
        stage('fill_comment');
        hooks.signal.throwIfAborted(); await editor.fill(job.plan.comment);
        await send(editor, true);
        let result = await confirmed();
        if (result.code === 'SERVER_ACK_REQUIRES_RECONCILIATION') {
          const existing = await this.reconcile('comment', job, hooks.signal, stage);
          if (!existing) throw Error('RESULT_UNCONFIRMED');
          result = { ...existing, code: 'SERVER_CONFIRMED_AND_READ_BACK' };
        }
        hooks.onServerConfirmed?.(result); return result;
      }
      stage('open_share_composer');
      await (await oneVisible(bar.getByRole('button', { name: SHARE }))).click(); hooks.signal.throwIfAborted();
      this.shareBinding.set(page, job.id);
      const editorMatch = page.getByRole('textbox', { name: /^(Hãy nói gì đó về nội dung này|Say something about this|Write something)/i });
      const dialog = page.locator('[role="dialog"]:not(:has([role="dialog"]))').filter({ has: editorMatch });
      let composer: Locator;
      try { composer = await oneVisible(dialog, 4000); }
      catch {
        stage('share_menu_fallback');
        const feed = await oneVisible(page.getByRole('menuitem', { name: /^(Chia sẻ lên (?:Bảng feed|bảng tin|trang cá nhân)|Viết bài|Share to (?:Feed|your timeline)|Write post)$/i }), 2500);
        await feed.click();
        composer = await oneVisible(dialog, 6000);
      }
      stage('verify_share_destination');
      await this.verifyShareDestination(page, composer, job);
      stage('set_share_audience');
      await this.setAudience(page, composer, job.plan.audience, hooks.signal);
      stage('fill_share');
      const editor = await oneVisible(composer.locator('[contenteditable="true"][role="textbox"]'));
      await editor.fill(job.plan.share); hooks.signal.throwIfAborted();
      stage('verify_share_before_submit');
      await this.assertAudience(composer, job.plan.audience);
      await this.verifyShareDestination(page, composer, job);
      const submit = await oneVisible(composer.getByRole('button', { name: /^(Chia sẻ ngay|Chia sẻ|Đăng|Share now|Share|Post)$/i }));
      await send(submit);
      const result = await confirmed();
      hooks.onServerConfirmed?.(result);
      if (!result.externalId || !result.externalUrl) throw Error('RESULT_UNCONFIRMED');
      hooks.signal.throwIfAborted();
      stage('share_verify_response');
      if (result.shareProof?.identityVerified && result.shareProof.audience === job.plan.audience)
        return { ...result, code: 'SERVER_CONFIRMED_RESPONSE_VERIFIED' };
      if (result.shareProof?.identityVerified && result.shareProof.audience === null) {
        stage('share_verify_current_page');
        await activeAccount(page, job.accountId);
        const audience = await currentPageShareAudience(page, result.externalId, job.accountId, result.externalUrl);
        if (audience === job.plan.audience) return { ...result, code: 'SERVER_CONFIRMED_UI_VERIFIED' };
      }
      // Missing, conflicting or unexpected privacy evidence always uses the existing read-back.
      stage('share_readback_navigate');
      await this.loader.load(page, result.externalUrl, { postId: result.externalId, sourceId: job.accountId, actorId: job.accountId, need: 'published', permalink: result.externalUrl }, hooks.signal);
      stage('share_readback_verify');
      await verifyPost(page, result.externalId, job.accountId, job.accountId);
      await this.assertPublishedAudience(page, result.externalId, result.externalUrl, job.plan.audience, stage);
      return { ...result, code: 'SERVER_CONFIRMED_AND_READ_BACK' };
    } finally { this.lastMutations.set(name, observation.safeResponses); observation.close(); await page.unroute('https://www.facebook.com/api/graphql/', writeGuard).catch(() => {}); }
  }
  async verifyShareDestination(page: Page, dialog: Locator, job: Job) {
    // The native Share dialog currently omits the original attachment preview. Bind it to the
    // verified original post's Share control and unchanged post URL, not to other offered destinations.
    const url = new URL(page.url()), canonical = safeFacebookUrl(job.post.permalink);
    const numericMatch = url.origin === 'https://www.facebook.com' && url.pathname === '/permalink.php'
      && url.searchParams.get('story_fbid') === job.post.post_id && url.searchParams.get('id') === job.sourceId;
    if (this.shareBinding.get(page) !== job.id || !numericMatch && safeFacebookUrl(page.url()) !== canonical) throw Error('DESTINATION_UNVERIFIED');
    await verifyPost(page, job.post.post_id, job.sourceId, job.accountId);
    try {
      await oneVisible(dialog.getByRole('button', { name: /^(Chia sẻ lên Bảng feed(?: \(Chỉ đọc\))?|Share to (?:your )?Feed(?: \(Read.only\))?|Your Feed|Bảng feed)$/i }), 2000);
      if (this.account?.name) await oneVisible(dialog.getByText(this.account.name, { exact: true }), 2000);
    } catch { throw Error('DESTINATION_UNVERIFIED'); }
  }
  async assertAudience(container: Locator, audience: 'only_me' | 'public') {
    const expected = audience === 'only_me' ? ONLY_ME : PUBLIC;
    const button = container.getByRole('button', { name: expected });
    try { await oneVisible(button, 2000); } catch { throw Error('AUDIENCE_UNVERIFIED'); }
  }
  async setAudience(page: Page, composer: Locator, audience: 'only_me' | 'public', signal: AbortSignal) {
    try { await this.assertAudience(composer, audience); return; } catch {}
    const audienceButton = await oneVisible(composer.getByRole('button', { name: /Công khai|Public|Bạn bè|Friends|Chỉ mình tôi|Only me|Đối tượng|Audience/i }));
    await audienceButton.click(); signal.throwIfAborted();
    const expected = audience === 'only_me' ? ONLY_ME : PUBLIC;
    const choice = await oneVisible(page.getByRole('radio', { name: expected }));
    await choice.click();
    const done = page.getByRole('button', { name: /^(Xong|Lưu|Done|Save)$/i });
    if (await done.count()) await (await oneVisible(done)).click();
    signal.throwIfAborted(); await this.assertAudience(composer, audience);
  }
  async assertPublishedAudience(page: Page, postId: string, permalink: string, audience: 'only_me' | 'public', onStage?: SubmitHooks['onStage']) {
    onStage?.('share_readback_scope');
    const scope = await postScope(page);
    onStage?.('share_readback_audience');
    const actual = await scope.evaluate((node, expected) => {
      // Only labels before the shared original's header belong to the newly published header.
      const links = [...node.querySelectorAll('a[href]')];
      const clean = (value: string) => { try { const u = new URL(value); return u.origin + u.pathname + '?story_fbid=' + u.searchParams.get('story_fbid') + '&id=' + u.searchParams.get('id'); } catch { return ''; } };
      const ownLink = links.find(a => (a as HTMLAnchorElement).href.includes(expected.postId)
        || clean((a as HTMLAnchorElement).href) === clean(expected.permalink));
      if (!ownLink) return null;
      let header: Element | null = ownLink;
      for (let i = 0; header && i < 5; i++, header = header.parentElement) {
        const labels = [...header.querySelectorAll('[aria-label],[title]')].map(el => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
        if (labels.some(s => /Chỉ mình tôi|Only me/i.test(s))) return 'only_me';
        if (labels.some(s => /Công khai|Public/i.test(s))) return 'public';
      }
      return null;
    }, { postId, permalink });
    if (actual !== audience) throw Error('RESULT_UNCONFIRMED');
  }
  async reactionState(page: Page, postId: string): Promise<'none' | 'reacted' | 'unknown'> {
    return page.evaluate(postId => {
      const roots: any[] = []; let bytes = 0, visited = 0;
      for (const script of document.querySelectorAll('script[type="application/json"],script[data-sjs]')) {
        const text = script.textContent || ''; if (!text.includes(postId)) continue;
        bytes += new TextEncoder().encode(text).byteLength; if (bytes > 8 * 1024 * 1024) return 'unknown';
        try { roots.push(JSON.parse(text)); } catch {}
      }
      const states = new Set<string>();
      while (roots.length) {
        const node = roots.pop(); if (++visited > 200000) return 'unknown';
        if (!node || typeof node !== 'object') continue;
        if (node.__typename === 'Story' && node.post_id === postId) {
          const views = [node, node.comet_sections?.feedback?.story, node.comet_sections?.context_layout?.story];
          for (const view of views) {
            if (!view || view !== node && view.id !== node.id && view.post_id !== postId) continue;
            const feedback = view.feedback;
            if (!feedback || typeof feedback !== 'object') continue;
            if (feedback.viewer_has_reacted === false || Object.hasOwn(feedback, 'viewer_feedback_reaction_info') && feedback.viewer_feedback_reaction_info === null) states.add('none');
            if (feedback.viewer_has_reacted === true || feedback.viewer_feedback_reaction_info?.id) states.add('reacted');
          }
        }
        for (const child of Object.values(node)) if (child && typeof child === 'object') roots.push(child);
      }
      return states.size === 1 ? [...states][0] as 'none' | 'reacted' : 'unknown';
    }, postId);
  }
  async stop() { const pages = [...this.pages.values()]; this.pages.clear(); await Promise.allSettled(pages.map(page => page.close())); }
  async close() { await this.stop(); }
  async reconcile(name: ActionName, job: Job, signal?: AbortSignal, onStage?: SubmitHooks['onStage']): Promise<ConfirmedResult | null> {
    signal?.throwIfAborted();
    onStage?.('comment_readback_open_tab');
    const page = await this.session.newBackgroundPage();
    await this.loader.prepare(page);
    const abort = () => { void page.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const evidence = job.actions.find(a => a.name === name);
      if (name === 'share') {
        const found = evidence?.externalId && evidence.externalUrl ? { id: evidence.externalId, url: evidence.externalUrl } : await this.findOwnShare(page, job);
        if (!found) return null;
        await this.loader.load(page, found.url, { postId: found.id, sourceId: job.accountId, actorId: job.accountId, need: 'published', permalink: found.url }, signal);
        await verifyPost(page, found.id, job.accountId, job.accountId);
        await this.assertPublishedAudience(page, found.id, found.url, job.plan.audience);
        return { externalId: found.id, externalUrl: found.url };
      }
      onStage?.('comment_readback_navigate');
      await this.loader.load(page, postUrl(job), { postId: job.post.post_id, sourceId: job.sourceId, actorId: job.accountId, need: 'post' }, signal);
      onStage?.('comment_readback_verify');
      await verifyPost(page, job.post.post_id, job.sourceId, job.accountId);
      onStage?.('comment_readback_scope');
      const scope = await postScope(page);
      if (name === 'like') {
        const liked = scope.getByRole('button', { name: LIKED });
        if (await liked.count() === 1 && await liked.isVisible()) return { code: 'ALREADY_LIKED' };
        const like = scope.getByRole('button', { name: LIKE });
        return await like.count() === 1 && await like.getAttribute('aria-pressed') === 'true' ? { code: 'ALREADY_LIKED' } : null;
      }
      onStage?.('comment_readback_wait');
      const find = () => scope.locator('[role="article"]').evaluateAll((nodes, expected) => {
        const found = new Map<string, string>();
        for (const node of nodes) {
          const editable = [...node.querySelectorAll('[role="button"]')].some(n => /^(Chỉnh sửa hoặc xóa bình luận này|Edit or delete this comment)$/i.test(n.getAttribute('aria-label') || ''));
          if (!editable || ![...node.querySelectorAll('[dir="auto"]')].some(n => n.textContent?.trim() === expected.text)) continue;
          for (const link of node.querySelectorAll('a[href]')) {
            try {
              const u = new URL((link as HTMLAnchorElement).href), id = u.searchParams.get('comment_id');
              if (u.origin !== 'https://www.facebook.com' || !/^\d+$/.test(id || '')) continue;
              const clean = new URL(expected.postUrl); clean.searchParams.set('comment_id', id!); found.set(id!, clean.href);
            } catch {}
          }
        }
        return [...found].map(([id, url]) => ({ id, url }));
      }, { text: job.plan.comment, postUrl: postUrl(job) });
      // Early page readiness can precede comment hydration. Wait for evidence, not
      // a fixed sleep; ambiguity still fails and never causes another submission.
      const deadline = performance.now() + 6000;
      let matches = await find();
      while (!matches.length && performance.now() < deadline) {
        signal?.throwIfAborted(); await delay(100); matches = await find();
      }
      onStage?.('comment_readback_find');
      if (matches.length === 1 && job.accountId !== job.sourceId) {
        await activeAccount(page, job.accountId);
        return { externalId: matches[0].id, externalUrl: matches[0].url };
      }
      return null;
    } finally { signal?.removeEventListener('abort', abort); await page.close().catch(() => {}); }
  }
  async findOwnShare(page: Page, job: Job): Promise<{ id: string; url: string } | null> {
    await page.goto('https://www.facebook.com/profile.php?id=' + job.accountId, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await activeAccount(page, job.accountId); await page.waitForTimeout(1200);
    const found = await page.evaluate(expected => {
      const stack: any[] = [], matches = new Map<string, string>(); let bytes = 0, visited = 0;
      const clean = (value: unknown): string | null => {
        if (typeof value !== 'string') return null;
        try { const u = new URL(value); if (u.origin !== 'https://www.facebook.com') return null;
          for (const key of [...u.searchParams.keys()]) if (!['id','story_fbid'].includes(key)) u.searchParams.delete(key);
          u.hash = ''; return u.href;
        } catch { return null; }
      };
      for (const script of document.querySelectorAll('script[type="application/json"],script[data-sjs]')) {
        const text = script.textContent || ''; if (!text.includes('Story')) continue;
        bytes += new TextEncoder().encode(text).byteLength; if (bytes > 8 * 1024 * 1024) return [];
        try { stack.push(JSON.parse(text)); } catch {}
      }
      while (stack.length) {
        const node = stack.pop(); if (++visited > 200000) return [];
        if (!node || typeof node !== 'object') continue;
        if (node.__typename === 'Story' && node.actors?.[0]?.id === expected.accountId && /^\d+$/.test(node.post_id || '')) {
          const views = [node, node.comet_sections?.content?.story, node.comet_sections?.context_layout?.story]
            .filter(v => v && (v === node || (v.id === node.id || v.post_id === node.post_id) && (!v.id || v.id === node.id) && (!v.post_id || v.post_id === node.post_id)));
          const hasText = views.some(v => v.message?.text === expected.text);
          const attachments = [node.attached_story, node.comet_sections?.attached_story?.story]; let attached = false, count = 0;
          while (attachments.length && ++count < 10000) {
            const part = attachments.pop(); if (!part || typeof part !== 'object') continue;
            if (part.post_id === expected.postId || expected.permalink && [part.url,part.permalink_url,part.wwwURL].some(url => clean(url) === expected.permalink)) attached = true;
            for (const child of Object.values(part)) if (child && typeof child === 'object') attachments.push(child);
          }
          const url = views.map(v => clean(v.permalink_url || v.url || v.wwwURL)).find(Boolean);
          if (hasText && attached && url) matches.set(node.post_id, url);
        }
        for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
      }
      return [...matches].map(([id,url]) => ({id,url}));
    }, { accountId:job.accountId,postId:job.post.post_id,text:job.plan.share,permalink:safeFacebookUrl(job.post.permalink) || null });
    return found.length === 1 ? found[0] : null;
  }
  async release() {
    this.lastDiagnostics = await this.diagnostics();
    await this.stop(); // Release Facebook's loaded worker tabs while waiting for the next new post.
  }
  async diagnostics() {
    if (!this.pages.size) return this.lastDiagnostics;
    const result: Record<string, unknown> = {};
    for (const [name, page] of this.pages) {
      if (page.isClosed()) continue;
      result[name] = await page.evaluate(() => ({
        title: document.title.slice(0, 120),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(n => ({ headings: [...n.querySelectorAll('[role="heading"],h1,h2')].map(h => (h.textContent || '').slice(0, 120)).filter(t => /^(Bài viết|Chia sẻ|Share|Đối tượng|Audience|.+['’]s Post)/i.test(t)) })),
        buttons: [...document.querySelectorAll('[role="dialog"] [role="button"]')]
          .filter(n => n.getBoundingClientRect().height > 0 && /^(?:Thích|Like|Bày tỏ cảm xúc|Bỏ|Gỡ|Xóa cảm xúc|Bình luận|Comment|Chia sẻ|Share|Chỉnh sửa quyền riêng tư|Chỉ mình tôi|Only me|Công khai|Public|Đăng|Post|Xong|Done|Lưu|Save|Đóng)/i.test(n.getAttribute('aria-label') || n.textContent || ''))
          .slice(0, 60).map(n => ({ label: n.getAttribute('aria-label'), text: (n.textContent || '').slice(0, 100), pressed: n.getAttribute('aria-pressed') })),
        editors: [...document.querySelectorAll('[role="textbox"]')].filter(n => /^(Viết bình luận|Write a comment|Hãy nói gì đó|Say something)/i.test(n.getAttribute('aria-label') || '')).map(n => ({ label: n.getAttribute('aria-label'), editable: n.getAttribute('contenteditable') }))
      })).catch(() => ({ closed: true }));
      result[name] = { ...(result[name] as any), stage: this.stages.get(name), loading: this.loader.diagnostics(page), mutations: this.lastMutations.get(name),
        reaction: this.postIds.get(name) ? await this.reactionState(page, this.postIds.get(name)!).catch(() => 'unknown') : null };
    }
    return result;
  }
}
