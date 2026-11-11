import type { ActionName, Config, ContentPlan, Mode } from './config.ts';
export type Post = { post_id: string; creation_time: number; permalink: string | null; sourceVerification: string };
export type WindowRead = { posts: Post[]; verifiedPosts?: Post[];
  windowPolicy?: { requestedCount: number; verifiedCount: number; expanded: boolean; expansionReason: string | null }; usable: boolean; reasonCode: string | null; serverSeconds: number | null;
  firstSeenAt: string; queryPOSTsIssued: number; queryMs: number; decodedBodyBytes: number;
  observations?: Record<string, PostObservation>; readTiming?: ReadTiming };
export type PostObservation = { observedAt: string; observedMonoMs?: number; publicationDelayMs: number | null;
  uncertaintyMs: number | null; clockOffsetMs: number | null; clockSource: 'facebook-response' | 'unavailable' };
export type ReadTiming = { startedAt: string; completedAt: string; startedMonoMs: number; completedMonoMs: number;
  durationMs: number; intervalMs: number | null; waitMs: number | null; pollSeconds: number };
export type JobOrigin = 'watch' | 'existing-test' | 'unknown';
export type JobTiming = { version: 2; origin: 'watch' | 'existing-test'; requestedAt: string; detectedAt: string | null;
  publicationDelayMs: number | null; uncertaintyMs: number | null; clockOffsetMs: number | null;
  readStartedAt: string | null; readCompletedAt: string | null; previousReadCompletedAt: string | null;
  readDurationMs: number | null; readIntervalMs: number | null; pollWaitMs: number | null; pollSeconds: number | null };
export type ActionTiming = { version: 2; startedAt: string; finishedAt: string | null; queueMs: number | null;
  processingMs: number | null; fromDetectionMs: number | null; fromRequestMs: number | null;
  fromPublicationMs: number | null; uncertaintyMs: number | null;
  preparation?: ActionPreparation; trace?: ActionTraceData };
export type ActionPreparation = { readRemainderMs: number | null; dispatchWaitMs: number | null; tabsMs: number };
export type ActionStage = 'prepare_action' | 'navigate_original_post' | 'verify_original_post' | 'find_post_scope'
  | 'find_action_bar' | 'check_existing_reaction' | 'open_comment_editor' | 'fill_comment'
  | 'open_share_composer' | 'share_menu_fallback' | 'verify_share_destination' | 'set_share_audience'
  | 'fill_share' | 'verify_share_before_submit' | 'prepare_submission' | 'submit' | 'wait_server'
  | 'verify_like' | 'comment_readback_open_tab' | 'comment_readback_navigate' | 'comment_readback_verify'
  | 'comment_readback_scope' | 'comment_readback_wait' | 'comment_readback_find'
  | 'share_readback_navigate' | 'share_readback_verify' | 'share_readback_scope'
  | 'share_readback_audience' | 'share_verify_response' | 'share_verify_current_page' | 'cleanup';
export type ActionMilestone = 'submitStarted' | 'serverAcknowledged' | 'serverConfirmed'
  | 'mutationRequestObserved' | 'mutationResponseReceived' | 'mutationBodyRead' | 'submitControlFinished';
export type ActionTraceStep = { stage: ActionStage; startMs: number; endMs: number; status: 'completed' | 'running' | 'interrupted' };
export type ActionTraceData = { version: 1; implementation?: string; steps: ActionTraceStep[]; milestones: Partial<Record<ActionMilestone, number>>;
  finishedMs: number | null };
export type Account = { id: string; name: string };
export type ActionState = 'ready' | 'preparing' | 'submitting' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' | 'simulated' | 'skipped';
export type ActionResult = { name: ActionName; state: ActionState; code: string | null; startedAt: string | null;
  submittedAt: string | null; finishedAt: string | null; externalId: string | null; externalUrl: string | null;
  timing?: ActionTiming | null };
export type Job = { id: string; sessionId: string; accountId: string; sourceId: string; post: Post;
  mode: Mode; createdAt: string; plan: ContentPlan; actions: ActionResult[]; origin?: JobOrigin; timing?: JobTiming | null };
export type LogEntry = { id: number; at: string; level: 'info' | 'warning' | 'error'; code: string; text: string; jobId: string | null };
export type Reader = { prepare(target: Config['target'], signal: AbortSignal): Promise<Account>;
  read(signal: AbortSignal): Promise<WindowRead>; openLogin(): Promise<void>; close(): Promise<void> };
export type SubmitHooks = { signal: AbortSignal; beforeSubmit: () => void; onServerConfirmed?: (result: ConfirmedResult) => void;
  onStage?: (stage: ActionStage) => void; onServerResponse?: (kind: 'confirmed' | 'acknowledged') => void;
  onMilestone?: (milestone: ActionMilestone) => void; onImplementation?: (implementation: string) => void };
export type ConfirmedResult = { externalId?: string; externalUrl?: string; code?: string;
  shareProof?: { identityVerified: boolean; audience: 'only_me' | 'public' | null } };
export type ActionAdapter = { prepare(account: Account): Promise<void>;
  execute(name: ActionName, job: Job, hooks: SubmitHooks): Promise<ConfirmedResult>;
  release?: () => Promise<void>;
  reconcile?: (name: ActionName, job: Job) => Promise<ConfirmedResult | null>;
  stop(): Promise<void>; close(): Promise<void> };
