// RAM-only assembly of explicitly indexed main timeline edge frames. No Story census.
type Frame = Record<string, any>;
const object = (value: unknown): value is Frame => !!value && typeof value === 'object' && !Array.isArray(value);
const scoped = (path: unknown): path is (string | number)[] => Array.isArray(path)
  && path[0] === 'user' && path[1] === 'timeline_list_feed_units';
const samePath = (path: unknown, suffix: (string | number)[]) => Array.isArray(path)
  && path.length === suffix.length + 2 && scoped(path) && suffix.every((key, index) => path[index + 2] === key);
// These deferred Video fields do not establish the identity, time or order of a post.
const VIDEO_FIELDS = new Set(('dubbed_track_mapping can_viewer_share creation_story end_cards_channel_info '
  + 'is_soundbites_video is_looping info comet_video_player_with_video_card_renderer id '
  + 'instream_extra_config instream_video_ad_breaks_comet comet_video_player_live_video_endscreen_content '
  + 'live_end_text is_huddle is_live_audio_room_v2_broadcast associated_paid_online_event '
  + 'is_live_streaming is_paid_virtual_event_premium_content').split(' '));

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function attachmentVideo(story: Frame, path: (string | number)[]): unknown {
  const [attachments, attachmentIndex, styles, attachment, field, styleIndex, containingStory, nestedAttachments,
    nestedIndex, nestedMedia] = path;
  if (attachments !== 'attachments' || !isIndex(attachmentIndex) || styles !== 'styles' || attachment !== 'attachment') return;
  const renderer = story.attachments?.[attachmentIndex]?.styles;
  if (path.length === 5 && field === 'media') return renderer?.attachment?.media;
  if (path.length !== 10 || field !== 'style_infos' || !isIndex(styleIndex) || containingStory !== 'containing_story'
    || nestedAttachments !== 'attachments' || !isIndex(nestedIndex) || nestedMedia !== 'media'
    || renderer?.__typename !== 'StoryAttachmentUnifiedLightweightVideoStyleRenderer') return;
  const styleInfo = renderer.attachment?.style_infos?.[styleIndex];
  if (styleInfo?.__typename !== 'VideoAttachmentStyleInfo') return;
  return styleInfo.containing_story?.attachments?.[nestedIndex]?.media;
}

