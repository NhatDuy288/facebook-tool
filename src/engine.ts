import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { ACTIONS, READ_WINDOW_SIZE, type Config, type ActionName } from './config.ts';
import { READ_TARGETS } from './facebook/feed/read-target.ts';
import { Store } from './store.ts';
import { errorCode, message } from './errors.ts';
import { ActionTrace } from './action-trace.ts';
import { ScanHistory, type ScanRecord, type ScanSnapshot } from './scan-history.ts';
import type { Reader, ActionAdapter, Account, WindowRead, Post, Job, JobTiming, ActionTiming, ReadTiming, ActionPreparation } from './types.ts';
export type Phase = 'idle' | 'initializing' | 'ready' | 'watching' | 'stopping' | 'error';
export class Engine {
  store: Store; reader: Reader; adapter: ActionAdapter;
  phase: Phase = 'idle'; note = 'Sẵn sàng. Mở Facebook để đăng nhập tài khoản theo dõi.';
  account: Account | null = null; sessionId: string | null = null; floor: number | null = null;
  window: Post[] = []; lastRead: WindowRead | null = null;
  lastReadAt: string | null = null; nextReadAt: string | null = null;
  readCount = 0; consecutiveErrors = 0; queryCount = 0; bytesRead = 0; activeJob: string | null = null;
  abort = new AbortController(); workTask: Promise<void> | null = null; dispatchTask: Promise<void> | null = null;
  stoppingTask: Promise<void> | null = null;
  queue: string[] = []; closed = false;
  lastReadTiming: ReadTiming | null = null;
  scanHistory = new ScanHistory();
  pendingScanSnapshots: { trigger: 'detection' | 'read_error' | 'stop'; jobId: string | null; snapshot: ScanSnapshot }[] = [];
  jobClocks = new Map<string, { referenceMono: number; requestedMono: number; readCompletedMono: number; origin: 'watch' | 'existing-test'; publicationDelayMs: number | null; uncertaintyMs: number | null }>();
  activeTraces = new Map<string, { trace: ActionTrace; timing: ActionTiming }>();
  constructor(store: Store, reader: Reader, adapter: ActionAdapter) { this.store = store; this.reader = reader; this.adapter = adapter; }
  busy() { return ['initializing', 'watching', 'stopping'].includes(this.phase) || !!this.activeJob || this.queue.length > 0; }
  status() {
    const config = this.store.config();
    const observation = Object.values(this.lastRead?.observations ?? {})[0];
    return { phase: this.phase, note: this.note, config, account: this.account,
      source: READ_TARGETS[config.target], sessionId: this.sessionId, serverFloor: this.floor,
      posts: this.window, windowSize: READ_WINDOW_SIZE, readWindow: this.lastRead?.windowPolicy ?? null, nextComment: this.store.nextPlan().comment, lastReadAt: this.lastReadAt, nextReadAt: this.nextReadAt,
      metrics: { reads: this.readCount, queries: this.queryCount, decodedBytes: this.bytesRead, lastQueryMs: this.lastRead?.queryMs ?? null,
        lastReadDurationMs: this.lastReadTiming?.durationMs ?? null, lastReadIntervalMs: this.lastReadTiming?.intervalMs ?? null,
        lastPollWaitMs: this.lastReadTiming?.waitMs ?? null,
        facebookClockOffsetMs: observation?.clockOffsetMs ?? null, clockUncertaintyMs: observation?.uncertaintyMs ?? null,
        errors: this.consecutiveErrors, nodeMemoryMB: Math.round(process.memoryUsage().rss / 1048576) },
      scanHistory: { ...this.scanHistory.summary(), pendingSnapshots: this.pendingScanSnapshots.length },
      activeJob: this.activeJob, queuedJobs: this.queue.length, jobs: this.store.jobs().map(job => ({ ...job,
        actions: job.actions.map(action => {
          const active = this.activeTraces.get(job.id + ':' + action.name);
          return active ? { ...action, timing: { ...active.timing, trace: active.trace.snapshot() } } : action;
        }) })), logs: this.store.logs() };
  }
  saveConfig(input: unknown): Config {
    const current = this.store.config();
    // Validation precedes persistence, and unsafe configuration changes are refused during a run.
    const checked = validate(input);
    if (this.busy() && (checked.target !== current.target || checked.mode !== current.mode || checked.keepSession !== current.keepSession)) throw Error('BUSY');
    const result = this.store.saveConfig(checked);
    if (checked.target !== current.target) { this.window = []; this.sessionId = null; this.floor = null; this.phase = 'idle'; this.account = null; }
    this.store.log('info', 'CONFIG_SAVED', 'Đã lưu cấu hình. Việc đã nhận giữ nguyên nội dung; việc tiếp theo dùng cấu hình mới.');
    return result;
  }
  async openLogin() { await this.reader.openLogin(); }
  scanSnapshot(): ScanSnapshot {
    return this.scanHistory.snapshot({ sessionId: this.sessionId, accountId: this.account?.id ?? null,
      sourceId: READ_TARGETS[this.store.config().target].sourceId, serverFloor: this.floor });
  }
  scanDiagnostics() { return { recent: this.scanSnapshot(), saved: this.store.scanSnapshots() }; }
  rememberScanSnapshot(trigger: 'detection' | 'read_error' | 'stop', jobId: string | null = null) {
    if (!this.scanHistory.latest) return;
    this.pendingScanSnapshots.push({ trigger, jobId, snapshot: this.scanSnapshot() });
    // A bounded queue also covers a long-running interaction while reads keep failing.
    if (this.pendingScanSnapshots.length > 80) this.pendingScanSnapshots.shift();
  }
  flushScanSnapshots() {
    // Diagnostics never add a synchronous disk write before/during an interaction.
    if (this.activeJob) return;
    for (const pending of this.pendingScanSnapshots.splice(0)) {
      try { this.store.saveScanSnapshot(pending.trigger, pending.jobId, pending.snapshot); }
      catch { try { this.store.log('warning', 'SCAN_HISTORY_SAVE_FAILED', 'Không lưu được lịch sử quét chẩn đoán.'); } catch { /* Must not alter action state. */ } }
    }
  }
  baseline(): void {
    if (this.closed || this.busy()) throw Error('BUSY');
    this.workTask = this.initialize().catch(e => this.fail(e));
  }
  start(): void {
    if (this.closed || this.busy()) throw Error('BUSY');
    this.workTask = this.run().catch(e => this.fail(e));
  }
  async initialize(): Promise<void> {
    this.abort = new AbortController(); const signal = this.abort.signal;
    this.phase = 'initializing'; this.note = 'Đang xác minh tài khoản, chuẩn bị cách đọc nền và lấy mốc 3 bài…';
    this.sessionId = null; this.floor = null; this.window = []; this.lastRead = null; this.account = null;
    this.readCount = 0; this.queryCount = 0; this.bytesRead = 0; this.consecutiveErrors = 0;
    this.nextReadAt = null;
    this.lastReadTiming = null; this.jobClocks.clear(); this.flushScanSnapshots(); this.scanHistory.clear();
    const config = this.store.config();
    this.account = await this.reader.prepare(config.target, signal); signal.throwIfAborted();
    if (config.mode !== 'dry-run') await this.adapter.prepare(this.account);
    else await this.adapter.stop();
    signal.throwIfAborted();
    const first = await this.readChecked(signal); signal.throwIfAborted();
    const second = await this.readChecked(signal); signal.throwIfAborted();
    this.floor = second.serverSeconds;
    if (this.floor === null) throw Error('SERVER_TIME_REQUIRED');
    this.sessionId = this.store.baseline(this.account.id, READ_TARGETS[config.target].sourceId, this.floor, (second.verifiedPosts ?? second.posts));
    // Both baseline reads are ignored, even if a post enters between them.
    for (const p of first.verifiedPosts ?? first.posts) this.store.recordSeen(this.account.id, READ_TARGETS[config.target].sourceId, p, this.sessionId, 'baseline');
    this.window = second.posts;
    this.phase = 'ready'; this.note = 'Đã lấy mốc 3 bài. Các bài có sẵn được bỏ qua.';
    this.store.log('info', 'BASELINE_READY', `Đã lấy mốc 3 bài cho ${config.target}; chưa gửi tương tác.`);
  }
  async run(): Promise<void> {
    await this.initialize();
    const signal = this.abort.signal; signal.throwIfAborted();
    this.phase = 'watching'; this.note = 'Đang theo dõi bài mới bằng đọc nền.';
    while (!signal.aborted) {
      const waitMs = this.store.config().pollSeconds * 1000;
      this.nextReadAt = new Date(Date.now() + waitMs).toISOString();
      await delay(waitMs, undefined, { signal }); this.nextReadAt = null;
      let scan: ScanRecord | undefined;
      try {
        const read = await this.readChecked(signal); signal.throwIfAborted();
        scan = this.scanHistory.latest;
        const config = this.store.config();
        const requestedAt = new Date().toISOString(), requestedMono = performance.now();
        const timings: Record<string, JobTiming> = {};
        for (const post of read.verifiedPosts ?? read.posts) {
          const observed = read.observations?.[post.post_id], trace = read.readTiming!;
          timings[post.post_id] = { version: 2, origin: 'watch', requestedAt,
            detectedAt: observed?.observedAt ?? trace.completedAt, publicationDelayMs: observed?.publicationDelayMs ?? null,
            uncertaintyMs: observed?.uncertaintyMs ?? null, clockOffsetMs: observed?.clockOffsetMs ?? null,
            readStartedAt: trace.startedAt, readCompletedAt: trace.completedAt,
            previousReadCompletedAt: this.previousReadCompletedAt,
            readDurationMs: trace.durationMs, readIntervalMs: trace.intervalMs, pollWaitMs: trace.waitMs, pollSeconds: trace.pollSeconds };
        }
        if (scan) scan.selection.state = 'pending';
        const jobs = this.store.acceptWindow({ accountId: this.account!.id, sourceId: READ_TARGETS[config.target].sourceId,
          sessionId: this.sessionId!, floor: this.floor!, serverNow: read.serverSeconds!,
          posts: read.verifiedPosts ?? read.posts, previous: new Set(this.window.map(p => p.post_id)), config, timings,
          onDecision: decision => { scan?.selection.decisions.push(decision); } });
        if (scan) scan.selection.state = 'committed';
        this.window = read.posts; this.consecutiveErrors = 0; this.note = 'Đang theo dõi bài mới bằng đọc nền.';
        for (const job of jobs) this.rememberScanSnapshot('detection', job.id);
        for (const job of jobs) {
          const observed = read.observations?.[job.post.post_id];
          this.jobClocks.set(job.id, { referenceMono: observed?.observedMonoMs ?? read.readTiming!.completedMonoMs,
            requestedMono, readCompletedMono: read.readTiming!.completedMonoMs, origin: 'watch', publicationDelayMs: job.timing?.publicationDelayMs ?? null,
            uncertaintyMs: job.timing?.uncertaintyMs ?? null });
          this.store.log('info', job.mode === 'dry-run' ? 'POST_SIMULATED' : 'POST_DETECTED',
            `Nhận bài mới ${job.post.post_id}; ${job.mode === 'dry-run' ? 'đã ghi thao tác dự kiến' : 'đã lưu nội dung và công việc'}.`, job.id);
          if (job.mode !== 'dry-run') this.enqueue(job.id);
        }
        this.flushScanSnapshots();
      } catch (error) {
        if (signal.aborted) throw error;
        const code = errorCode(error); this.consecutiveErrors++;
        if (scan?.selection.state === 'pending') { scan.selection.state = 'rolled_back'; scan.selection.errorCode = code; }
        this.rememberScanSnapshot('read_error'); this.flushScanSnapshots();
        if (code === 'DATABASE_FAILED') throw error;
        this.note = message(code) + ` Lỗi liên tiếp: ${this.consecutiveErrors}/3.`;
        this.store.log('warning', code, this.note);
        if (['LOGIN_REQUIRED', 'LOGIN_OR_CHECKPOINT', 'ACTOR_CHANGED', 'PERSONAL_ACCOUNT_REQUIRED'].includes(code) || this.consecutiveErrors >= 3) throw error;
      }
    }
  }
  previousReadCompletedAt: string | null = null;
  async readChecked(signal: AbortSignal): Promise<WindowRead> {
    const previous = this.lastReadTiming, startedAt = new Date().toISOString(), startedMonoMs = performance.now();
    const purpose = this.phase === 'initializing' ? 'baseline' : 'watch';
    let read: WindowRead | undefined, failure: string | null = null;
    try {
      try { read = await this.reader.read(signal); }
      finally {
        const completedMonoMs = performance.now(), completedAt = new Date().toISOString();
        this.previousReadCompletedAt = previous?.completedAt ?? null;
        this.lastReadTiming = { startedAt, completedAt, startedMonoMs, completedMonoMs,
          durationMs: completedMonoMs - startedMonoMs, intervalMs: previous ? startedMonoMs - previous.startedMonoMs : null,
          waitMs: previous ? startedMonoMs - previous.completedMonoMs : null, pollSeconds: this.store.config().pollSeconds };
      }
      signal.throwIfAborted();
      const { completedMonoMs, completedAt } = this.lastReadTiming!;
      // A wall-clock correction during the read invalidates the clock calibration.
      // Keep monotonic observation/processing measurements; never publish a skewed latency.
      const wallElapsed = Date.parse(completedAt) - Date.parse(startedAt);
      if (Math.abs(wallElapsed - (completedMonoMs - startedMonoMs)) > 250 && read.observations) {
        read.observations = Object.fromEntries(Object.entries(read.observations).map(([id, observation]) => [id,
          { ...observation, publicationDelayMs: null, uncertaintyMs: null, clockOffsetMs: null, clockSource: 'unavailable' as const }]));
      }
      read.readTiming = this.lastReadTiming!;
      this.readCount++; this.queryCount += read.queryPOSTsIssued; this.bytesRead += read.decodedBodyBytes;
      const verified = read.verifiedPosts ?? read.posts;
      if (!read.usable || read.posts.length !== READ_WINDOW_SIZE || ![READ_WINDOW_SIZE, 5].includes(verified.length)
        || new Set(read.posts.map(p => p.post_id)).size !== READ_WINDOW_SIZE
        || new Set(verified.map(p => p.post_id)).size !== verified.length
        || read.posts.some(p => !verified.some(v => v.post_id === p.post_id && v.creation_time === p.creation_time && v.sourceVerification === p.sourceVerification))) throw Error('UNUSABLE_WINDOW');
      if (!Number.isSafeInteger(read.serverSeconds) || read.serverSeconds! < 1) throw Error('SERVER_TIME_REQUIRED');
      if (verified.some(p => !/^\d+$/.test(p.post_id) || !Number.isSafeInteger(p.creation_time) || !p.sourceVerification)) throw Error('UNUSABLE_WINDOW');
      this.lastRead = read; this.lastReadAt = completedAt; return read;
    } catch (error) { failure = signal.aborted ? 'STOPPED' : errorCode(error); throw error; }
    finally { this.scanHistory.record(this.lastReadTiming!, purpose, read, failure); }
  }
  testExisting(postId: string): string {
    if (this.busy() || this.phase !== 'ready') throw Error('BUSY');
    const config = this.store.config();
    if (config.target !== 'test-profile' || config.mode !== 'test') throw Error('TEST_SOURCE_ONLY');
    const post = this.window.find(p => p.post_id === postId);
    if (!post || !this.account || !this.sessionId) throw Error('NO_BASELINE');
    const referenceMono = performance.now(), requestedAt = new Date().toISOString();
    const job = this.store.testJob(this.account.id, READ_TARGETS[config.target].sourceId, this.sessionId, post, config, requestedAt);
    if (!this.jobClocks.has(job.id) && job.timing?.requestedAt === requestedAt) this.jobClocks.set(job.id, { referenceMono, requestedMono: referenceMono, readCompletedMono: referenceMono,
      origin: 'existing-test', publicationDelayMs: null, uncertaintyMs: null });
    this.enqueue(job.id); return job.id;
  }
  enqueue(id: string) {
    if (this.queue.includes(id) || this.activeJob === id) return;
    if (this.queue.length >= 200) throw Error('BUSY');
    this.queue.push(id);
    this.kickDispatch();
  }
  kickDispatch() {
    if (this.abort.signal.aborted || !this.queue.length) return;
    if (!this.dispatchTask) {
      this.dispatchTask = this.dispatch().catch(e => this.fail(e)).finally(() => {
        this.dispatchTask = null;
        this.kickDispatch();
      });
    }
  }
  resume(id: string) {
    if (this.activeJob === id || this.queue.includes(id)) throw Error('BUSY');
    if (!['ready', 'watching'].includes(this.phase) || this.abort.signal.aborted || !this.account) throw Error('NO_BASELINE');
    const job = this.store.job(id), config = this.store.config();
    if (!job || job.accountId !== this.account.id || job.sourceId !== READ_TARGETS[config.target].sourceId || job.mode !== config.mode
      || !job.actions.some(a => ['ready', 'failed', 'cancelled'].includes(a.state))) throw Error('JOB_NOT_RETRYABLE');
    for (const a of job.actions) this.store.transition(id, a.name, ['failed', 'cancelled'], 'ready', { code: 'OPERATOR_RESUME' });
    this.enqueue(id);
  }
  async reconcile(id: string, name: ActionName) {
    if (this.busy() || !this.account) throw Error('BUSY');
    const job = this.store.job(id);
    if (!job || job.accountId !== this.account.id || job.actions.find(a => a.name === name)?.state !== 'unknown' || !this.adapter.reconcile)
      throw Error('JOB_NOT_RETRYABLE');
    const result = await this.adapter.reconcile(name, job);
    if (result) {
      this.store.transition(id, name, ['unknown'], 'succeeded', { ...result, code: 'RECONCILED_EXISTING' });
      this.store.log('info', 'RECONCILED_EXISTING', `${name}: đã tìm thấy kết quả trên Facebook; không gửi thêm.`, id);
    }
    return { confirmed: !!result };
  }
  async dispatch(): Promise<void> {
    const signal = this.abort.signal;
    while (this.queue.length && !signal.aborted) {
      const id = this.queue.shift()!, job = this.store.job(id)!; this.activeJob = id;
      try {
        const dispatchStarted = performance.now(), clock = this.jobClocks.get(id);
        await this.adapter.prepare(this.account!); signal.throwIfAborted();
        const preparation: ActionPreparation = {
          readRemainderMs: clock ? Math.max(0, clock.readCompletedMono - clock.referenceMono) : null,
          dispatchWaitMs: clock ? Math.max(0, dispatchStarted - clock.readCompletedMono) : null,
          tabsMs: performance.now() - dispatchStarted };
        // Each worker owns a separate tab; all enabled actions enter together.
        await Promise.all(ACTIONS.map(name => this.perform(name, job, signal, preparation)));
      } finally { await this.adapter.release?.(); this.activeJob = null; this.flushScanSnapshots(); }
    }
  }
  async perform(name: ActionName, job: Job, signal: AbortSignal, preparation?: ActionPreparation): Promise<void> {
    const started = performance.now(), startedAt = new Date().toISOString(), clock = this.jobClocks.get(job.id);
    const trace = new ActionTrace(started); trace.enter('prepare_action');
    const initialTiming: ActionTiming = { version: 3, startedAt, finishedAt: null, sentAt: null, queueMs: clock ? started - clock.referenceMono : null,
      processingMs: null, fromDetectionMs: null, fromRequestMs: null, fromPublicationMs: null, uncertaintyMs: clock?.uncertaintyMs ?? null,
      preparation, trace: trace.snapshot() };
    if (signal.aborted || !this.store.transition(job.id, name, ['ready'], 'preparing', { timing: initialTiming })) return;
    const traceKey = job.id + ':' + name;
    this.activeTraces.set(traceKey, { trace, timing: initialTiming });
    let submitted = false, trackingOpen = true;
    let sentTiming: ActionTiming | null = null;
    const recordSent = () => {
      if (!trackingOpen || !submitted || sentTiming) return;
      const finished = performance.now(), fromReference = clock ? finished - clock.referenceMono : null;
      trace.mark('submissionSent'); trace.finish();
      const sentAt = new Date().toISOString();
      sentTiming = { ...initialTiming, trace: trace.snapshot(), finishedAt: sentAt, sentAt, processingMs: finished - started,
        fromDetectionMs: clock?.origin === 'watch' ? fromReference : null,
        fromRequestMs: clock ? finished - clock.requestedMono : null,
        fromPublicationMs: clock?.origin === 'watch' && clock.publicationDelayMs !== null && fromReference !== null
          ? clock.publicationDelayMs + fromReference : null };
      this.activeTraces.set(traceKey, { trace, timing: sentTiming });
    };
    const finishTiming = (): ActionTiming => sentTiming ?? { ...initialTiming, trace: trace.snapshot() };
    try {
      const result = await this.adapter.execute(name, job, { signal,
        onStage: stage => trace.enter(stage),
        onSubmitted: recordSent,
        onServerConfirmed: result => this.store.evidence(job.id, name, result), beforeSubmit: () => {
        signal.throwIfAborted();
        if (!this.store.transition(job.id, name, ['preparing'], 'submitting')) throw Error('STOPPED');
        submitted = true; trace.mark('submitStarted'); signal.throwIfAborted();
      } });
      trace.finish();
      this.store.transition(job.id, name, ['preparing', 'submitting'], 'succeeded', { ...result, timing: finishTiming() });
      this.store.log('info', 'ACTION_SUCCEEDED', `${name}: đã xác nhận kết quả.`, job.id);
    } catch (error) {
      trace.finish(true);
      const actionCode = error instanceof Error && ['TimeoutError'].includes(error.name) ? 'UI_UNSUPPORTED' : errorCode(error);
      const code = submitted ? 'RESULT_UNCONFIRMED' : signal.aborted ? 'STOPPED' : actionCode;
      this.store.transition(job.id, name, ['preparing', 'submitting'], submitted ? 'unknown' : signal.aborted ? 'cancelled' : 'failed', { code, timing: finishTiming() });
      this.store.log(submitted ? 'warning' : 'error', code, `${name}: ${message(code)}`, job.id);
      if (['LOGIN_REQUIRED', 'LOGIN_OR_CHECKPOINT', 'ACTOR_CHANGED', 'PERSONAL_ACCOUNT_REQUIRED'].includes(errorCode(error))) {
        this.abort.abort(); this.queue = []; void this.adapter.stop(); this.phase = 'error'; this.note = message(errorCode(error));
      }
    } finally { trackingOpen = false; this.activeTraces.delete(traceKey); }
  }
  fail(error: unknown) {
    if (this.abort.signal.aborted) { if (this.phase !== 'error' && this.phase !== 'stopping') { this.phase = 'idle'; this.note = message('STOPPED'); } return; }
    const code = errorCode(error);
    if (this.phase === 'initializing') { this.rememberScanSnapshot('read_error'); this.flushScanSnapshots(); }
    this.abort.abort(); this.queue = []; this.nextReadAt = null;
    this.phase = 'error'; this.note = message(code);
    try { this.store.log('error', code, this.note); } catch { this.note = message('DATABASE_FAILED'); }
    void this.adapter.stop();
  }
  stop(): Promise<void> {
    if (this.stoppingTask) return this.stoppingTask;
    this.stoppingTask = this.doStop().finally(() => { this.stoppingTask = null; });
    return this.stoppingTask;
  }
  async doStop(): Promise<void> {
    this.phase = 'stopping'; this.note = 'Đang dừng; thao tác đã gửi sẽ giữ trạng thái để kiểm tra kết quả.';
    this.abort.abort(); this.queue = []; this.nextReadAt = null;
    await this.adapter.stop();
    await Promise.allSettled([this.workTask, this.dispatchTask].filter(Boolean));
    this.rememberScanSnapshot('stop'); this.flushScanSnapshots();
    this.phase = 'idle'; this.note = message('STOPPED');
    this.store.log('info', 'STOPPED', this.note);
  }
  async close() { if (this.closed) return; this.closed = true; await this.stop(); await this.reader.close(); await this.adapter.close(); }
}
import { validateConfig as validate } from './config.ts';
