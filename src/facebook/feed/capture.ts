// Internal RAM-only preparation. Never log these request forms or descriptors.
import { inspectWindows } from './window-parser.mjs';
import { inspectRecords } from './query-parser.mjs';
import { READ_TARGETS, type ReadSourceId } from './read-target.ts';
const streamModuleUrl = new URL('./stream-frames.ts', import.meta.url);
const rootModuleUrl = new URL('./refetch-root.ts', import.meta.url);
streamModuleUrl.search = rootModuleUrl.search = new URL(import.meta.url).search;
const { normalizeStreamFrames }: typeof import('./stream-frames.ts') = await import(streamModuleUrl.href);
const { normalizeRefetchRoot }: typeof import('./refetch-root.ts') = await import(rootModuleUrl.href);

export const SOURCE_ID = READ_TARGETS['test-profile'].sourceId;
export const FB_ORIGIN = 'https://www.facebook.com';
export const SOURCE_URL = READ_TARGETS['test-profile'].url;
export const QUERY_NAME = 'ProfileCometTimelineFeedQuery';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
type Variables = Record<string, unknown>;
export type Preparation = { descriptor: { queryID: string; variables: Variables } | null; authenticated: boolean };
export type ObservedQuery = { form: URLSearchParams; variables: Variables; authenticated: boolean };
const record = (v: unknown): v is Variables => !!v && typeof v === 'object' && !Array.isArray(v);
const positiveId = (v: unknown) => typeof v === 'string' && /^[1-9]\d*$/.test(v);
const queryId = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
function endpoint(value: string): boolean {
  try { const u = new URL(value, FB_ORIGIN); return u.origin === FB_ORIGIN && u.pathname === '/api/graphql/'
    && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
function walk(values: unknown[], visit: (v: Variables | unknown[]) => void): void {
  const stack = values.map(value => ({ value, depth: 0 })), seen = new WeakSet<object>();
  let nodes = 0, bytes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > 100) throw Error('CAPTURE_LIMIT');
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > MAX_BYTES) throw Error('CAPTURE_LIMIT'); }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) throw Error('CAPTURE_NON_JSON');
    seen.add(value); visit(value as Variables | unknown[]);
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
}
function continuationPresent(variables: Variables): boolean {
  let present = false;
  walk([variables], value => {
    for (const [key, child] of Object.entries(value))
      // Runtime execution flags (e.g. runWithContinuationKey) are not page tokens.
      if (/^(?:cursor|after|before|(?:start|end)[_]?cursor|continuation(?:[_]?(?:token|cursor|key))?)$/i.test(key))
        if (child !== null && child !== undefined) present = true;
  });
  return present;
}
export function readAdvertisedPreparation(html: string): Preparation {
  if (Buffer.byteLength(html) > MAX_BYTES) throw Error('CAPTURE_LIMIT');
  const texts: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = match[1];
    const jsonType = /\btype\s*=\s*(?:"application\/(?:ld\+)?json"|'application\/(?:ld\+)?json'|application\/(?:ld\+)?json(?:\s|$))/i.test(attrs);
    const sjs = /(?:^|\s)data-sjs(?:\s|=|$)/i.test(attrs);
    if (!jsonType && !sjs) continue;
    texts.push(match[2]);
  }
  return readAdvertisedDocuments(texts);
}
// Caller supplies textContent from observed JSON script elements only. No JS or HTML is evaluated.
export function readAdvertisedDocuments(texts: string[]): Preparation {
  if (!Array.isArray(texts) || texts.length > MAX_NODES) throw Error('CAPTURE_LIMIT');
  let bytes = 0;
  for (const text of texts) {
    if (typeof text !== 'string') throw Error('CAPTURE_NON_JSON');
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw Error('CAPTURE_LIMIT');
  }
  const documents: unknown[] = [];
  for (const text of texts) {
    try { documents.push(JSON.parse(text)); } catch { /* Only complete JSON documents are eligible. */ }
  }
  const descriptors = new Map<string, NonNullable<Preparation['descriptor']>>(); let authenticated = false;
  walk(documents, value => {
    if (!record(value)) return;
    if (typeof value.graphURI === 'string' && endpoint(value.graphURI)
      && (positiveId(value.actorID) || Number.isSafeInteger(value.actorID) && Number(value.actorID) > 0)) authenticated = true;
    if (value.queryName === QUERY_NAME && queryId(String(value.queryID ?? '')) && record(value.variables)
      && value.variables.userID === SOURCE_ID) {
      const descriptor = { queryID: String(value.queryID), variables: value.variables };
      descriptors.set(JSON.stringify(descriptor), descriptor);
    }
  });
  return { descriptor: descriptors.size === 1 ? [...descriptors.values()][0] : null, authenticated };
}
export function readObservedQuery(url: string, method: string, postData: string | null): ObservedQuery | null {
  if (method !== 'POST' || !endpoint(url) || !postData || Buffer.byteLength(postData) > MAX_BYTES) return null;
  const form = new URLSearchParams(postData);
  if (['fb_api_req_friendly_name', 'doc_id', 'variables', '__user'].some(key => form.getAll(key).length > 1)) return null;
  if (form.get('fb_api_req_friendly_name') !== QUERY_NAME || !queryId(form.get('doc_id'))) return null;
  try {
    const variables: unknown = JSON.parse(form.get('variables') || '');
    if (!record(variables) || variables.userID !== SOURCE_ID) return null;
    walk([variables], () => {});
    return { form, variables, authenticated: positiveId(form.get('__user')) };
  } catch { return null; }
}
export function makeReadForm(observed: ObservedQuery, prep: Preparation): URLSearchParams {
  if (!observed.authenticated && !prep.authenticated) throw Error('LOGIN_REQUIRED');
  const chosen = prep.descriptor;
  const variables = chosen?.variables ?? observed.variables;
  const docId = chosen?.queryID ?? observed.form.get('doc_id');
  if (!queryId(docId) || !record(variables) || variables.userID !== SOURCE_ID || continuationPresent(variables))
    throw Error('INITIAL_QUERY_UNAVAILABLE');
  const positiveCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const streamCountDeclared = Object.hasOwn(variables, 'stream_count');
  if (!positiveCount(variables.count) || streamCountDeclared && !positiveCount(variables.stream_count)) {
    const safeInteger = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
    const error = new Error('COUNT_FIELDS_UNAVAILABLE') as Error & { safeCountShape: {
      countPresent: boolean; countType: string; countValue: number | null;
      streamCountPresent: boolean; streamCountType: string; streamCountValue: number | null;
    } };
    error.safeCountShape = {
      countPresent: Object.hasOwn(variables, 'count'), countType: typeof variables.count, countValue: safeInteger(variables.count),
      streamCountPresent: Object.hasOwn(variables, 'stream_count'), streamCountType: typeof variables.stream_count,
      streamCountValue: safeInteger(variables.stream_count),
    };
    throw error;
  }
  const form = new URLSearchParams(observed.form);
  form.set('doc_id', docId!);
  form.set('fb_api_req_friendly_name', QUERY_NAME);
  form.set('variables', JSON.stringify({ ...variables, count: 5, ...(streamCountDeclared ? { stream_count: 5 } : {}) }));
  return form;
}

