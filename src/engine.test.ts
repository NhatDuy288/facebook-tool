import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Engine } from './engine.ts';
import { Store } from './store.ts';
import { DEFAULT_CONFIG, type ActionName } from './config.ts';
import { READ_TARGETS } from './facebook/feed/read-target.ts';
import type { Reader, ActionAdapter, Post, WindowRead, Job, SubmitHooks } from './types.ts';
const post = (id: string, time = 90): Post => ({ post_id:id,creation_time:time,permalink:null,sourceVerification:'owning_profile' });
const old = ['1','2','3'].map(id=>post(id));
const read = (posts=old): WindowRead => ({posts,usable:true,reasonCode:null,serverSeconds:110,firstSeenAt:new Date().toISOString(),queryPOSTsIssued:2,queryMs:100,decodedBodyBytes:200});
async function until(check:()=>boolean, timeout=4000){const end=performance.now()+timeout;while(!check()&&performance.now()<end)await delay(10);assert.ok(check(),'condition timed out');}
class FakeReader implements Reader {
  reads=0; windows: WindowRead[];
  constructor(windows:WindowRead[]){this.windows=windows;}
  async prepare(){return{id:'10',name:'Test'};}
  async read(){return this.windows[Math.min(this.reads++,this.windows.length-1)];}
  async openLogin(){} async close(){}
}
class FakeActions implements ActionAdapter {
  entered:ActionName[]=[]; sent:ActionName[]=[];
  barrier: (()=>void) | null=null; wait = new Promise<void>(resolve=>{this.barrier=resolve});
  async prepare(){}
  async execute(name:ActionName,_job:Job,hooks:SubmitHooks){
    this.entered.push(name); if(this.entered.length===3)this.barrier!();
    await this.wait;hooks.signal.throwIfAborted();hooks.beforeSubmit();hooks.onSubmitted?.();this.sent.push(name);return{code:'TEST_CONFIRMED'};
  }
  async stop(){this.barrier?.();} async close(){}
}

test('scan history distinguishes absence, rejected batches and acceptance; detection is saved only after actions finish', async () => {
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test', pollSeconds: 1 });
  let release!: () => void, entered = 0, saves = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const save = store.saveScanSnapshot.bind(store);
  store.saveScanSnapshot = (...args) => { saves++; save(...args); };
  const fresh = post('6', 111);
  const rejected: WindowRead = { ...read([fresh, ...old.slice(0, 2)]), usable: false, reasonCode: 'FINAL_FRAME_REQUIRED',
    scanBatches: [{ batchIndex: 0, requestedCount: 3, returnedPostCount: 3, selectedPostCount: 0,
      queryMs: 100, httpStatus: 200, decodedBodyBytes: 500, responseComplete: true, usable: false,
      reasonCode: 'FINAL_FRAME_REQUIRED', serverSeconds: 112, posts: [fresh, ...old.slice(0, 2)] }] };
  const reader = new FakeReader([read(), read(), read(), rejected, { ...read([fresh, ...old.slice(0, 2)]), serverSeconds: 112 }]);
  const adapter: ActionAdapter = { async prepare() {}, async close() {}, async stop() { release(); },
    async execute(_name, _job, hooks) { entered++; await gate; hooks.beforeSubmit(); hooks.onSubmitted?.(); return { code: 'TEST_CONFIRMED' }; } };
  const engine = new Engine(store, reader, adapter);
  try {
    const initial = engine.dashboardStatus('-', '-');
    engine.start(); await until(() => reader.reads >= 3);
    assert.equal(saves, 0, 'ordinary polls only retain RAM evidence');
    await until(() => entered === 3, 5000);
    assert.equal(store.jobs().length, 1);
    assert.equal(store.scanSnapshots().filter(s => s.trigger === 'detection').length, 0);
    assert.equal(engine.pendingScanSnapshots.length, 1);
    const active = engine.dashboardStatus(initial.revisions.jobs, initial.revisions.logs);
    assert.equal(active.jobs?.length, 1);
    assert.ok(active.logs?.length);
    const streamed = engine.dashboardStatus(initial.revisions.jobs, initial.revisions.logs, 1, true);
    assert.equal(streamed.logs, undefined);
    assert.equal(streamed.logFeed, true);
    assert.equal(streamed.revisions.logs, active.revisions.logs);
    assert.equal(Object.keys(active.activeTimings).length, 3);
    const nextPoll = engine.dashboardStatus(active.revisions.jobs, active.revisions.logs);
    assert.equal(nextPoll.jobs, undefined);
    assert.equal(nextPoll.logs, undefined);
    assert.equal(Object.keys(nextPoll.activeTimings).length, 3);
    release(); await until(() => !engine.activeJob);
    const finished = engine.dashboardStatus(active.revisions.jobs, active.revisions.logs);
    assert.ok(finished.jobs?.[0].actions.every(a => a.state === 'succeeded'));
    assert.deepEqual(finished.activeTimings, {});
    const saved = store.scanSnapshots().find(s => s.trigger === 'detection')!;
    assert.equal(saved.jobId, store.jobs()[0].id);
    const scans = saved.snapshot.reads.filter(r => r.purpose === 'watch');
    assert.equal(scans.length, 3);
    assert.equal(scans[0].verifiedPosts.some(p => p.post_id === '6'), false);
    assert.ok(scans[0].selection.decisions.every(d => d.reason === 'previous_window'));
    assert.equal(scans[1].outcome, 'rejected'); assert.equal(scans[1].readerReasonCode, 'FINAL_FRAME_REQUIRED');
    assert.equal(scans[1].batches[0].posts[0].post_id, '6'); assert.equal(scans[1].selection.state, 'not_run');
    assert.equal(scans[2].selection.state, 'committed');
    assert.equal(scans[2].selection.decisions.find(d => d.postId === '6')!.reason, 'accepted');
    assert.equal(store.jobs()[0].actions.every(a => a.state === 'succeeded'), true);
    assert.equal(engine.status().scanHistory.retained, 5);
    assert.equal('reads' in engine.status().scanHistory, false, 'full history is not repeatedly sent with dashboard status');
  } finally { await engine.close(); store.close(); }
});

