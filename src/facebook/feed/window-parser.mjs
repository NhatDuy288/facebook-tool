// Validate only source-bound main timeline edges.
const KEYS = new Set(('data user timeline_list_feed_units edges node page_info pageInfo has_next_page hasNextPage '
  + 'end_cursor endCursor comet_sections content story context_layout feedback owning_profile actors id post_id '
  + 'creation_time is_pinned is_pinned_post is_featured is_featured_post pinned_post featured_post pinned_content featured').split(' '));
const safePath = parts => parts.slice(0, 64).map(part => Number.isSafeInteger(part) ? part : KEYS.has(part) ? part : '*');
const numeric = value => typeof value === 'string' && /^\d+$/.test(value) ? value : null;
function publicPermalink(value, sourceId) {
  try { const url = new URL(value);
    if (url.origin !== 'https://www.facebook.com') return null;
    if (/^\/[A-Za-z0-9.]+\/posts\/(?:pfbid[A-Za-z0-9]+|\d+)\/?$/.test(url.pathname)) return url.origin + url.pathname;
    if (url.pathname === '/permalink.php' && url.searchParams.get('id') === sourceId
      && /^(?:pfbid[A-Za-z0-9]+|\d+)$/.test(url.searchParams.get('story_fbid') || '')) {
      const clean = new URL('/permalink.php', url.origin); clean.searchParams.set('story_fbid', url.searchParams.get('story_fbid'));
      clean.searchParams.set('id', sourceId); return clean.href;
    }
    return null;
  } catch { return null; }
}
function markers(node) {
  const found = [], stack = [{ value: node, path: [], depth: 0 }]; let visited = 0;
  while (stack.length) {
    if (++visited > 20000) break;
    const { value, path, depth } = stack.pop();
    if (!value || typeof value !== 'object' || depth > 30) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'attached_story') continue;
      const next = [...path, Array.isArray(value) ? Number(key) : key];
      if (/(?:^|_)(?:pinned|featured)(?:_|$)/i.test(key)) found.push({
        category: /pinned/i.test(key) ? 'pin_related_key' : 'featured_related_key', path: safePath(next),
        valueKind: child === null ? 'null' : typeof child,
        ...(typeof child === 'boolean' ? { booleanValue: child } : {}) });
      if (child && typeof child === 'object') stack.push({ value: child, path: next, depth: depth + 1 });
    }
  }
  return { keyEvidence: found.slice(0, 64), keyEvidenceTruncated: found.length > 64 || visited > 20000,
    pinStatus: 'unknown', featuredStatus: 'unknown', meaning: 'Key presence is schema evidence, not proof that a post is pinned or featured.' };
}
function edgeMetadata(edge, sourceId, edgeIndex) {
  const node = edge?.node;
  const result = { edgeIndex, nodeTypenameIsStory: node?.__typename === 'Story',
    rootPostIdPresent: !!numeric(node?.post_id), rootCreationTimePresent: Number.isSafeInteger(node?.creation_time),
    pinAndFeatured: markers(node), classification: 'unverified_edge' };
  if (node?.__typename !== 'Story') return result;
  // These are main-story view fragments, not a recursive census of every Story under an edge.
  const paths = [[], ['comet_sections', 'content', 'story'], ['comet_sections', 'context_layout', 'story'],
    ['comet_sections', 'feedback', 'story'], ['context_layout', 'story']];
  const candidates = paths.map(path => ({ path, value: path.reduce((v, key) => v?.[key], node) }))
    .filter(({ value }) => value && (value === node || value.__typename === 'Story')
      && (value === node || typeof node.id === 'string' && typeof value.id === 'string' && node.id === value.id
        || numeric(node.post_id) && node.post_id === numeric(value.post_id)));
  const ids = new Set(candidates.map(({ value }) => numeric(value.post_id)).filter(Boolean));
  const times = new Set(candidates.map(({ value }) => value.creation_time).filter(v => Number.isSafeInteger(v) && v > 0));
  const owners = new Set(candidates.map(({ value }) => numeric(value.feedback?.owning_profile?.id)).filter(Boolean));
  const actors = new Set(candidates.map(({ value }) => numeric(value.actors?.[0]?.id)).filter(Boolean));
  result.observedPostIds = [...ids];
  result.metadataViewPaths = candidates.filter(({ value }) => numeric(value.post_id)).map(({ path }) => safePath(path));
  if (ids.size !== 1 || times.size !== 1) { result.classification = 'missing_or_conflicting_main_story_metadata'; return result; }
  if (!sourceId || [...owners, ...actors].some(id => id !== sourceId) || (!owners.has(sourceId) && !actors.has(sourceId))) {
    result.classification = 'missing_or_conflicting_source_identity'; return result;
  }
  return { ...result, classification: 'verified_main_timeline_edge', post_id: [...ids][0], creation_time: [...times][0],
    ownerId: owners.has(sourceId) ? sourceId : null, mainActorId: actors.has(sourceId) ? sourceId : null,
    sourceVerification: owners.has(sourceId) ? 'canonical_profile_owner_id' : 'canonical_profile_main_actor_id',
    permalink: candidates.flatMap(({ value }) => [value.url, value.wwwURL, value.permalink_url]).map(value => publicPermalink(value, sourceId)).find(Boolean) || null };
}

