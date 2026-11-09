import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, validateConfig, planContent, ACTIONS, type Config, type ContentPlan, type ActionName } from './config.ts';
import type { Job, Post, ActionResult, ActionState, LogEntry, JobTiming, ActionTiming } from './types.ts';
const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
        started_at TEXT NOT NULL, server_floor INTEGER NOT NULL, window_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (account_id TEXT NOT NULL, source_id TEXT NOT NULL, post_id TEXT NOT NULL,
        creation_time INTEGER NOT NULL, first_session TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(account_id, source_id, post_id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, dedupe TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
        account_id TEXT NOT NULL, source_id TEXT NOT NULL, post_json TEXT NOT NULL, mode TEXT NOT NULL,
        created_at TEXT NOT NULL, plan_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL, state TEXT NOT NULL,
        code TEXT, started_at TEXT, submitted_at TEXT, finished_at TEXT, external_id TEXT, external_url TEXT,
        PRIMARY KEY(job_id, name));
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL,
        code TEXT NOT NULL, text TEXT NOT NULL, job_id TEXT);
      CREATE TABLE IF NOT EXISTS job_timings (job_id TEXT PRIMARY KEY REFERENCES jobs(id), details_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_timings (job_id TEXT NOT NULL REFERENCES jobs(id), name TEXT NOT NULL,
        details_json TEXT NOT NULL, PRIMARY KEY(job_id,name));
      CREATE INDEX IF NOT EXISTS logs_at ON logs(at);`);
    if (!this.get('config')) this.set('config', DEFAULT_CONFIG);
    if (this.get('commentCursor') === null) this.set('commentCursor', 0);
    // Never resend an interrupted external submission automatically.
    this.db.prepare("UPDATE actions SET state='unknown', code='RESULT_UNCONFIRMED', finished_at=? WHERE state='submitting'").run(now());
    this.db.prepare("UPDATE actions SET state='ready', code='INTERRUPTED_BEFORE_SEND' WHERE state='preparing'").run();
    this.pruneLogs();
  }
  get(key: string): any { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any; return row ? JSON.parse(row.value) : null; }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  config(): Config { return validateConfig(this.get('config')); }
  saveConfig(input: unknown): Config { const c = validateConfig(input); this.set('config', c); return c; }
  nextPlan(config = this.config()): ContentPlan { return planContent(config, this.get('commentCursor') ?? 0); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  baseline(accountId: string, sourceId: string, floor: number, posts: Post[]): string {
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(id, accountId, sourceId, now(), floor, JSON.stringify(posts));
      for (const post of posts) this.recordSeen(accountId, sourceId, post, id, 'baseline');
      return id;
    });
  }
  recordSeen(accountId: string, sourceId: string, post: Post, sessionId: string, reason: string) {
    this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?,?,?,?,?)').run(accountId, sourceId, post.post_id, post.creation_time, sessionId, reason);
  }
  hasSeen(accountId: string, sourceId: string, postId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen WHERE account_id=? AND source_id=? AND post_id=?').get(accountId, sourceId, postId);
  }
  acceptWindow(input: { accountId: string; sourceId: string; sessionId: string; floor: number; serverNow: number;
    posts: Post[]; previous: Set<string>; config: Config; timings?: Record<string, JobTiming> }): Job[] {
    return this.transaction(() => {
      const ids: string[] = [];
      for (const post of input.posts) {
        if (input.previous.has(post.post_id) || this.hasSeen(input.accountId, input.sourceId, post.post_id)) continue;
        if (post.creation_time > input.serverNow + 2) throw Error('POST_TIME_INVALID');
        if (post.creation_time < input.floor) { this.recordSeen(input.accountId, input.sourceId, post, input.sessionId, 'older_than_session'); continue; }
        ids.push(this.insertJob(input.accountId, input.sourceId, input.sessionId, post, input.config, input.timings?.[post.post_id]));
        this.recordSeen(input.accountId, input.sourceId, post, input.sessionId, 'job_created');
      }
      this.db.prepare('UPDATE sessions SET window_json=? WHERE id=?').run(JSON.stringify(input.posts), input.sessionId);
      return ids.map(id => this.job(id)!);
    });
  }
  insertJob(accountId: string, sourceId: string, sessionId: string, post: Post, config: Config, timing?: JobTiming): string {
    const dedupe = `${accountId}:${sourceId}:${post.post_id}:${config.mode === 'dry-run' ? 'simulation' : 'write'}`;
    const existing = this.db.prepare('SELECT id FROM jobs WHERE dedupe=?').get(dedupe) as any;
    if (existing) return existing.id;
    const id = randomUUID(), plan = this.nextPlan(config);
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(id, dedupe, sessionId, accountId, sourceId, JSON.stringify(post), config.mode, now(), JSON.stringify(plan));
    if (timing) this.db.prepare('INSERT INTO job_timings VALUES (?,?)').run(id, JSON.stringify(timing));
    for (const action of ACTIONS) this.db.prepare('INSERT INTO actions(job_id,name,state) VALUES (?,?,?)')
      .run(id, action, !config.actions[action] ? 'skipped' : config.mode === 'dry-run' ? 'simulated' : 'ready');
    if (config.actions.comment) this.set('commentCursor', plan.cursor + 1);
    return id;
  }
  testJob(accountId: string, sourceId: string, sessionId: string, post: Post, config: Config, requestedAt = now()): Job {
    const timing: JobTiming = { version: 2, origin: 'existing-test', requestedAt, detectedAt: null,
      publicationDelayMs: null, uncertaintyMs: null, clockOffsetMs: null, readStartedAt: null, readCompletedAt: null,
      previousReadCompletedAt: null, readDurationMs: null, readIntervalMs: null, pollWaitMs: null, pollSeconds: null };
    return this.transaction(() => this.job(this.insertJob(accountId, sourceId, sessionId, post, config, timing))!);
  }
  job(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any;
    if (!row) return null;
    const actions = this.db.prepare('SELECT a.*,t.details_json AS timing_json FROM actions a LEFT JOIN action_timings t ON t.job_id=a.job_id AND t.name=a.name WHERE a.job_id=? ORDER BY a.name').all(id) as any[];
    const timingRow = this.db.prepare('SELECT details_json FROM job_timings WHERE job_id=?').get(id) as any;
    const timing: JobTiming | null = timingRow ? JSON.parse(timingRow.details_json) : null;
    const seen = this.db.prepare('SELECT reason FROM seen WHERE account_id=? AND source_id=? AND post_id=?').get(row.account_id, row.source_id, JSON.parse(row.post_json).post_id) as any;
    const origin = timing?.origin ?? (seen?.reason === 'job_created' ? 'watch' : seen?.reason === 'baseline' ? 'existing-test' : 'unknown');
    return { id: row.id, sessionId: row.session_id, accountId: row.account_id, sourceId: row.source_id,
      post: JSON.parse(row.post_json), mode: row.mode, createdAt: row.created_at, plan: JSON.parse(row.plan_json), timing, origin,
      actions: actions.map(a => ({ name: a.name, state: a.state, code: a.code, startedAt: a.started_at, submittedAt: a.submitted_at,
        finishedAt: a.finished_at, externalId: a.external_id, externalUrl: a.external_url, timing: a.timing_json ? JSON.parse(a.timing_json) : null })) };
  }
  jobs(limit = 60): Job[] { return (this.db.prepare('SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(r => this.job(r.id)!); }
  transition(jobId: string, name: ActionName, from: ActionState[], to: ActionState,
    detail: { code?: string; externalId?: string; externalUrl?: string; timing?: ActionTiming } = {}): boolean {
    const timestamp = now();
    return this.transaction(() => {
    const changed = this.db.prepare(`UPDATE actions SET state=?,code=?,external_id=COALESCE(?,external_id),external_url=COALESCE(?,external_url),
      started_at=CASE WHEN ?='preparing' THEN ? ELSE started_at END,
      submitted_at=CASE WHEN ?='submitting' THEN ? ELSE submitted_at END,
      finished_at=CASE WHEN ? IN ('succeeded','failed','unknown','cancelled','simulated') THEN ? ELSE NULL END
      WHERE job_id=? AND name=? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, detail.code ?? null, detail.externalId ?? null, detail.externalUrl ?? null, to, timestamp, to, timestamp, to, timestamp,
        jobId, name, ...from).changes > 0;
    if (changed && detail.timing) this.db.prepare('INSERT INTO action_timings VALUES (?,?,?) ON CONFLICT(job_id,name) DO UPDATE SET details_json=excluded.details_json').run(jobId, name, JSON.stringify(detail.timing));
    if (changed && (to === 'ready' || ['RECONCILED_EXISTING', 'MANUALLY_CONFIRMED'].includes(detail.code || '')))
      this.db.prepare('DELETE FROM action_timings WHERE job_id=? AND name=?').run(jobId, name);
    return changed;
    });
  }
  resolve(jobId: string, name: ActionName, result: 'done' | 'not_sent'): void {
    if (!this.transition(jobId, name, ['unknown'], result === 'done' ? 'succeeded' : 'ready',
      { code: result === 'done' ? 'MANUALLY_CONFIRMED' : 'MANUALLY_NOT_SENT' })) throw Error('JOB_NOT_RETRYABLE');
    this.log('warning', 'MANUAL_RECONCILIATION', `Người vận hành xác nhận ${name}: ${result === 'done' ? 'đã thành công' : 'chưa gửi'}.`, jobId);
  }
  evidence(jobId: string, name: ActionName, detail: { externalId?: string; externalUrl?: string }) {
    this.db.prepare("UPDATE actions SET external_id=COALESCE(?,external_id),external_url=COALESCE(?,external_url) WHERE job_id=? AND name=? AND state='submitting'")
      .run(detail.externalId ?? null, detail.externalUrl ?? null, jobId, name);
  }
  log(level: LogEntry['level'], code: string, text: string, jobId: string | null = null) {
    this.db.prepare('INSERT INTO logs(at,level,code,text,job_id) VALUES (?,?,?,?,?)').run(now(), level, code, text, jobId);
  }
  logs(limit = 100): LogEntry[] { return this.db.prepare('SELECT id,at,level,code,text,job_id AS jobId FROM logs ORDER BY id DESC LIMIT ?').all(limit) as any; }
  pruneLogs() { this.db.prepare("DELETE FROM logs WHERE at < ?").run(new Date(Date.now() - 30 * 86400_000).toISOString()); }
  close() { this.db.close(); }
}