test('scan selection diagnostics mark rolled-back decisions when a later post invalidates the transaction', async () => {
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'dry-run', pollSeconds: 1 });
  const reader = new FakeReader([read(), read(), { ...read([post('6', 111), post('7', 999), old[0]]), serverSeconds: 112 }]);
  const engine = new Engine(store, reader, new FakeActions());
  try {
    engine.start(); await until(() => engine.consecutiveErrors === 1);
    const saved = store.scanSnapshots(1)[0].snapshot.reads.at(-1)!;
    assert.equal(saved.outcome, 'valid'); assert.equal(saved.selection.state, 'rolled_back');
    assert.equal(saved.selection.errorCode, 'POST_TIME_INVALID');
    assert.deepEqual(saved.selection.decisions.map(d => d.reason), ['accepted', 'future_time']);
    assert.equal(store.jobs().length, 0); assert.equal(store.hasSeen('10', READ_TARGETS['test-profile'].sourceId, '6'), false);
  } finally { await engine.close(); store.close(); }
});

test('two-second three-post monitoring retains expanded baseline IDs and never treats resurfaced old posts as new', async () => {
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'dry-run' });
  const extras = [post('4', 90), post('5', 90)];
  const baseline: WindowRead = { ...read(), verifiedPosts: [...old, ...extras],
    windowPolicy: { requestedCount: 3, verifiedCount: 5, expanded: true, expansionReason: 'promotion_evidence' } };
  // One fresh post, below an old resurfaced item in the actual source order.
  const verified = [post('77', 40), old[0], old[1], post('6', 111), extras[0]];
  const current: WindowRead = { ...read([post('6', 111), old[0], old[1]]), serverSeconds: 115, verifiedPosts: verified,
    windowPolicy: { requestedCount: 3, verifiedCount: 5, expanded: true, expansionReason: 'non_chronological' } };
  const reader = new FakeReader([baseline, baseline, current]), adapter = new FakeActions(), engine = new Engine(store, reader, adapter);
  try {
    engine.start(); await until(() => reader.reads >= 4, 7000);
    assert.equal(store.config().pollSeconds, 2);
    assert.ok(engine.lastReadTiming!.waitMs! >= 1900);
    assert.equal(engine.window.length, 3); assert.equal(engine.status().windowSize, 3);
    assert.equal(engine.status().readWindow!.verifiedCount, 5);
    assert.equal(store.hasSeen('10', READ_TARGETS['test-profile'].sourceId, '5'), true, 'expanded baseline IDs are durable');
    assert.equal(store.hasSeen('10', READ_TARGETS['test-profile'].sourceId, '77'), true, 'old resurfaced post is ignored and recorded');
    assert.equal(store.jobs().length, 1); assert.equal(store.jobs()[0].post.post_id, '6');
    assert.equal(adapter.sent.length, 0);
  } finally { await engine.close(); store.close(); }
});