export function normalizeStreamFrames(input: any[]) {
  const diagnostics = { convertedEdgePatches: 0, rejectedEdgePatches: 0, duplicateEdgePatches: 0,
    unsupportedScopedPatches: 0, ignoredVideoPatches: 0, initialEdgesObserved: 0, assembledPositions: 0 };
  const positions = new Map<number, string>(), edgeReferences = new WeakMap<object, number>();
  const indexedEdges = new Map<number, Frame>();
  let invalid = false;
  const reject = () => { invalid = true; diagnostics.rejectedEdgePatches++; };
  function register(edge: unknown, index: number, initial = false): boolean {
    if (!Number.isSafeInteger(index) || index < 0 || index > 4 || !object(edge) || !object(edge.node)
      || edge.node.__typename !== 'Story') { reject(); return false; }
    const referencedIndex = edgeReferences.get(edge);
    if (referencedIndex !== undefined && referencedIndex !== index) { reject(); return false; }
    edgeReferences.set(edge, index);
    let signature: string;
    try { signature = JSON.stringify(edge); } catch { reject(); return false; }
    if (positions.has(index)) {
      // Only an identical replay is idempotent. Partial or conflicting replacements fail closed.
      if (positions.get(index) !== signature) { reject(); return false; }
      if (!initial) diagnostics.duplicateEdgePatches++;
    } else { positions.set(index, signature); indexedEdges.set(index, edge); }
    return true;
  }
  function connection(value: unknown) {
    if (!object(value) || !Array.isArray(value.edges)) return;
    diagnostics.initialEdgesObserved += value.edges.length;
    value.edges.forEach((edge: unknown, index: number) => register(edge, index, true));
  }
  function normalizePatch(frame: Frame): Frame {
    const path = frame.path;
    if (!scoped(path)) return frame;
    if (samePath(path, [])) { connection(frame.data); return frame; }
    if (samePath(path, ['page_info']) || samePath(path, ['pageInfo'])) return frame;
    if (path[2] === 'edges' && Number.isSafeInteger(path[3]) && path[4] === 'node'
      && object(frame.data) && !Object.hasOwn(frame, 'items')) {
      const root = indexedEdges.get(Number(path[3]))?.node;
      let story = root, rest = path.slice(5);
      if (rest[0] === 'comet_sections' && rest[1] === 'content' && rest[2] === 'story') {
        story = root?.comet_sections?.content?.story; rest = rest.slice(3);
        if (!object(story) || typeof root?.id !== 'string' || story.id !== root.id
          || Object.hasOwn(story, '__typename') && story.__typename !== 'Story'
          || Object.hasOwn(story, 'post_id') && story.post_id !== root.post_id) story = null;
      }
      if (object(story)) {
        const media = attachmentVideo(story, rest);
        const keys = Object.keys(frame.data);
        if (object(media) && media.__typename === 'Video' && typeof media.id === 'string' && media.id
          && keys.length > 0 && keys.every(key => VIDEO_FIELDS.has(key))
          && (!Object.hasOwn(frame.data, 'id') || frame.data.id === media.id)) {
          diagnostics.ignoredVideoPatches++;
          // Do not merge or traverse media payloads. Keep final/error evidence on the frame;
          // capture.ts still inspects the original response for GraphQL/authentication errors.
          return { ...frame, path: ['user', 'timeline_list_feed_units'], data: {} };
        }
      }
    }
    if (path.length !== 4 || path[2] !== 'edges' || !Number.isSafeInteger(path[3])
      || Number(path[3]) < 0 || Number(path[3]) > 4) {
      diagnostics.unsupportedScopedPatches++; return frame;
    }
    const index = Number(path[3]);
    // Standard items frames and single-edge data frames are unambiguous; never accept a bare Story.
    const edges = Object.hasOwn(frame, 'items') && !Object.hasOwn(frame, 'data') && Array.isArray(frame.items)
      ? frame.items : Object.hasOwn(frame, 'data') && !Object.hasOwn(frame, 'items') ? [frame.data] : null;
    if (!edges || !edges.length || edges.length > 5 || index + edges.length > 5) { reject(); return frame; }
    let valid = true;
    edges.forEach((edge: unknown, offset: number) => { if (!register(edge, index + offset)) valid = false; });
    if (!valid) return frame;
    diagnostics.convertedEdgePatches += edges.length;
    const normalized: Frame = { ...frame, path: ['user', 'timeline_list_feed_units'], data: { edges } };
    delete normalized.items;
    return normalized;
  }
  const records = input.map(frame => {
    if (!object(frame)) return frame;
    if (!Array.isArray(frame.path) || !frame.path.length) connection(frame.data?.user?.timeline_list_feed_units);
    let normalized = Array.isArray(frame.path) && frame.path.length ? normalizePatch(frame) : frame;
    if (Array.isArray(frame.incremental)) normalized = { ...normalized,
      incremental: frame.incremental.map((patch: unknown) => object(patch) ? normalizePatch(patch) : patch) };
    return normalized;
  });
  if (diagnostics.convertedEdgePatches) {
    const highest = Math.max(...positions.keys());
    for (let index = 0; index <= highest; index++) if (!positions.has(index)) { reject(); break; }
  }
  diagnostics.assembledPositions = positions.size;
  // Response arrival order can differ from Relay's explicit edge positions. Keep these
  // original edge references in RAM so callers can select slots without a time sort.
  const orderedEdges = [...indexedEdges].sort(([a], [b]) => a - b).map(([, edge]) => edge);
  return { records, orderedEdges, usable: !invalid, reasonCode: invalid ? 'STREAM_ASSEMBLY_INVALID' : null, diagnostics };
}
