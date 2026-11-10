import type { ActionName } from '../config.ts';
import type { Job, ConfirmedResult } from '../types.ts';
export function mutationActorAllowed(form: URLSearchParams, accountId: string): boolean {
  if (!/Mutation$/.test(form.get('fb_api_req_friendly_name') || '')) return true;
  try {
    const input = JSON.parse(form.get('variables') || '{}')?.input;
    return form.get('__user') === accountId && (input?.actor_id === undefined || String(input.actor_id) === accountId);
  } catch { return false; }
}
export function safeFacebookUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://www.facebook.com' || url.username || url.password) return;
    for (const key of [...url.searchParams.keys()]) if (!['id', 'story_fbid', 'comment_id'].includes(key)) url.searchParams.delete(key);
    url.hash = ''; return url.href;
  } catch { return; }
}
export type CommentRequestProof = { commentTextAndActorVerified: boolean; commentTargetVerified: boolean;
  commentRequestCompatible: boolean; feedbackId?: string };
export function commentRequestProof(form: URLSearchParams, job: Job, feedbackIds: string[]): CommentRequestProof {
  const missing: CommentRequestProof = { commentTextAndActorVerified: false, commentTargetVerified: false, commentRequestCompatible: false };
  try {
    const input = JSON.parse(form.get('variables') || '{}')?.input;
    const text = typeof input?.message === 'string' ? input.message : input?.message?.text;
    const actor = form.get('__user') === job.accountId && input?.actor_id === job.accountId;
    const topLevel = input?.parent_comment_id == null || input?.parent_comment_id === '';
    const feedbackId = typeof input?.feedback_id === 'string' ? input.feedback_id : undefined;
    return { commentTextAndActorVerified: actor && topLevel && typeof job.plan.comment === 'string' && text === job.plan.comment,
      commentTargetVerified: !!feedbackId && feedbackIds.includes(feedbackId), feedbackId,
      commentRequestCompatible: !!input && form.get('__user') === job.accountId
        && (input.actor_id === undefined || String(input.actor_id) === job.accountId) && topLevel
        && (text === undefined || text === job.plan.comment)
        && (!feedbackId || !feedbackIds.length || feedbackIds.includes(feedbackId)) };
  } catch { return missing; }
}
export function matchesFacebookPostUrl(value: unknown, postId: string, ownerId: string, canonical?: string | null): boolean {
  const safe = safeFacebookUrl(value); if (!safe) return false;
  const url = new URL(safe);
  if (url.searchParams.has('id') && url.searchParams.get('id') !== ownerId) return false;
  if (url.pathname === '/permalink.php' || url.pathname === '/story.php') return url.searchParams.get('story_fbid') === postId;
  if (url.searchParams.has('story_fbid') && url.searchParams.get('story_fbid') !== postId) return false;
  return new RegExp('^/[^/]+/posts/' + postId + '/?$').test(url.pathname)
    || !!canonical && safe === safeFacebookUrl(canonical);
}
function opaqueShareUrl(value: unknown, ownerId: string): boolean {
  const safe = safeFacebookUrl(value); if (!safe) return false;
  const url = new URL(safe);
  // Opaque pfbid links cannot be decoded into post_id. The mapping must come from
  // this verified Story's own URL field; read-back remains mandatory without full proof.
  return /^\/[^/]+\/posts\/pfbid[A-Za-z0-9]+\/?$/.test(url.pathname)
    && !url.searchParams.has('story_fbid') && (!url.searchParams.has('id') || url.searchParams.get('id') === ownerId);
}
function storyViews(node: any): any[] {
  return [node, node.comet_sections?.content?.story, node.comet_sections?.context_layout?.story].filter(view => view
    && (view === node || (view.__typename === undefined || view.__typename === 'Story')
      && (!!node.id && view.id === node.id || view.post_id === node.post_id)
      && (!view.post_id || view.post_id === node.post_id) && (!view.id || view.id === node.id)));
}
function shareProof(records: any[], node: any, job: Job): NonNullable<ConfirmedResult['shareProof']> {
  const missing = { identityVerified: false, audience: null } as const;
  // Only the created Story's own fields qualify. Never borrow privacy from the attached original.
  const created = records.map(r => r?.data?.story_create?.story).filter(Boolean);
  if (!created.includes(node) || new Set(created.map(story => story.post_id)).size !== 1) return missing;
  const views = created.flatMap(storyViews);
  if (node.post_id === job.post.post_id || views.some(view => view.actors && (!Array.isArray(view.actors)
    || view.actors.length !== 1 || view.actors[0]?.id !== job.accountId))) return missing;
  if (views.some(view => view.feedback?.owning_profile?.id && view.feedback.owning_profile.id !== job.accountId)) return missing;
  if (views.some(view => view.message && view.message.text !== job.plan.share)) return missing;
  const attachments = views.flatMap(view => [view.attached_story, view.comet_sections?.attached_story?.story]).filter(Boolean);
  if (attachments.some(story => story.post_id && story.post_id !== job.post.post_id
    || story.actors && (!Array.isArray(story.actors) || story.actors.some((actor: any) => actor.id !== job.sourceId))
    || story.feedback?.owning_profile?.id && story.feedback.owning_profile.id !== job.sourceId)) return missing;
  const original = attachments.some(story => {
    if (story.post_id && story.post_id !== job.post.post_id) return false;
    if (story.actors && (!Array.isArray(story.actors) || story.actors.some((actor: any) => actor.id !== job.sourceId))) return false;
    return story.post_id === job.post.post_id || [story.url, story.permalink_url, story.wwwURL]
      .some(url => matchesFacebookPostUrl(url, job.post.post_id, job.sourceId, job.post.permalink));
  });
  if (!original) return missing;
  const audiences = new Set<'only_me' | 'public'>(); let unknown = false;
  for (const view of views) {
    if (!Object.hasOwn(view, 'privacy_scope')) continue;
    const privacy = view.privacy_scope;
    if (!privacy || typeof privacy !== 'object') { unknown = true; continue; }
    let found = false;
    for (const key of ['type', 'label']) {
      if (!Object.hasOwn(privacy, key)) continue;
      const value = typeof privacy[key] === 'string' ? privacy[key].trim() : '';
      if (/^(only_me|only me|chỉ mình tôi)$/i.test(value)) { audiences.add('only_me'); found = true; }
      else if (/^(public|công khai)$/i.test(value)) { audiences.add('public'); found = true; }
      else unknown = true;
    }
    if (!found) unknown = true;
  }
  return { identityVerified: true, audience: !unknown && audiences.size === 1 ? [...audiences][0] : null };
}
export function mutationHasErrors(records: any[]): boolean {
  const hasErrors = (value: any) => !!value?.error || value?.errors != null && (!Array.isArray(value.errors) || value.errors.length > 0);
  return records.some(r => hasErrors(r) || hasErrors(r?.data?.comment_create) || hasErrors(r?.data?.story_create)
    || Array.isArray(r?.incremental) && r.incremental.some(hasErrors));
}
export function mutationConfirmation(records: any[], action: ActionName, job: Job,
  requestProof: Partial<CommentRequestProof> = {}): ConfirmedResult | null {
  if (!records.length || mutationHasErrors(records)) return null;
  const stack = records.map(r => r?.data); let visited = 0;
  if (action === 'comment') {
    if (!requestProof.commentTextAndActorVerified || !requestProof.commentTargetVerified || !requestProof.feedbackId) return null;
    const comments: any[] = [];
    for (const record of records) {
      const created = record?.data?.comment_create; if (!created) continue;
      if (created.feedback?.id && created.feedback.id !== requestProof.feedbackId) return null;
      if (created.feedback_comment_edges !== undefined && !Array.isArray(created.feedback_comment_edges)) return null;
      for (const candidate of [created.comment, created.feedback_comment_edge?.node,
        ...(created.feedback_comment_edges || []).map((edge: any) => edge?.node)]) {
        if (!candidate) continue;
        if (candidate.__typename && candidate.__typename !== 'Comment'
          || typeof candidate.id !== 'string' || candidate.id.length <= 5 || /^(?:client|temp|local)/i.test(candidate.id)
          || candidate.author && candidate.author.id !== job.accountId
          || candidate.body && candidate.body.text !== job.plan.comment) return null;
        comments.push(candidate);
      }
    }
    const ids = new Set(comments.map(comment => comment.id));
    return ids.size === 1 ? { externalId: [...ids][0], code: 'SERVER_CONFIRMED' } : null;
  }
  while (stack.length) {
    const node = stack.pop(); if (++visited > 100000) return null;
    if (!node || typeof node !== 'object') continue;
    if (action === 'like' && node.feedback_react?.feedback) {
      const f = node.feedback_react.feedback;
      if (typeof f.id === 'string' && (f.viewer_has_reacted === true || f.viewer_feedback_reaction_info?.id))
        return { code: 'SERVER_CONFIRMED' };
    }
    if (action === 'share' && node.__typename === 'Story' && node.actors?.[0]?.id === job.accountId && /^\d+$/.test(node.post_id || '')) {
      if (node.post_id === job.post.post_id) continue;
      const views = storyViews(node);
      if (!views.some(view => view.message?.text === job.plan.share)) continue;
      const externalUrl = views.flatMap(view => [view.url, view.wwwURL, view.permalink_url]).map(safeFacebookUrl)
        .find(url => matchesFacebookPostUrl(url, node.post_id, job.accountId) || opaqueShareUrl(url, job.accountId));
      if (externalUrl) return { externalId: node.post_id, externalUrl, code: 'SERVER_CONFIRMED', shareProof: shareProof(records, node, job) };
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
  }
  return null;
}