test('an invalid expanded read preserves the last good three and creates no job', async () => {
  const store = new Store(':memory:'), engine = new Engine(store, new FakeReader([read()]), new FakeActions());
  try {
    await engine.initialize();
    const bad = new FakeReader([{ ...read([post('6', 111), old[0], old[1]]),
      verifiedPosts: [post('6', 111), old[0], old[1], post('4', 90)] }]);
    engine.reader = bad;
    await assert.rejects(engine.readChecked(new AbortController().signal), /UNUSABLE_WINDOW/);
    assert.deepEqual(engine.window, old); assert.equal(store.jobs().length, 0);
  } finally { await engine.close(); store.close(); }
});

test('submission times freeze while confirmation and read-back continue, and are preserved at completion', async () => {
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test', pollSeconds: 1 });
  let release!: () => void, sends = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reader: Reader = new FakeReader([read(), read(), { ...read([post('6', 110), ...old.slice(0, 2)]),
    observations: { '6': { observedAt: new Date().toISOString(), publicationDelayMs: 4500,
      uncertaintyMs: 600, clockOffsetMs: -240000, clockSource: 'facebook-response' } } }]);
  const adapter: ActionAdapter = {
    async prepare() { await delay(5); }, async stop() { release(); }, async close() {},
    async execute(_name, _job, hooks) {
      hooks.onStage?.('navigate_original_post'); await delay(10);
      hooks.onStage?.('prepare_submission'); hooks.beforeSubmit(); hooks.onStage?.('submit');
      await delay(10); hooks.onSubmitted?.(); sends++;
      hooks.onStage?.('wait_server'); await gate;
      hooks.onServerResponse?.('confirmed'); hooks.onStage?.('share_readback_verify');
      await delay(30); hooks.onSubmitted?.(); return { code: 'TEST_CONFIRMED' };
    },
  };
  const engine = new Engine(store, reader, adapter);
  try {
    engine.start(); await until(() => sends === 3);
    const live = engine.status().jobs[0];
    for (const a of live.actions) {
      assert.equal(a.state, 'submitting'); assert.equal(a.timing!.version, 3);
      assert.ok(a.timing!.sentAt); assert.ok(a.timing!.trace!.finishedMs! > 0);
      assert.equal(typeof a.timing!.trace!.milestones.submissionSent, 'number');
      assert.equal(a.timing!.trace!.steps.at(-1)!.stage, 'submit');
      assert.deepEqual(store.job(live.id)!.actions.find(stored => stored.name === a.name)!.timing!.trace!.milestones, {},
        'no extra synchronous disk write is inserted at network dispatch');
    }
    await delay(80);
    assert.deepEqual(engine.status().jobs[0].actions.map(a => a.timing), live.actions.map(a => a.timing));
    release(); await until(() => !engine.activeJob);
    for (const a of store.job(live.id)!.actions) {
      assert.equal(a.state, 'succeeded');
      assert.deepEqual(a.timing, live.actions.find(before => before.name === a.name)!.timing);
      assert.ok(Math.abs(a.timing!.fromPublicationMs! - 4500 - a.timing!.fromDetectionMs!) < 0.001);
      assert.equal(a.timing!.trace!.milestones.serverConfirmed, undefined);
      assert.ok(!a.timing!.trace!.steps.some(step => step.stage.includes('readback') || step.stage === 'wait_server'));
    }
    assert.equal(engine.activeTraces.size, 0);
  } finally { await engine.close(); store.close(); }
});

test('failed verification preserves sent timing and unknown status without recording verification duration', async () => {
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test' });
  const session = store.baseline('10', '20', 100, old);
  const job = store.testJob('10', '20', session, post('6', 110), store.config());
  const adapter: ActionAdapter = { async prepare() {}, async stop() {}, async close() {},
    async execute(_name, _job, hooks) {
      hooks.beforeSubmit(); hooks.onStage?.('submit'); hooks.onSubmitted?.();
      hooks.onStage?.('wait_server'); await delay(30);
      hooks.onStage?.('share_readback_verify'); throw Error('RESULT_UNCONFIRMED');
    } };
  const engine = new Engine(store, new FakeReader([read()]), adapter);
  try {
    await engine.perform('share', job, new AbortController().signal);
    const action = store.job(job.id)!.actions.find(a => a.name === 'share')!;
    assert.equal(action.state, 'unknown'); assert.ok(action.timing!.sentAt);
    assert.equal(typeof action.timing!.trace!.milestones.submissionSent, 'number');
    assert.equal(action.timing!.trace!.steps.at(-1)!.stage, 'submit');
    assert.ok(action.timing!.processingMs! < 25);
    assert.equal(engine.activeTraces.size, 0);
  } finally { await engine.close(); store.close(); }
});

