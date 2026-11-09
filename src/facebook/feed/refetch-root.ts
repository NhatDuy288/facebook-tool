// Recognize the observed Relay node root without inventing a parent identity or traversing Stories.
type Frame = Record<string, any>;
const object = (value: unknown): value is Frame => !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeRefetchRoot(input: any[], sourceId: string) {
  const diagnostics = { mappedInitialRoots: 0, mappedScopedPatches: 0, rejectedRoots: 0,
    orphanScopedPatches: 0, ambiguousRoots: 0 };
  let verifiedNodeBase = false, userBaseSeen = false, invalid = false;
  function patch(frame: Frame): Frame {
    const path = frame.path;
    if (!Array.isArray(path) || path[0] !== 'node' || path[1] !== 'timeline_list_feed_units') return frame;
    if (!verifiedNodeBase) { invalid = true; diagnostics.orphanScopedPatches++; return frame; }
    diagnostics.mappedScopedPatches++;
    return { ...frame, path: ['user', ...path.slice(1)] };
  }
  const records = input.map(frame => {
    if (!object(frame)) return frame;
    let normalized = frame;
    const initial = !Array.isArray(frame.path) || frame.path.length === 0;
    if (initial && object(frame.data)) {
      const hasNode = Object.hasOwn(frame.data, 'node'), hasUser = Object.hasOwn(frame.data, 'user');
      if (hasNode && hasUser || hasNode && userBaseSeen || hasUser && verifiedNodeBase) {
        invalid = true; diagnostics.ambiguousRoots++;
      } else if (hasNode) {
        const node = frame.data.node;
        if (!object(node) || node.id !== sourceId || !object(node.timeline_list_feed_units)
          || !Array.isArray(node.timeline_list_feed_units.edges)) {
          invalid = true; diagnostics.rejectedRoots++;
        } else {
          verifiedNodeBase = true; diagnostics.mappedInitialRoots++;
          const data: Frame = { ...frame.data, user: node }; delete data.node;
          normalized = { ...frame, data };
        }
      } else if (hasUser) userBaseSeen = true;
    } else normalized = patch(frame);
    if (Array.isArray(frame.incremental)) normalized = { ...normalized,
      incremental: frame.incremental.map((part: unknown) => object(part) ? patch(part) : part) };
    return normalized;
  });
  return { records, usable: !invalid, reasonCode: invalid ? 'ROOT_NORMALIZATION_INVALID' : null, diagnostics };
}
