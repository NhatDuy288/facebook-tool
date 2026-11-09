import { performance } from 'node:perf_hooks';
import type { ActionMilestone, ActionStage, ActionTraceData, ActionTraceStep } from './types.ts';

// Only monotonic offsets live here. No timers, network calls or per-step database writes.
export class ActionTrace {
  private steps: ActionTraceStep[] = [];
  private milestones: ActionTraceData['milestones'] = {};
  private finishedMs: number | null = null;
  private interrupted = false;
  private started: number;
  private now: () => number;
  constructor(started: number, now: () => number = () => performance.now()) { this.started = started; this.now = now; }
  private elapsed() { return Math.max(0, this.now() - this.started); }
  enter(stage: ActionStage) {
    if (this.finishedMs !== null) return;
    const at = this.elapsed(), previous = this.steps.at(-1);
    if (previous?.stage === stage) return;
    if (previous) { previous.endMs = at; previous.status = 'completed'; }
    this.steps.push({ stage, startMs: at, endMs: at, status: 'running' });
  }
  mark(name: ActionMilestone) {
    if (this.finishedMs === null && this.milestones[name] === undefined) this.milestones[name] = this.elapsed();
  }
  finish(interrupted = false) {
    if (this.finishedMs !== null) return;
    this.finishedMs = this.elapsed(); this.interrupted = interrupted;
    const last = this.steps.at(-1);
    if (last) { last.endMs = this.finishedMs; last.status = interrupted ? 'interrupted' : 'completed'; }
  }
  snapshot(): ActionTraceData {
    const end = this.finishedMs ?? this.elapsed();
    return { version: 1, finishedMs: this.finishedMs, milestones: { ...this.milestones },
      steps: this.steps.map((step, index) => index === this.steps.length - 1
        ? { ...step, endMs: end, status: this.finishedMs === null ? 'running' : this.interrupted ? 'interrupted' : 'completed' }
        : { ...step }) };
  }
}
