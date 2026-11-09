// Canonical process-local store. Never persist, log, serialize for diagnostics, or attach this state to UI.
import { FB_ORIGIN, SOURCE_ID } from './capture.ts';

export type ObservedContinuation = {
  endpoint: string;
  friendlyName: string;
  form: URLSearchParams;
  variables: Record<string, unknown>;
  authenticated: boolean;
  responseVerified: true;
  artifact?: { operationMatched: true; cursorArgumentName: 'cursor'; headCursorNullAllowed: true;
    countFeedsFirst?: boolean; cursorFeedsAfter?: boolean };
};

let current: ObservedContinuation | null = null;
const MAX_BYTES = 8 * 1024 * 1024;
function boundToSource(variables: Record<string, unknown>): boolean {
  const values = ['userID', 'id', 'profileID'].map(key => variables[key]).filter(value =>
    typeof value === 'string' && /^\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    .map(String);
  return values.includes(SOURCE_ID) && values.every(value => value === SOURCE_ID);
}
function validCursor(variables: Record<string, unknown>): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: variables, depth: 0 }]; let visited = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++visited > 10_000 || depth > 30) return false;
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:cursor|after|before|(?:start|end)[_]?cursor|continuation(?:[_]?(?:token|cursor|key))?)$/i.test(key)
        && typeof child === 'string' && child.length > 0) return true;
      if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}
function copy(value: ObservedContinuation): ObservedContinuation {
  return { endpoint: value.endpoint, friendlyName: value.friendlyName, form: new URLSearchParams(value.form),
    variables: structuredClone(value.variables), authenticated: value.authenticated, responseVerified: true,
    ...(value.artifact ? { artifact: { ...value.artifact } } : {}) };
}
export function resetObservedContinuation(): void { current = null; }
export function setObservedContinuation(value: ObservedContinuation): void {
  try {
    const url = new URL(value.endpoint);
    if (value.responseVerified !== true || url.origin !== FB_ORIGIN || url.pathname !== '/api/graphql/'
      || url.search || url.hash || url.username || url.password || typeof value.authenticated !== 'boolean'
      || value.friendlyName.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*Query$/.test(value.friendlyName)
      || !/Timeline[A-Za-z0-9_]*Query$/.test(value.friendlyName)
      || !value.variables || typeof value.variables !== 'object' || Array.isArray(value.variables)
      || !boundToSource(value.variables) || !validCursor(value.variables) || !(value.form instanceof URLSearchParams))
      throw Error('OBSERVED_QUERY_NOT_VERIFIED');
    if (['doc_id', 'variables', 'fb_api_req_friendly_name', '__user'].some(key => value.form.getAll(key).length > 1)
      || !/^\d+$/.test(value.form.get('doc_id') || '')
      || value.form.get('fb_api_req_friendly_name') !== value.friendlyName) throw Error('OBSERVED_QUERY_NOT_VERIFIED');
    const serialized = JSON.stringify(value.variables), formVariables = JSON.parse(value.form.get('variables') || '');
    if (Buffer.byteLength(serialized) > MAX_BYTES || JSON.stringify(formVariables) !== serialized)
      throw Error('OBSERVED_QUERY_NOT_VERIFIED');
    if (value.artifact && (value.artifact.operationMatched !== true || value.artifact.cursorArgumentName !== 'cursor'
      || value.artifact.headCursorNullAllowed !== true
      || value.artifact.countFeedsFirst !== undefined && typeof value.artifact.countFeedsFirst !== 'boolean'
      || value.artifact.cursorFeedsAfter !== undefined && typeof value.artifact.cursorFeedsAfter !== 'boolean'))
      throw Error('OBSERVED_QUERY_NOT_VERIFIED');
    current = copy(value);
  } catch { throw Error('OBSERVED_QUERY_NOT_VERIFIED'); }
}
// Copies prevent callers preparing a different cursor from changing the verified captured request.
export function getObservedContinuation(): ObservedContinuation | null { return current ? copy(current) : null; }