export function inspectWindows(records, { sourceId } = {}) {
  const observations = [], pages = [], frames = [], unsupportedPatchPaths = []; let parentSourceConflict = false;
  function connection(value, path, frameIndex, kind) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.edges)) value.edges.forEach((edge, index) => observations.push({
      frameIndex, frameKind: kind, connectionPath: safePath(path), ...edgeMetadata(edge, sourceId, index) }));
    for (const name of ['page_info', 'pageInfo']) {
      const page = value[name]; if (!page || typeof page !== 'object') continue;
      const flags = [page.has_next_page, page.hasNextPage].filter(v => typeof v === 'boolean');
      pages.push({ frameIndex, frameKind: kind, path: safePath([...path, name]),
        hasNextPage: flags.length && flags.every(v => v === flags[0]) ? flags[0] : null,
        endCursorPresent: [page.end_cursor, page.endCursor].some(v => typeof v === 'string' && !!v) });
    }
  }
  records.forEach((record, frameIndex) => {
    const base = Array.isArray(record?.path) ? record.path : [];
    const kind = base.length || record?.label ? 'patch' : 'initial';
    frames.push({ frameIndex, kind, path: safePath(base), isFinal: typeof record?.extensions?.is_final === 'boolean'
      ? record.extensions.is_final : null });
    if (!base.length) {
      const parentId = numeric(record?.data?.user?.id);
      if (parentId && parentId !== sourceId) parentSourceConflict = true;
      connection(record?.data?.user?.timeline_list_feed_units, ['user', 'timeline_list_feed_units'], frameIndex, kind);
    }
    else if (base.length === 2 && base[0] === 'user' && base[1] === 'timeline_list_feed_units')
      connection(record.data, base, frameIndex, kind);
    else if (base.length === 3 && base[0] === 'user' && base[1] === 'timeline_list_feed_units'
      && ['page_info', 'pageInfo'].includes(base[2])) connection({ [base[2]]: record.data }, base.slice(0, 2), frameIndex, kind);
    else if (base[0] === 'user' && base[1] === 'timeline_list_feed_units') unsupportedPatchPaths.push(safePath(base));
    for (const patch of record?.incremental || []) {
      const path = patch?.path;
      if (Array.isArray(path) && path.length === 2 && path[0] === 'user' && path[1] === 'timeline_list_feed_units')
        connection(patch.data, path, frameIndex, 'incremental_patch');
      else if (Array.isArray(path) && path[0] === 'user' && path[1] === 'timeline_list_feed_units') unsupportedPatchPaths.push(safePath(path));
    }
  });
  const posts = new Map(), rejected = [], poisonedIds = new Set();
  for (const item of observations) {
    if (item.classification !== 'verified_main_timeline_edge') {
      rejected.push(item); for (const id of item.observedPostIds || []) poisonedIds.add(id); continue;
    }
    const prior = posts.get(item.post_id);
    if (prior && prior.creation_time !== item.creation_time) {
      prior.classification = 'conflicting_repeat_metadata'; poisonedIds.add(item.post_id); continue;
    }
    if (!prior) posts.set(item.post_id, item);
  }
  const accepted = parentSourceConflict ? [] : [...posts.values()].filter(item => item.classification === 'verified_main_timeline_edge' && !poisonedIds.has(item.post_id));
  return { sourceId: numeric(sourceId), mainTimelineEdgesObserved: observations.length, uniqueVerifiedPosts: accepted.length,
    posts: accepted, rejectedEdges: rejected, parentSourceConflict, poisonedPostIds: [...poisonedIds], frames, pagination: pages,
    unsupportedMainTimelinePatchPaths: unsupportedPatchPaths,
    patchHandling: unsupportedPatchPaths.length ? 'scoped_edge_patches_observed_but_not_merged' : 'no_unsupported_scoped_edge_patches_observed',
    receivedOrderChronologicalDescending: accepted.length > 1 ? accepted.every((p, i) => !i || accepted[i - 1].creation_time >= p.creation_time) : null,
    coverage: 'unknown', actualNewestFiveGuaranteed: false };
}
