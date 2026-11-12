import type { Post, ReadTiming, WindowRead } from './types.ts';

export const SCAN_HISTORY_LIMIT = 60;
export const SCAN_SNAPSHOT_LIMIT = 80;
export type ScanPost = Pick<Post, 'post_id' | 'creation_time' | 'sourceVerification'>;
export type ScanDecision = { postId: string; reason: 'previous_window' | 'already_seen' | 'older_than_session' | 'future_time' | 'accepted'; jobId?: string };
export type ScanBatchEvidence = {
  batchIndex: number; requestedCount: number; returnedPostCount: number; selectedPostCount: number;
  queryMs: number; httpStatus: number; decodedBodyBytes: number; responseComplete: boolean;
  usable: boolean; reasonCode: string | null; serverSeconds: number | null; posts: ScanPost[];
  requestStartedAt?: number | null; headersReceivedAt?: number | null;
  parser?: { mainTimelineEdgesObserved: number; parentSourceConflict: boolean; poisonedPostIds: string[];
    unsupportedPatchCount: number; rejectedEdges: { observedPostIds: string[]; classification: string }[] } | null;
};
export type ScanRecord = {
  sequence: number; purpose: 'baseline' | 'watch'; timing: ReadTiming;
  outcome: 'valid' | 'rejected' | 'error'; errorCode: string | null; readerReasonCode: string | null;
  serverSeconds: number | null; queryPOSTsIssued: number | null; queryMs: number | null; decodedBodyBytes: number | null;
  windowPolicy: WindowRead['windowPolicy'] | null; posts: ScanPost[]; verifiedPosts: ScanPost[]; batches: ScanBatchEvidence[];
  observations: { postId: string; observedAt: string; observedMonoMs: number | null; publicationDelayMs: number | null; clockOffsetMs: number | null }[];
  selection: { state: 'not_run' | 'baseline' | 'pending' | 'committed' | 'rolled_back'; errorCode: string | null; decisions: ScanDecision[] };
};
export type ScanContext = { sessionId: string | null; accountId: string | null; sourceId: string; serverFloor: number | null };
export type ScanSnapshot = { version: 1; capacity: number; context: ScanContext; reads: ScanRecord[] };

// Explicit projection only: never retain response bodies, URLs, request forms, tokens or cursors.
const code = (value: string | null | undefined) => value && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const post = (value: ScanPost): ScanPost => ({ post_id: /^\d{1,40}$/.test(value.post_id) ? value.post_id : '[invalid]',
  creation_time: Number.isSafeInteger(value.creation_time) ? value.creation_time : 0,
  sourceVerification: /^[a-z_]{1,60}$/.test(value.sourceVerification) ? value.sourceVerification : '[invalid]' });
export function scanBatches(batches: ScanBatchEvidence[]): ScanBatchEvidence[] {
  return batches.slice(0, 2).map(batch => ({ batchIndex: batch.batchIndex, requestedCount: batch.requestedCount,
    returnedPostCount: batch.returnedPostCount, selectedPostCount: batch.selectedPostCount, queryMs: batch.queryMs,
    httpStatus: batch.httpStatus, decodedBodyBytes: batch.decodedBodyBytes, responseComplete: batch.responseComplete,
    usable: batch.usable, reasonCode: code(batch.reasonCode), serverSeconds: batch.serverSeconds, posts: batch.posts.slice(0, 5).map(post),
    requestStartedAt: batch.requestStartedAt ?? null, headersReceivedAt: batch.headersReceivedAt ?? null,
    parser: batch.parser ? { mainTimelineEdgesObserved: batch.parser.mainTimelineEdgesObserved,
      parentSourceConflict: batch.parser.parentSourceConflict, poisonedPostIds: batch.parser.poisonedPostIds.filter(id => /^\d{1,40}$/.test(id)).slice(0, 10),
      unsupportedPatchCount: batch.parser.unsupportedPatchCount,
      rejectedEdges: batch.parser.rejectedEdges.slice(0, 10).map(edge => ({ observedPostIds: edge.observedPostIds.filter(id => /^\d{1,40}$/.test(id)).slice(0, 5),
        classification: /^[a-z_]{1,80}$/.test(edge.classification) ? edge.classification : '[invalid]' })) } : null }));
}
export class ScanHistory {
  private sequence = 0;
  private reads: ScanRecord[] = [];
  clear() { this.reads = []; }
  get latest() { return this.reads.at(-1); }
  summary() { return { capacity: SCAN_HISTORY_LIMIT, retained: this.reads.length, latestSequence: this.latest?.sequence ?? null }; }
  record(timing: ReadTiming, purpose: ScanRecord['purpose'], read: WindowRead | undefined, errorCode: string | null) {
    const verified = read?.verifiedPosts ?? read?.posts ?? [];
    const item: ScanRecord = { sequence: ++this.sequence, purpose, timing: { ...timing },
      outcome: errorCode ? read ? 'rejected' : 'error' : 'valid', errorCode: code(errorCode), readerReasonCode: code(read?.reasonCode),
      serverSeconds: read?.serverSeconds ?? null, queryPOSTsIssued: read?.queryPOSTsIssued ?? null,
      queryMs: read?.queryMs ?? null, decodedBodyBytes: read?.decodedBodyBytes ?? null,
      windowPolicy: read?.windowPolicy ? { requestedCount: read.windowPolicy.requestedCount, verifiedCount: read.windowPolicy.verifiedCount,
        expanded: read.windowPolicy.expanded, expansionReason: read.windowPolicy.expansionReason === 'promotion_evidence' || read.windowPolicy.expansionReason === 'non_chronological' ? read.windowPolicy.expansionReason : null } : null,
      posts: (read?.posts ?? []).slice(0, 5).map(post), verifiedPosts: verified.slice(0, 5).map(post), batches: scanBatches(read?.scanBatches ?? []),
      observations: verified.slice(0, 5).flatMap(p => {
        const observation = read?.observations?.[p.post_id];
        return observation ? [{ postId: post(p).post_id, observedAt: observation.observedAt,
          observedMonoMs: observation.observedMonoMs ?? null, publicationDelayMs: observation.publicationDelayMs, clockOffsetMs: observation.clockOffsetMs }] : [];
      }),
      selection: { state: !errorCode && purpose === 'baseline' ? 'baseline' : 'not_run', errorCode: null, decisions: [] } };
    this.reads.push(item);
    if (this.reads.length > SCAN_HISTORY_LIMIT) this.reads.shift();
    return item;
  }
  snapshot(context: ScanContext): ScanSnapshot { return { version: 1, capacity: SCAN_HISTORY_LIMIT, context: { ...context }, reads: structuredClone(this.reads) }; }
}
