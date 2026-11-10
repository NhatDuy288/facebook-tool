// Bounded source-bound window; a three-post head may expand to five on ordering/promotion evidence.
import type { Page } from 'playwright-core';
import { performance } from 'node:perf_hooks';
import type { BrowserReadResponse } from './browser-read.ts';
import { SOURCE_ID, FB_ORIGIN } from './capture.ts';
import type { AuthPost, AuthWindowResult } from './capture.ts';
import { READ_TARGETS, matchesReadTargetUrl, type ReadTarget, type ReadSourceId } from './read-target.ts';
import { getObservedContinuation, type ObservedContinuation } from './observed-query-store.ts';
import { parseRecords } from './query-parser.mjs';
const revision = new URL(import.meta.url).search;
const browserUrl = new URL('./browser-read.ts', import.meta.url); browserUrl.search = revision;
const captureUrl = new URL('./capture.ts', import.meta.url); captureUrl.search = revision;
const rootUrl = new URL('./refetch-root.ts', import.meta.url); rootUrl.search = revision;
const { readThroughBrowser }: typeof import('./browser-read.ts') = await import(browserUrl.href);
const { inspectAuthWindow }: typeof import('./capture.ts') = await import(captureUrl.href);
const { normalizeRefetchRoot }: typeof import('./refetch-root.ts') = await import(rootUrl.href);
const MAX_BYTES = 8 * 1024 * 1024;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
// Structural transport contract; the app forwards it without recalculating wall-clock deltas.
export type PostObservation = { observedAt: string; observedMonoMs?: number; publicationDelayMs: number | null;
  uncertaintyMs: number | null; clockOffsetMs: number | null; clockSource: 'facebook-response' | 'unavailable' };

export type SafeWindowBatch = { batchIndex: number; requestedCount: number; requestedStreamCount: number | null;
  returnedPostCount: number; selectedPostCount: number; queryMs: number; httpStatus: number; decodedBodyBytes: number;
  responseComplete: boolean; usable: boolean; reasonCode: string | null; posts: AuthPost[]; markerMatchIds: string[];
  hasNextPage: boolean | null; endCursorPresent: boolean; serverSeconds: number | null; inspection: AuthWindowResult['safeInspection'] };
export type CompleteWindowResult = AuthWindowResult & { serverSeconds: number | null; firstSeenAt: string;
  observations: Record<string, PostObservation>;
  batches: SafeWindowBatch[]; queryPOSTsIssued: number; receivedOrderChronologicalDescending: boolean | null;
  windowSize: 3 | 5; expansionReason: 'promotion_evidence' | 'non_chronological' | null;
  actualNewestFiveGuaranteed: false };
export type CompleteWindowOptions = { observedTemplate?: ObservedContinuation; marker?: string;
  maxBatches?: 1 | 2; signal?: AbortSignal; target?: ReadTarget; windowSize?: 3 | 5; expandOnRisk?: boolean };

function responseServerMs(response: BrowserReadResponse): number | null {
  const date = response.headers().date;
  const ms = date ? Date.parse(date) : NaN;
  // Facebook sends an HTTP IMF-fixdate. Do not accept Date.parse's loose dates or rollover.
  return Number.isFinite(ms) && new Date(ms).toUTCString() === date ? ms : null;
}

