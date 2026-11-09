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
const old = ['1','2','3','4','5'].map(id=>post(id));
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
    await this.wait;hooks.signal.throwIfAborted();hooks.beforeSubmit();this.sent.push(name);return{code:'TEST_CONFIRMED'};
  }
  async stop(){this.barrier?.();} async close(){}
}
test('new verified posts create one durable job and all three actions start in parallel',async()=>{
  const store=new Store(':memory:');store.saveConfig({...DEFAULT_CONFIG,mode:'test',pollSeconds:1});
  const adapter=new FakeActions(),reader=new FakeReader([read(),read(),read([post('6',110),...old.slice(0,4)])]);
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
  const engine=new Engine(store,new FakeReader([read(),read(),read([post('6',110),...old.slice(0,4)])]),adapter);
  try{engine.start();await until(()=>entered===3);const stopping=engine.stop();assert.equal(engine.stop(),stopping);await stopping;assert.equal(sent,0);assert.equal(engine.phase,'idle');assert.ok(store.jobs()[0].actions.every(a=>a.state==='cancelled'));}
  finally{await engine.close();store.close();}
});
test('a bad or incomplete response keeps the last good five and never creates an action',async()=>{
  const store=new Store(':memory:');store.saveConfig({...DEFAULT_CONFIG,pollSeconds:1});
  const engine=new Engine(store,new FakeReader([read(),read(),{...read([post('6',110)]),usable:false}]),new FakeActions());
  try{engine.start();await until(()=>engine.consecutiveErrors===1);assert.deepEqual(engine.window,old);assert.equal(store.jobs().length,0);}
  finally{await engine.close();store.close();}
});

test('detection calibration and monotonic action timings survive a laptop clock jump', async t => {
  const published = 1794192140;
  t.mock.timers.enable({ apis: ['Date'], now: published * 1000 + 244500 });
  const store = new Store(':memory:'); store.saveConfig({ ...DEFAULT_CONFIG, mode: 'test', pollSeconds: 1 });
  const baseline = ['1','2','3','4','5'].map(id => post(id, published - 10));
  let reads = 0, jumped = false;
  const reader: Reader = {
    async prepare() { return { id: '10', name: 'Test' }; }, async openLogin() {}, async close() {},
    async read() {
      const watching = ++reads > 2;
      const result: WindowRead = { ...read(watching ? [post('6', published), ...baseline.slice(0, 4)] : baseline), serverSeconds: watching ? published + 4 : published - 1 };
      if (watching) result.observations = { '6': { observedAt: new Date().toISOString(), observedMonoMs: performance.now(),
        publicationDelayMs: 4500, uncertaintyMs: 600, clockOffsetMs: -240000, clockSource: 'facebook-response' } };
      return result;
    },
  };
  const adapter: ActionAdapter = { async prepare() {}, async stop() {}, async close() {},
    async execute(_name, _job, hooks) {
      hooks.beforeSubmit();
      if (!jumped) { t.mock.timers.tick(60000); jumped = true; }
      await delay(25); return { code: 'TEST_CONFIRMED' };
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
