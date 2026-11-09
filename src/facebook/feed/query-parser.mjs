// Bounded JSON/GraphQL response parsing. No network requests or saved credentials.
const PATH_KEYS = new Set(('data user viewer page profile timeline_list_feed_units edges node nodes '
  + 'comet_sections content story context_layout metadata message feedback attachments actors owning_profile '
  + 'page_info pageInfo has_next_page hasNextPage end_cursor endCursor cursor incremental extensions '
  + 'privacy_scope actor_photo title footer action_link description social_context comments '
  + 'feedback_context reaction_count subscription_target is_final errors').split(' '));
for (const key of ['post_id', 'creation_time', 'id', 'actors', 'owning_profile', '__typename']) PATH_KEYS.add(key);
function safePath(path) {
  return Array.isArray(path) ? path.slice(0, 64).map(part => Number.isSafeInteger(part) ? part
    : typeof part === 'string' && PATH_KEYS.has(part) ? part : '*') : null;
}
export function parseRecords(text) {
  text = text.replace(/^\s*for\s*\(;;\);\s*/, '');
  const records = []; let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    if (index === text.length) break;
    if (!['{', '['].includes(text[index])) throw Error('non_json_query_response');
    const start = index; let depth = 0, quoted = false, escaped = false, done = false;
    for (; index < text.length; index++) {
      const c = text[index];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) {
        records.push(JSON.parse(text.slice(start, ++index))); done = true; break;
      }
    }
    if (!done) throw Error('incomplete_json_query_response');
  }
  return records.flat(); // A top-level JSON batch contains separate response frames.
}
function safeError(error) {
  const code = value => typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null;
  const severity = error?.severity ?? error?.extensions?.severity;
  const path = Array.isArray(error?.path) ? error.path : null;
  const text = typeof error?.message === 'string' ? error.message : '';
  const accessIndicator = error?.requires_reauth === true
    || /not logged|log(?:ged)? in|authentica|access token|invalid.{0,20}token|permission|checkpoint|rate.limit|too many/i.test(text);
  const metadataIdentityPathPresent = !!path?.some(part => ['post_id', 'creation_time', 'id', 'actors', 'owning_profile', '__typename'].includes(part));
  return { code: code(error?.code ?? error?.extensions?.code), apiErrorCode: code(error?.api_error_code),
    severity: typeof severity === 'string' && /^(WARNING|ERROR|CRITICAL|INFO|FATAL)$/.test(severity) ? severity : null,
    path: safePath(path), requiresReauth: typeof error?.requires_reauth === 'boolean' ? error.requires_reauth : null,
    transient: typeof error?.is_transient === 'boolean' ? error.is_transient : null,
    metadataIdentityPathPresent,
    classification: accessIndicator ? 'auth_access_or_rate_indicator'
      : metadataIdentityPathPresent ? 'metadata_or_identity_path_error'
        : path?.includes('timeline_list_feed_units') && path.some(part => ['comet_sections', 'feedback', 'attachments'].includes(part))
        ? 'timeline_post_subfield_error' : path?.includes('timeline_list_feed_units') ? 'timeline_connection_error'
          : path ? 'other_structural_path_error' : 'unscoped_graphql_error',
    classificationIsInference: true };
}
export function inspectRecords(records) {
  const errors = [], pagination = [], recordSummaries = []; let visited = 0;
  for (const record of records) {
    const base = Array.isArray(record?.path) ? record.path : [];
    recordSummaries.push({ patch: !!record?.label || base.length > 0 || Array.isArray(record?.incremental),
      labelPresent: typeof record?.label === 'string', path: safePath(base),
      dataPresent: !!record && Object.hasOwn(record, 'data'),
      isFinal: typeof record?.extensions?.is_final === 'boolean' ? record.extensions.is_final : null,
      hasNext: typeof record?.hasNext === 'boolean' ? record.hasNext : null,
      incrementalPatchCount: Array.isArray(record?.incremental) ? record.incremental.length : 0 });
    const stack = [{ value: record, path: base, depth: 0 }];
    while (stack.length) {
      if (++visited > 300000) throw Error('inspection_node_limit');
      const { value, path, depth } = stack.pop();
      if (!value || typeof value !== 'object' || depth > 80) continue;
      if (Array.isArray(value.errors)) errors.push(...value.errors.map(safeError));
      for (const [key, child] of Object.entries(value)) {
        if (['page_info', 'pageInfo'].includes(key) && child && typeof child === 'object') {
          const flags = [child.has_next_page, child.hasNextPage].filter(x => typeof x === 'boolean');
          pagination.push({ path: safePath([...path, key]),
            scope: path.includes('timeline_list_feed_units') ? 'timeline_connection' : 'other_response_path',
            hasNextPage: flags.length && flags.every(x => x === flags[0]) ? flags[0] : null,
            endCursorPresent: [child.end_cursor, child.endCursor].some(x => typeof x === 'string' && !!x) });
        } else if (['has_next_page', 'hasNextPage'].includes(key)) pagination.push({
          path: safePath([...path, key]), scope: path.includes('timeline_list_feed_units') ? 'timeline_connection' : 'other_response_path',
          hasNextPage: typeof child === 'boolean' ? child : null });
        if (child && typeof child === 'object' && key !== 'errors') stack.push({
          value: child, path: [...path, Array.isArray(value) ? Number(key) : key], depth: depth + 1 });
      }
    }
  }
  return { records: recordSummaries, recordCount: records.length,
    patchRecordCount: recordSummaries.filter(record => record.patch).length,
    finalTrueRecordCount: recordSummaries.filter(record => record.isFinal === true).length,
    finalFalseRecordCount: recordSummaries.filter(record => record.isFinal === false).length,
    errors, errorCount: errors.length, pagination,
    interpretation: 'Subfield errors may leave metadata usable but do not prove all optional fields or feed coverage complete.' };
}