function observePost(post: AuthPost, response: BrowserReadResponse, serverMs: number | null,
  observedMs: number, observedMonoMs: number): PostObservation {
  const unavailable: PostObservation = { observedAt: new Date(observedMs).toISOString(), observedMonoMs,
    publicationDelayMs: null, uncertaintyMs: null, clockOffsetMs: null, clockSource: 'unavailable' };
  const timing = response.timing;
  if (serverMs === null || !timing || !Number.isFinite(timing.requestStartedAt)
    || !Number.isFinite(timing.headersReceivedAt) || timing.headersReceivedAt < timing.requestStartedAt
    || timing.headersReceivedAt > observedMs) return unavailable;
  // HTTP Date has one-second resolution. Its midpoint is compared with the request's
  // local midpoint; a fixed PC clock skew then cancels instead of appearing as latency.
  const roundTripMs = timing.headersReceivedAt - timing.requestStartedAt;
  const clockOffsetMs = serverMs + 500 - (timing.requestStartedAt + roundTripMs / 2);
  const delay = observedMs + clockOffsetMs - post.creation_time * 1000;
  const publicationIsValid = Number.isSafeInteger(post.creation_time)
    && post.creation_time >= Date.UTC(2004, 1, 4) / 1000 && Number.isFinite(delay) && delay >= 0;
  return { ...unavailable, publicationDelayMs: publicationIsValid ? delay : null,
    uncertaintyMs: 500 + roundTripMs / 2, clockOffsetMs, clockSource: 'facebook-response' };
}
function sourceBound(vars: Record<string, unknown>, sourceId: ReadSourceId = SOURCE_ID) {
  const ids = ['userID', 'id', 'profileID'].map(key => vars[key]).filter(value =>
    typeof value === 'string' && /^\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0).map(String);
  return ids.includes(sourceId) && ids.every(id => id === sourceId);
}
function verifyHead(form: URLSearchParams, observed: ObservedContinuation | null, sourceId: ReadSourceId = SOURCE_ID, windowSize: 3 | 5 = 5): Record<string, unknown> {
  const fail = (): never => { throw Error('HEAD_QUERY_UNVERIFIED'); };
  if (!observed?.responseVerified || !observed.authenticated || !observed.artifact?.operationMatched
    || !observed.artifact.headCursorNullAllowed || observed.artifact.cursorArgumentName !== 'cursor'
    || observed.artifact.countFeedsFirst !== true || observed.artifact.cursorFeedsAfter !== true) fail();
  try {
    const url = new URL(observed!.endpoint), vars: unknown = JSON.parse(form.get('variables') || '');
    const original = observed!.variables;
    if (url.origin !== FB_ORIGIN || url.pathname !== '/api/graphql/' || url.search || url.hash || url.username || url.password
      || observed!.friendlyName.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*Query$/.test(observed!.friendlyName)
      || !/Timeline[A-Za-z0-9_]*Query$/.test(observed!.friendlyName)
      || !object(original) || !sourceBound(original, sourceId) || typeof original.cursor !== 'string' || !original.cursor
      || typeof original.count !== 'number' || !Number.isSafeInteger(original.count) || original.count < 1
      || Object.hasOwn(original, 'stream_count') && (typeof original.stream_count !== 'number'
        || !Number.isSafeInteger(original.stream_count) || original.stream_count < 1)
      || ['doc_id', 'fb_api_req_friendly_name', 'variables', '__user'].some(key => form.getAll(key).length !== 1)
      || !/^\d+$/.test(form.get('doc_id') || '') || form.get('doc_id') !== observed!.form.get('doc_id')
      || form.get('fb_api_req_friendly_name') !== observed!.friendlyName
      || !/^[1-9]\d*$/.test(form.get('__user') || '') || form.get('__user') !== observed!.form.get('__user') || !form.get('fb_dtsg')
      || !object(vars) || !sourceBound(vars, sourceId) || vars.count !== windowSize || vars.cursor !== null) fail();
    const expected = { ...observed!.variables, count: windowSize,
      ...(Object.hasOwn(observed!.variables, 'stream_count') ? { stream_count: windowSize } : {}), cursor: null };
    if (JSON.stringify(vars) !== JSON.stringify(expected)) fail();
    return vars as Record<string, unknown>;
  } catch { return fail(); }
}