test('a click attempt without a dispatched request never invents a sent milestone', async () => {
  const store = new Store(':memory:');
  store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test' });
  const session = store.baseline('10', '20', 100, old), job = store.testJob('10', '20', session, post('6'), store.config());
  const adapter: ActionAdapter = { async prepare() {}, async stop() {}, async close() {},
    async execute(_name, _job, hooks) { hooks.beforeSubmit(); hooks.onStage?.('submit'); throw Error('RESULT_UNCONFIRMED'); } };
  const engine = new Engine(store, new FakeReader([read()]), adapter);
  try {
    await engine.perform('comment', job, new AbortController().signal);
    const action = store.job(job.id)!.actions.find(a => a.name === 'comment')!;
    assert.equal(action.state, 'unknown'); assert.equal(action.timing!.sentAt, null);
    assert.equal(action.timing!.processingMs, null); assert.equal(action.timing!.trace!.milestones.submissionSent, undefined);
  } finally { await engine.close(); store.close(); }
});

test('new verified posts create one durable job and all three actions start in parallel',async()=>{
  const store=new Store(':memory:');store.saveConfig({...DEFAULT_CONFIG,mode:'test',pollSeconds:1});
  const adapter=new FakeActions(),reader=new FakeReader([read(),read(),read([post('6',110),...old.slice(0,2)])]);
  const engine=new Engine(store,reader,adapter);
  try{
    engine.start();await until(()=>engine.phase==='watching');
    assert.throws(()=>engine.saveConfig({...store.config(),mode:'live'}),/BUSY/);
    assert.equal(store.config().mode,'test');
    await until(()=>adapter.sent.length===3);
    assert.equal(store.jobs().length,1);assert.equal(store.jobs()[0].plan.comment,'test 1');
    assert.deepEqual(new Set(adapter.entered),new Set(['like','share','comment']));
    await until(()=>!engine.activeJob);
    assert.ok(store.jobs()[0].actions.every(a=>a.state==='succeeded'));
    assert.equal(engine.window[0].post_id,'6');
    await delay(1100);assert.equal(store.jobs().length,1);assert.equal(adapter.sent.length,3);
  }finally{await engine.close();store.close();}
});
test('Stop during preparation prevents all unsent interactions',async()=>{
  const store=new Store(':memory:');store.saveConfig({...DEFAULT_CONFIG,mode:'test',pollSeconds:1});
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r});let entered=0,sent=0;
  const adapter:ActionAdapter={async prepare(){},async execute(_name,_job,hooks){entered++;await gate;hooks.signal.throwIfAborted();hooks.beforeSubmit();sent++;return{};},async stop(){release();},async close(){}};
  const engine=new Engine(store,new FakeReader([read(),read(),read([post('6',110),...old.slice(0,2)])]),adapter);
  try{engine.start();await until(()=>entered===3);const stopping=engine.stop();assert.equal(engine.stop(),stopping);await stopping;assert.equal(sent,0);assert.equal(engine.phase,'idle');assert.ok(store.jobs()[0].actions.every(a=>a.state==='cancelled'));}
  finally{await engine.close();store.close();}
});
test('a bad or incomplete response keeps the last good three and never creates an action',async()=>{
  const store=new Store(':memory:');store.saveConfig({...DEFAULT_CONFIG,pollSeconds:1});
  const engine=new Engine(store,new FakeReader([read(),read(),{...read([post('6',110)]),usable:false}]),new FakeActions());
  try{engine.start();await until(()=>engine.consecutiveErrors===1);assert.deepEqual(engine.window,old);assert.equal(store.jobs().length,0);}
  finally{await engine.close();store.close();}
});