function markerIds(records: any[], posts: any[], marker?: string): string[] {
  if (typeof marker !== 'string' || !marker.trim()) return [];
  const expected = marker.trim(), matched = new Set<string>();
  const paths = [[], ['comet_sections', 'content', 'story'], ['comet_sections', 'context_layout', 'story'],
    ['comet_sections', 'feedback', 'story'], ['context_layout', 'story']];
  function connection(value: any, frameIndex: number, kind: string) {
    if (!Array.isArray(value?.edges)) return;
    value.edges.forEach((edge: any, edgeIndex: number) => {
      const node = edge?.node; if (node?.__typename !== 'Story') return;
      const accepted = posts.filter(p => p.frameIndex === frameIndex && p.edgeIndex === edgeIndex && p.frameKind === kind);
      if (!accepted.length) return;
      for (const path of paths) {
        const view = path.reduce((v: any, key: string) => v?.[key], node);
        const sameStory = typeof node.id === 'string' && node.id === view?.id;
        const samePost = typeof node.post_id === 'string' && /^\d+$/.test(node.post_id) && node.post_id === view?.post_id;
        const conflictingStory = typeof node.id === 'string' && typeof view?.id === 'string' && node.id !== view.id;
        const conflictingPost = typeof node.post_id === 'string' && typeof view?.post_id === 'string' && node.post_id !== view.post_id;
        // Relay can omit __typename on a main-story fragment whose identity is already explicit.
        const anchored = view && (view === node || (view.__typename === undefined || view.__typename === 'Story')
          && (sameStory || samePost) && !conflictingStory && !conflictingPost);
        if (!anchored || typeof view.message?.text !== 'string' || view.message.text.trim() !== expected) continue;
        if (accepted.length === 1) matched.add(accepted[0].post_id);
      }
    });
  }
  records.forEach((frame, frameIndex) => {
    const path = Array.isArray(frame?.path) ? frame.path : [];
    if (!path.length) connection(frame?.data?.user?.timeline_list_feed_units, frameIndex, frame?.label ? 'patch' : 'initial');
    else if (path.length === 2 && path[0] === 'user' && path[1] === 'timeline_list_feed_units') connection(frame.data, frameIndex, 'patch');
    for (const patch of frame?.incremental || []) if (Array.isArray(patch?.path) && patch.path.length === 2
      && patch.path[0] === 'user' && patch.path[1] === 'timeline_list_feed_units') connection(patch.data, frameIndex, 'incremental_patch');
  });
  return [...matched];
}
export type AuthPost = { post_id: string; creation_time: number; sourceVerification: string; permalink: string | null };
export type AuthWindowResult = { posts: AuthPost[];
  safeInspection: { response: ReturnType<typeof inspectRecords>; window: ReturnType<typeof inspectWindows>;
    assembly: ReturnType<typeof normalizeStreamFrames>['diagnostics'];
    rootNormalization: ReturnType<typeof normalizeRefetchRoot>['diagnostics'] } | null;
  usable: boolean; reasonCode: string | null; markerMatchIds: string[] };