// Internal cursor-bearing return. Callers must never log or persist it.
export function scopedPageInfo(records: any[], sourceId: ReadSourceId = SOURCE_ID) {
  const normalized = normalizeRefetchRoot(records, sourceId);
  const cursors = new Set<string>(), flags = new Set<boolean>(); let parentVerified = false;
  function page(value: unknown) {
    if (!object(value)) return;
    for (const name of ['has_next_page', 'hasNextPage']) if (typeof value[name] === 'boolean') flags.add(value[name]);
    for (const name of ['end_cursor', 'endCursor']) if (typeof value[name] === 'string' && value[name]) cursors.add(value[name]);
  }
  function connection(value: unknown) {
    if (object(value)) { page(value.page_info); page(value.pageInfo); }
  }
  function patch(value: any) {
    const path = value?.path;
    if (!Array.isArray(path) || path[0] !== 'user' || path[1] !== 'timeline_list_feed_units') return;
    if (path.length === 2) connection(value.data);
    else if (path.length === 3 && ['page_info', 'pageInfo'].includes(path[2])) page(value.data);
  }
  for (const frame of normalized.records) {
    if (!Array.isArray(frame?.path) || !frame.path.length) {
      if (frame?.data?.user?.id === sourceId) parentVerified = true;
      connection(frame?.data?.user?.timeline_list_feed_units);
    } else patch(frame);
    for (const part of frame?.incremental || []) patch(part);
  }
  const usable = normalized.usable && parentVerified && flags.size <= 1 && cursors.size <= 1;
  return { usable, hasNextPage: usable && flags.size === 1 ? [...flags][0] : null,
    endCursor: usable && cursors.size === 1 ? [...cursors][0] : null };
}
export function makeContinuationReadForm(headForm: URLSearchParams, observed: ObservedContinuation,
  actualEndCursor: string, remaining: number, sourceId: ReadSourceId = SOURCE_ID, windowSize: 3 | 5 = 5): URLSearchParams {
  const vars = verifyHead(headForm, observed, sourceId, windowSize);
  if (typeof actualEndCursor !== 'string' || !actualEndCursor || !Number.isSafeInteger(remaining) || remaining < 1 || remaining > 4)
    throw Error('BASELINE_INCOMPLETE');
  const form = new URLSearchParams(headForm);
  form.set('variables', JSON.stringify({ ...vars, count: remaining,
    ...(Object.hasOwn(vars, 'stream_count') ? { stream_count: remaining } : {}), cursor: actualEndCursor }));
  return form;
}