test('detection calibration and monotonic action timings survive a laptop clock jump', async t => {
  const published = 1794192140;
  t.mock.timers.enable({ apis: ['Date'], now: published * 1000 + 244500 });
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test', pollSeconds: 1 });
  const baseline = ['1','2','3'].map(id => post(id, published - 10));
  let reads = 0, jumped = false;
  const reader: Reader = {
    async prepare() { return { id: '10', name: 'Test' }; }, async openLogin() {}, async close() {},
    async read() {
      const watching = ++reads > 2;
      const result: WindowRead = { ...read(watching ? [post('6', published), ...baseline.slice(0, 2)] : baseline), serverSeconds: watching ? published + 4 : published - 1 };
      if (watching) result.observations = { '6': { observedAt: new Date().toISOString(), observedMonoMs: performance.now(),
        publicationDelayMs: 4500, uncertaintyMs: 600, clockOffsetMs: -240000, clockSource: 'facebook-response' } };
      return result;
    },
  };
  const adapter: ActionAdapter = { async prepare() {}, async stop() {}, async close() {},
    async execute(_name, _job, hooks) {
      hooks.beforeSubmit();
      if (!jumped) { t.mock.timers.tick(60000); jumped = true; }
      await delay(25); hooks.onSubmitted?.(); return { code: 'TEST_CONFIRMED' };
    } };
  const engine = new Engine(store, reader, adapter);
  try {
    engine.start(); await until(() => store.jobs()[0]?.actions.every(a => a.state === 'succeeded') ?? false);
    const job = store.jobs()[0];
    assert.equal(job.origin, 'watch');
    assert.equal(job.timing!.publicationDelayMs, 4500);
    assert.equal(job.timing!.clockOffsetMs, -240000);
    assert.ok(job.timing!.pollWaitMs! >= 950);
    assert.ok(job.timing!.readIntervalMs! >= job.timing!.pollWaitMs!);
    for (const action of job.actions) {
      assert.ok(action.timing!.processingMs! >= 20 && action.timing!.processingMs! < 1000);
      assert.ok(action.timing!.fromDetectionMs! < 1000);
      assert.ok(action.timing!.fromPublicationMs! >= 4520 && action.timing!.fromPublicationMs! < 6000);
      assert.ok(Math.abs(action.timing!.fromPublicationMs! - 4500 - action.timing!.fromDetectionMs!) < 0.001);
    }
  } finally { await engine.close(); store.close(); }
});

test('a wall clock adjustment during a read invalidates publication calibration', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1794192140000 });
  const store = new Store(':memory:');
  const reader: Reader = { async prepare() { return { id: '10', name: 'Test' }; }, async openLogin() {}, async close() {},
    async read() {
      t.mock.timers.tick(60000);
      return { ...read(), observations: { '1': { observedAt: new Date().toISOString(), observedMonoMs: performance.now(),
        publicationDelayMs: 64500, uncertaintyMs: 600, clockOffsetMs: 0, clockSource: 'facebook-response' } } };
    } };
  const engine = new Engine(store, reader, new FakeActions());
  try {
    const result = await engine.readChecked(new AbortController().signal);
    assert.equal(result.observations!['1'].publicationDelayMs, null);
    assert.equal(result.observations!['1'].clockSource, 'unavailable');
    assert.equal(typeof result.observations!['1'].observedMonoMs, 'number');
  } finally { await engine.close(); store.close(); }
});

test('a recovered existing-post test never mixes its old request timestamp with a new clock anchor', async () => {
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test' });
  const sourceId = READ_TARGETS['test-profile'].sourceId;
  const previous = store.baseline('10', sourceId, 100, old);
  const recovered = store.testJob('10', sourceId, previous, old[0], store.config(), '2026-01-01T00:00:00.000Z');
  const engine = new Engine(store, new FakeReader([read(), read()]), new FakeActions());
  try {
    await engine.initialize();
    assert.equal(engine.testExisting('1'), recovered.id);
    await until(() => store.job(recovered.id)!.actions.every(a => a.state === 'succeeded'));
    const result = store.job(recovered.id)!;
    assert.equal(result.origin, 'existing-test');
    assert.equal(result.timing!.requestedAt, '2026-01-01T00:00:00.000Z');
    for (const action of result.actions) {
      assert.equal(action.timing!.fromRequestMs, null);
      assert.equal(action.timing!.fromPublicationMs, null);
      assert.equal(typeof action.timing!.processingMs, 'number');
    }
  } finally { await engine.close(); store.close(); }
});
