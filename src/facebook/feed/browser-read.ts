import { Buffer } from 'node:buffer';
import type { Page } from 'playwright-core';
import { QUERY_NAME } from './capture.ts';
import { READ_TARGETS, matchesReadTargetUrl, type ReadTarget } from './read-target.ts';
import { getObservedContinuation, type ObservedContinuation } from './observed-query-store.ts';

const MAX_BYTES = 8 * 1024 * 1024;
type BrowserReadCode = 'SOURCE_PAGE_UNAVAILABLE' | 'INITIAL_QUERY_UNAVAILABLE'
  | 'READ_TIMEOUT' | 'RESPONSE_LIMIT' | 'READ_FAILED';
type BrowserResult = { kind: 'response'; status: number; date?: string; bodyBase64: string;
  timing?: { requestStartedAt: number; headersReceivedAt: number } }
  | { kind: 'error'; code: BrowserReadCode };

export type BrowserReadResponse = {
  status(): number;
  ok(): boolean;
  headers(): { date?: string };
  // Same-host wall times around fetch headers, before body download/decoding.
  timing?: { requestStartedAt: number; headersReceivedAt: number };
  body(): Promise<Buffer>;
  dispose(): Promise<void>;
};

// The authenticated request and decoded response stay in RAM in this program.
// No cookies, request forms, raw responses or browser state are written or logged.
export async function readThroughBrowser(page: Page, form: URLSearchParams,
  options: { target?: ReadTarget; observedTemplate?: ObservedContinuation } = {}): Promise<BrowserReadResponse> {
  const target = options.target ?? 'test-profile';
  if (!matchesReadTargetUrl(page.url(), target)) throw Error('SOURCE_PAGE_UNAVAILABLE');
  const captured = options.observedTemplate ?? (target === 'test-profile' ? getObservedContinuation() : null);
  if (target === 'page' && (!captured?.authenticated || captured.responseVerified !== true
    || captured.artifact?.operationMatched !== true)) throw Error('INITIAL_QUERY_UNAVAILABLE');
  if (target === 'page' && (form.get('fb_api_req_friendly_name') !== captured!.friendlyName
    || form.get('doc_id') !== captured!.form.get('doc_id')
    || form.get('__user') !== captured!.form.get('__user'))) throw Error('INITIAL_QUERY_UNAVAILABLE');
  const verifiedAlternate = captured?.responseVerified === true && captured.authenticated
    ? { friendlyName: captured.friendlyName, docId: captured.form.get('doc_id') } : null;
  let result: BrowserResult;
  try {
    result = await page.evaluate(async ({ formText, sourceId, sourceUrl, target, queryName, verifiedAlternate, limit }): Promise<BrowserResult> => {
      const source = new URL(location.href), expected = new URL(sourceUrl);
      const profile = expected.pathname === '/profile.php';
      if (source.origin !== expected.origin || source.username || source.password || source.href.includes('#')
        || (profile ? source.pathname !== expected.pathname : source.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, ''))
        || [...source.searchParams.keys()].some(key => !['locale', ...(profile ? ['id'] : [])].includes(key))
        || profile && (source.searchParams.getAll('id').length !== 1 || source.searchParams.get('id') !== sourceId)
        || source.searchParams.getAll('locale').length > 1)
        return { kind: 'error', code: 'SOURCE_PAGE_UNAVAILABLE' };
      const locales = source.searchParams.getAll('locale');
      if (locales.length && !/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8}){0,3}$/.test(locales[0]))
        return { kind: 'error', code: 'SOURCE_PAGE_UNAVAILABLE' };

      // Refuse an accidentally supplied mutation or a form for a different source.
      const body = new URLSearchParams(formText);
      try {
        if (['fb_api_req_friendly_name', 'doc_id', 'variables', '__user'].some(key => body.getAll(key).length > 1)
          || !/^\d+$/.test(body.get('doc_id') || ''))
          return { kind: 'error', code: 'INITIAL_QUERY_UNAVAILABLE' };
        const variables = JSON.parse(body.get('variables') || '');
        if (!variables || typeof variables !== 'object' || Array.isArray(variables))
          return { kind: 'error', code: 'INITIAL_QUERY_UNAVAILABLE' };
        if (body.get('fb_api_req_friendly_name') === queryName) {
          if (variables.userID !== sourceId) return { kind: 'error', code: 'INITIAL_QUERY_UNAVAILABLE' };
        } else {
          if (!verifiedAlternate || body.get('fb_api_req_friendly_name') !== verifiedAlternate.friendlyName
            || body.get('doc_id') !== verifiedAlternate.docId) return { kind: 'error', code: 'INITIAL_QUERY_UNAVAILABLE' };
          const bindings = ['userID', 'id', 'profileID'].map(key => variables[key]).filter(value =>
            typeof value === 'string' && /^\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0).map(String);
          if (!bindings.includes(sourceId) || bindings.some(value => value !== sourceId))
            return { kind: 'error', code: 'INITIAL_QUERY_UNAVAILABLE' };
        }
      } catch { return { kind: 'error', code: 'INITIAL_QUERY_UNAVAILABLE' }; }

      const timeout = AbortSignal.timeout(20_000);
      const abort = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let tooLarge = false;
      try {
        const requestStartedAt = Date.now();
        const response = await fetch('https://www.facebook.com/api/graphql/', {
          method: 'POST', body, credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          cache: 'no-store', signal: AbortSignal.any([timeout, abort.signal]),
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-FB-Friendly-Name': body.get('fb_api_req_friendly_name')! },
        });
        const headersReceivedAt = Date.now();
        const chunks: Uint8Array[] = [];
        let byteCount = 0;
        if (response.body) {
          reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            byteCount += value.byteLength;
            if (byteCount > limit) {
              tooLarge = true;
              abort.abort();
              await reader.cancel().catch(() => {});
              return { kind: 'error', code: 'RESPONSE_LIMIT' };
            }
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(byteCount);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        // Base64 bounds the cross-process payload; no raw response enters a log or file.
        const parts: string[] = [];
        for (let i = 0; i < bytes.byteLength; i += 32_768)
          parts.push(String.fromCharCode(...bytes.subarray(i, i + 32_768)));
        const date = response.headers.get('date');
        return { kind: 'response', status: response.status,
          date: date && date.length <= 128 ? date : undefined,
          timing: { requestStartedAt, headersReceivedAt },
          bodyBase64: btoa(parts.join('')) };
      } catch {
        return { kind: 'error', code: tooLarge ? 'RESPONSE_LIMIT' : timeout.aborted ? 'READ_TIMEOUT' : 'READ_FAILED' };
      } finally { reader?.releaseLock(); }
    }, { formText: form.toString(), sourceId: READ_TARGETS[target].sourceId, sourceUrl: READ_TARGETS[target].url, target, queryName: QUERY_NAME, verifiedAlternate, limit: MAX_BYTES });
  } catch { throw Error('READ_FAILED'); }

  if (result.kind === 'error') throw Error(result.code);
  if (!matchesReadTargetUrl(page.url(), target)) throw Error('SOURCE_PAGE_UNAVAILABLE');
  let data: Buffer | null = Buffer.from(result.bodyBase64, 'base64');
  if (data.byteLength > MAX_BYTES) { data.fill(0); throw Error('RESPONSE_LIMIT'); }
  const status = result.status, date = result.date;
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => date ? { date } : {},
    timing: result.timing,
    async body() { if (!data) throw Error('READ_FAILED'); return data; },
    async dispose() { data?.fill(0); data = null; },
  };
}