export async function readCompleteWindow(page: Page, headForm: URLSearchParams,
  options: CompleteWindowOptions = {}): Promise<CompleteWindowResult> {
  const maxBatches = options.maxBatches ?? 2;
  const requestedSize = options.windowSize ?? 5;
  if (![3, 5].includes(requestedSize)) throw Error('QUERY_BUDGET');
  let windowSize: 3 | 5 = requestedSize;
  let expansionReason: CompleteWindowResult['expansionReason'] = null;
  const target = options.target ?? 'test-profile', sourceId = READ_TARGETS[target].sourceId;
  if (![1, 2].includes(maxBatches)) throw Error('QUERY_BUDGET');
  if (!matchesReadTargetUrl(page.url(), target)) throw Error('SOURCE_PAGE_UNAVAILABLE');
  const observed = options.observedTemplate ?? (target === 'test-profile' ? getObservedContinuation() : null);
  verifyHead(headForm, observed, sourceId, requestedSize);
  const posts: AuthPost[] = [], batches: SafeWindowBatch[] = [], ids = new Set<string>(), markers = new Set<string>();
  const observations: Record<string, PostObservation> = {};
  let form = new URLSearchParams(headForm), serverSeconds: number | null = null, queryPOSTsIssued = 0;
  let verifiedAt = new Date(Date.now()).toISOString();
  const finish = (reasonCode: string | null): CompleteWindowResult => ({ posts, usable: reasonCode === null, reasonCode,
    markerMatchIds: reasonCode === null ? [...markers].filter(id => ids.has(id)) : [], safeInspection: null,
    serverSeconds, firstSeenAt: verifiedAt, observations, batches, queryPOSTsIssued, windowSize, expansionReason,
    receivedOrderChronologicalDescending: posts.length > 1 ? posts.every((p, i) => !i || posts[i - 1].creation_time >= p.creation_time) : null,
    actualNewestFiveGuaranteed: false });
  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
    if (options.signal?.aborted) return finish('READ_ABORTED');
    if (!matchesReadTargetUrl(page.url(), target)) return finish('SOURCE_PAGE_UNAVAILABLE');
    const started = performance.now(), variables = JSON.parse(form.get('variables') || '{}');
    // A transport failure can occur after an unknown number of HTTP requests. Do not fabricate a zero count.
    const response = await readThroughBrowser(page, form, { target, observedTemplate: observed! });
    queryPOSTsIssued++;
    const batch: SafeWindowBatch = { batchIndex, requestedCount: variables.count,
      requestedStreamCount: Number.isSafeInteger(variables.stream_count) ? variables.stream_count : null,
      returnedPostCount: 0, selectedPostCount: 0, queryMs: 0, httpStatus: response.status(), decodedBodyBytes: 0,
      responseComplete: false, usable: false, reasonCode: null, posts: [], markerMatchIds: [],
      hasNextPage: null, endCursorPresent: false, serverSeconds: null, inspection: null };
    batches.push(batch);
    try {
      if (response.status() === 429) { batch.reasonCode = 'RATE_LIMIT'; return finish(batch.reasonCode); }
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) {
        batch.reasonCode = 'LOGIN_OR_CHECKPOINT'; return finish(batch.reasonCode);
      }
      if (!response.ok()) { batch.reasonCode = 'READ_FAILED'; return finish(batch.reasonCode); }
      const raw = await response.body(); batch.decodedBodyBytes = raw.byteLength; batch.responseComplete = true;
      if (raw.byteLength > MAX_BYTES) { batch.reasonCode = 'RESPONSE_LIMIT'; return finish(batch.reasonCode); }
      let records: any[];
      try { records = parseRecords(raw.toString('utf8')); }
      catch { batch.reasonCode = 'RESPONSE_NOT_JSON'; return finish(batch.reasonCode); }
      const result = inspectAuthWindow(records, options.marker, sourceId);
      const observedMs = Date.now(), observedMonoMs = performance.now();
      const ms = responseServerMs(response);
      if (ms !== null) { serverSeconds = Math.floor(ms / 1000); batch.serverSeconds = serverSeconds; }
      Object.assign(batch, { usable: result.usable, reasonCode: result.reasonCode, returnedPostCount: result.posts.length,
        posts: result.posts, markerMatchIds: result.markerMatchIds, inspection: result.safeInspection });
      if (!result.usable) return finish(result.reasonCode || 'UNVERIFIED_WINDOW');
      const info = scopedPageInfo(records, sourceId);
      batch.hasNextPage = info.hasNextPage; batch.endCursorPresent = info.endCursor !== null;
      // Validate the complete returned page before selecting only the remaining current-window slots.
      if (result.posts.some(p => posts.some(prior => prior.post_id === p.post_id && prior.creation_time !== p.creation_time)))
        return finish('WINDOW_CHAIN_CONFLICT');
      if (result.posts.some(p => ids.has(p.post_id))) return finish('WINDOW_CHAIN_OVERLAP');
      if (options.expandOnRisk && windowSize === 3) {
        const combined = [...posts, ...result.posts];
        const ordered = combined.every((post, i) => !i || combined[i - 1].creation_time >= post.creation_time);
        // Key evidence is a reason to inspect more, never proof that an item is
        // pinned/new. False/null flags do not force an extra request every poll.
        const promotion = result.safeInspection?.window.posts.some((post: any) => {
          const evidence = post.pinAndFeatured;
          return evidence?.keyEvidenceTruncated || evidence?.keyEvidence.some((key: any) =>
            key.valueKind !== 'null' && !(key.valueKind === 'boolean' && key.booleanValue === false));
        });
        if (!ordered || promotion) {
          windowSize = 5; expansionReason = !ordered ? 'non_chronological' : 'promotion_evidence';
        }
      }
      const needed = windowSize - posts.length;
      for (const post of result.posts.slice(0, needed)) {
        if (!posts.length) verifiedAt = new Date(observedMs).toISOString();
        posts.push(post); ids.add(post.post_id); batch.selectedPostCount++;
        observations[post.post_id] ??= observePost(post, response, ms, observedMs, observedMonoMs);
      }
      for (const id of result.markerMatchIds) if (ids.has(id)) markers.add(id);
      if (posts.length === windowSize) return finish(null);
      if (batchIndex + 1 >= maxBatches || !info.usable || info.hasNextPage !== true || !info.endCursor)
        return finish('BASELINE_INCOMPLETE');
      form = makeContinuationReadForm(headForm, observed!, info.endCursor, windowSize - posts.length, sourceId, requestedSize);
    } finally { batch.queryMs = Math.round(performance.now() - started); await response.dispose(); }
  }
  return finish('BASELINE_INCOMPLETE');
}
