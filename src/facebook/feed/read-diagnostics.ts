// Only bounded numbers/enums survive this boundary. Never persist arbitrary headers or resource URLs.
export type ResourceEvidence = {
  match: 'matched' | 'unavailable' | 'ambiguous';
  transferBytes: number | null; encodedBodyBytes: number | null; decodedBodyBytes: number | null;
  workerStartMs: number | null; deliveryType: 'cache' | 'other' | null;
  requestToFirstByteMs: number | null; downloadMs: number | null; durationMs: number | null;
};
export type ReadTransportEvidence = {
  requestCacheMode: 'no-store' | null;
  dateSeconds: number | null; ageSeconds: number | null; expiresSeconds: number | null;
  cacheControl: string[];
  cacheStatuses: { header: string; statuses: string[] }[];
  headersMs: number | null; bodyMs: number | null; diagnosticsMs: number | null;
  resource: ResourceEvidence;
  browserDelivery: 'local_cache_signal' | 'service_worker_observed' | 'network_transfer_observed' | 'unknown';
  sharedCache: 'hit_or_stale_reported' | 'age_reported' | 'miss_or_bypass_reported' | 'unknown';
};
const object = (v: any): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const nonnegative = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null;
const seconds = (v: any) => Number.isSafeInteger(v) && v >= 0 ? v as number : null;
const fingerprint = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : null;
export { fingerprint as safeFingerprint };
const statusNames = ['HIT', 'MISS', 'STALE', 'BYPASS', 'DYNAMIC', 'EXPIRED', 'REVALIDATED', 'UPDATING'];
const headerNames = ['x-cache', 'x-cache-status', 'cf-cache-status', 'x-proxy-cache'];
export function safeTransportEvidence(value: unknown): ReadTransportEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const v = object(value), r = object(v.resource);
  const match = r.match === 'matched' || r.match === 'ambiguous' ? r.match : 'unavailable';
  const resource: ResourceEvidence = {
    match, transferBytes: match === 'matched' ? nonnegative(r.transferBytes) : null,
    encodedBodyBytes: match === 'matched' ? nonnegative(r.encodedBodyBytes) : null,
    decodedBodyBytes: match === 'matched' ? nonnegative(r.decodedBodyBytes) : null,
    workerStartMs: match === 'matched' ? nonnegative(r.workerStartMs) : null,
    deliveryType: match === 'matched' && ['cache', 'other'].includes(r.deliveryType) ? r.deliveryType : null,
    requestToFirstByteMs: match === 'matched' ? nonnegative(r.requestToFirstByteMs) : null,
    downloadMs: match === 'matched' ? nonnegative(r.downloadMs) : null,
    durationMs: match === 'matched' ? nonnegative(r.durationMs) : null,
  };
  const cacheStatuses = (Array.isArray(v.cacheStatuses) ? v.cacheStatuses : []).slice(0, 4).flatMap((item: any) => {
    const h = object(item);
    return headerNames.includes(h.header) ? [{ header: h.header as string,
      statuses: [...new Set<string>((Array.isArray(h.statuses) ? h.statuses : []).filter((s: any) => statusNames.includes(s)))].slice(0, 8) }] : [];
  });
  const ageSeconds = seconds(v.ageSeconds), statuses = cacheStatuses.flatMap(h => h.statuses);
  return {
    requestCacheMode: v.requestCacheMode === 'no-store' ? 'no-store' : null,
    dateSeconds: seconds(v.dateSeconds), ageSeconds, expiresSeconds: seconds(v.expiresSeconds),
    cacheControl: [...new Set<string>((Array.isArray(v.cacheControl) ? v.cacheControl : []).filter((s: any) =>
      typeof s === 'string' && /^(?:no-store|no-cache|private|public|must-revalidate|proxy-revalidate|immutable|(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)=\d{1,10})$/.test(s)))].slice(0, 12),
    cacheStatuses, headersMs: nonnegative(v.headersMs), bodyMs: nonnegative(v.bodyMs), diagnosticsMs: nonnegative(v.diagnosticsMs), resource,
    // A service worker can fetch from network or its own cache; interception alone is not a cache hit.
    browserDelivery: resource.workerStartMs !== null && resource.workerStartMs > 0 ? 'service_worker_observed'
      : resource.workerStartMs !== 0 ? 'unknown'
      : resource.deliveryType === 'cache' || resource.transferBytes === 0 && (resource.encodedBodyBytes ?? 0) > 0 ? 'local_cache_signal'
      : (resource.transferBytes ?? 0) > 0 ? 'network_transfer_observed' : 'unknown',
    // A MISS/zero Age/fresh Date does not rule out Facebook's internal application caches.
    sharedCache: statuses.some(s => ['HIT', 'STALE', 'UPDATING'].includes(s)) ? 'hit_or_stale_reported'
      : ageSeconds !== null && ageSeconds > 0 ? 'age_reported'
      : statuses.some(s => ['MISS', 'BYPASS', 'DYNAMIC'].includes(s)) ? 'miss_or_bypass_reported' : 'unknown',
  };
}

export function transportFromHeaders(headers: Record<string, unknown>, input: {
  requestCacheMode?: string; headersMs?: number; bodyMs?: number; diagnosticsMs?: number; resource?: unknown;
}): ReadTransportEvidence {
  const text = (key: string) => typeof headers[key] === 'string' ? (headers[key] as string).slice(0, 1024) : '';
  const date = (key: string) => {
    const raw = text(key), ms = Date.parse(raw);
    return Number.isFinite(ms) && new Date(ms).toUTCString() === raw ? ms / 1000 : null;
  };
  const age = text('age').trim();
  const cacheControl = text('cache-control').toLowerCase().split(',').map(s => s.trim().replace(/\s*=\s*"?(\d+)"?$/, '=$1'));
  const cacheStatuses = headerNames.filter(key => text(key)).map(header => ({ header,
    // Extract just status words, never proxy host names or arbitrary header values.
    statuses: text(header).toUpperCase().split(',').flatMap(part => {
      const status = part.trim().match(/^(?:TCP_)?(HIT|MISS|STALE|BYPASS|DYNAMIC|EXPIRED|REVALIDATED|UPDATING)(?=\s|$)/)?.[1];
      return status ? [status] : [];
    }) }));
  return safeTransportEvidence({ ...input, dateSeconds: date('date'), expiresSeconds: date('expires'),
    ageSeconds: /^\d{1,10}$/.test(age) ? Number(age) : null, cacheControl, cacheStatuses })!;
}
