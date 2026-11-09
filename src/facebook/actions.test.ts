import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Route } from 'playwright-core';
import { BrowserSession } from './browser.ts';
import { FacebookActions } from './actions.ts';
import { Engine } from '../engine.ts';
import { Store } from '../store.ts';
import { DEFAULT_CONFIG, ACTIONS } from '../config.ts';
import type { Reader } from '../types.ts';

const accountScript = `<script>globalThis.require=name=>name==='CurrentUserInitialData'
  ?{USER_ID:'10',ACCOUNT_ID:'10',NAME:'Test'}:name==='getAsyncParams'?()=>({__user:'10'}):null</script>`;
const ownUrl = 'https://www.facebook.com/permalink.php?story_fbid=40&id=10';
function originalHtml() {
  return accountScript + `<script type="application/json">{"__typename":"Story","post_id":"30","actors":[{"id":"20"}],"feedback":{"owning_profile":{"id":"20"},"viewer_has_reacted":false}}</script>
  <div role="dialog"><h1>Bài viết của Source</h1><div>
  <button id="like" aria-pressed="false" onclick="send('FeedbackReactMutation',{}).then(()=>{this.textContent='Unlike';this.setAttribute('aria-pressed','true')})">Like</button>
  <button onclick="document.querySelector('#comment').hidden=false">Comment</button>
  <button onclick="document.querySelector('#composer').hidden=false">Share</button></div>
  <div id="comment" role="textbox" contenteditable="true" hidden></div>
  <div role="article"><button role="button" aria-label="Edit or delete this comment">Edit</button><span dir="auto">test 1</span><a href="/permalink.php?story_fbid=30&id=20&comment_id=123456">Comment link</a></div>
  </div>
  <div id="composer" role="dialog" hidden><button>Your Feed</button><span>Test</span><button>Only me</button>
  <div role="textbox" aria-label="Say something about this" contenteditable="true"></div>
  <button onclick="send('ComposerStoryCreateMutation',{message:{text:document.querySelector('#composer [role=textbox]').textContent}})">Post</button></div>
  <script>
  async function send(name,input){return fetch('/api/graphql/',{method:'POST',body:new URLSearchParams({__user:'10',fb_api_req_friendly_name:name,variables:JSON.stringify({input:{actor_id:'10',...input}})})}).then(r=>r.json())}
  document.querySelector('#comment').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();send('CommentCreateMutation',{message:{text:e.currentTarget.textContent}})}};
  </script>`;
}

test('real UI workers record server proof before read-back, including the comment acknowledgement fallback', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: null });
  const session = new BrowserSession(); session.context = context; session.browser = browser;
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test' });
  const adapter = new FacebookActions(session);
  const reader: Reader = { async prepare() { return { id: '10', name: 'Test' }; }, async read() { throw Error('Unused'); }, async openLogin() {}, async close() {} };
  const engine = new Engine(store, reader, adapter);
  const writes: string[] = [], navigations: string[] = [];
  // Every request is fulfilled locally. No Facebook account or external network is used.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/graphql/') {
      const form = new URLSearchParams(request.postData() || ''), name = form.get('fb_api_req_friendly_name')!;
      writes.push(name);
      if (name === 'FeedbackReactMutation') return route.fulfill({ json: { data: { feedback_react: { feedback: { id: 'feedback-30', viewer_has_reacted: true } } } } });
      if (name === 'CommentCreateMutation') return route.fulfill({ json: { data: { comment_create: {} } } });
      if (name === 'ComposerStoryCreateMutation') return route.fulfill({ json: { data: { story_create: { story: {
        __typename: 'Story', post_id: '40', actors: [{ id: '10' }], message: { text: 'test\n#test' }, url: ownUrl,
      } } } } });
      throw Error('Unexpected mock mutation');
    }
    if (request.isNavigationRequest()) navigations.push(request.url());
    const shared = url.searchParams.get('story_fbid') === '40';
    const body = shared ? accountScript + `<script type="application/json">{"__typename":"Story","post_id":"40","actors":[{"id":"10"}]}</script>
      <div role="dialog"><h1>Bài viết của Test</h1><div><a href="${ownUrl}">Time</a><span aria-label="Only me"></span></div></div>` : originalHtml();
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  try {
    session.dashboard = await context.newPage(); await session.dashboard.goto('http://tool.test/');
    const create = session.newBackgroundPage.bind(session);
    session.newBackgroundPage = async () => {
      const page = await create(), originalRoute = page.route.bind(page), originalUnroute = page.unroute.bind(page);
      const handlers = new Map<any, any>();
      // Production's actor guard continues an approved request. In this fixture only,
      // continue falls through to the local context mock rather than reaching the internet.
      page.route = async (url, handler, options) => {
        const wrapped = (route: Route) => handler(new Proxy(route, { get(target, key) {
          if (key === 'continue') return () => route.fallback();
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } }), route.request());
        handlers.set(handler, wrapped); return originalRoute(url, wrapped, options);
      };
      page.unroute = async (url, handler) => { await originalUnroute(url, handler ? handlers.get(handler) || handler : undefined); };
      return page;
    };
    await adapter.prepare({ id: '10', name: 'Test' });
    const id = store.baseline('10', '20', 100, []);
    const job = store.testJob('10', '20', id, { post_id: '30', creation_time: 110, permalink: null, sourceVerification: 'owner' }, store.config());
    await Promise.all(ACTIONS.map(name => engine.perform(name, job, new AbortController().signal)));
    const result = store.job(job.id)!;
    assert.ok(result.actions.every(action => action.state === 'succeeded'), JSON.stringify(result.actions));
    assert.equal(writes.length, 3, 'read-back must not submit another interaction');
    const comment = result.actions.find(action => action.name === 'comment')!;
    assert.equal(comment.code, 'SERVER_CONFIRMED_AND_READ_BACK');
    assert.equal(comment.timing!.trace!.milestones.serverConfirmed, undefined);
    assert.equal(typeof comment.timing!.trace!.milestones.serverAcknowledged, 'number');
    assert.ok(comment.timing!.trace!.steps.some(step => step.stage === 'comment_readback_wait' && step.endMs - step.startMs >= 1400));
    const share = result.actions.find(action => action.name === 'share')!;
    assert.equal(share.externalId, '40');
    assert.ok(share.timing!.trace!.milestones.serverConfirmed! < share.timing!.trace!.finishedMs!);
    assert.ok(share.timing!.trace!.steps.some(step => step.stage === 'share_readback_audience'));
    assert.equal(navigations.filter(url => url === ownUrl).length, 1);
    assert.equal(navigations.filter(url => url.includes('story_fbid=30')).length, 4, 'three workers plus comment read-back');
  } finally { await engine.close(); store.close(); await browser.close(); }
});