export function inspectAuthWindow(records: any[], marker?: string, sourceId: ReadSourceId = SOURCE_ID): AuthWindowResult {
  try {
    if (!Array.isArray(records)) throw Error('CAPTURE_NON_JSON');
    walk(records, () => {});
    const rootNormalization = normalizeRefetchRoot(records, sourceId);
    const assembly = normalizeStreamFrames(rootNormalization.records);
    const response = inspectRecords(records), window = inspectWindows(assembly.records, { sourceId });
    // All rejection checks still inspect the original normalized frames. This scoped
    // view contains only their registered edges, ordered by explicit Relay index;
    // it supplies selection order and unambiguous marker provenance across patches.
    const indexedRecords = [{ data: { user: { timeline_list_feed_units: { edges: assembly.orderedEdges } } } }];
    const indexedWindow = inspectWindows(indexedRecords, { sourceId });
    const indexedOrder = new Map(indexedWindow.posts.map((post: any, index: number) => [post.post_id, index]));
    window.posts.sort((a: any, b: any) => Number(indexedOrder.get(a.post_id) ?? Infinity)
      - Number(indexedOrder.get(b.post_id) ?? Infinity));
    window.receivedOrderChronologicalDescending = window.posts.length > 1
      ? window.posts.every((post: any, index: number) => !index || window.posts[index - 1].creation_time >= post.creation_time) : null;
    const safeInspection = { response, window, assembly: assembly.diagnostics, rootNormalization: rootNormalization.diagnostics };
    const posts = window.posts.map((p: any) => ({ post_id: p.post_id, creation_time: p.creation_time,
      sourceVerification: p.sourceVerification, permalink: p.permalink }));
    const last = records.at(-1);
    let reasonCode: string | null = null;
    if (last?.extensions?.is_final !== true || last?.hasNext === true) reasonCode = 'FINAL_FRAME_REQUIRED';
    else if (records.some(r => r?.error !== null && r?.error !== undefined)) reasonCode = 'GRAPHQL_ERROR';
    else if (response.errors.some((e: any) => e.classification !== 'timeline_post_subfield_error'
      || ['CRITICAL', 'FATAL'].includes(e.severity))) reasonCode = 'CRITICAL_RESPONSE_ERROR';
    else if (posts.length > 5) reasonCode = 'WINDOW_COUNT_EXCEEDED';
    else if (!rootNormalization.usable || !assembly.usable || window.parentSourceConflict || window.poisonedPostIds.length || window.rejectedEdges.length
      || window.unsupportedMainTimelinePatchPaths.length) reasonCode = 'UNVERIFIED_WINDOW';
    else if (!posts.length) reasonCode = 'EMPTY_WINDOW';
    return { posts, safeInspection, usable: reasonCode === null, reasonCode,
      markerMatchIds: reasonCode === null ? markerIds(indexedRecords, indexedWindow.posts, marker) : [] };
  } catch {
    return { posts: [], safeInspection: null, usable: false, reasonCode: 'INSPECTION_FAILED', markerMatchIds: [] };
  }
}
