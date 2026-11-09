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
export function mutationConfirmation(records: any[], action: ActionName, job: Job,
  requestProof: { commentTextAndActorVerified?: boolean } = {}): ConfirmedResult | null {
  if (!records.length || records.some(r => r?.error || r?.errors?.length)) return null;
  const stack = records.map(r => r?.data); let visited = 0;
  const commentIds = new Set(records.flatMap(r => [r?.data?.comment_create?.comment?.id,
    ...(r?.data?.comment_create?.feedback_comment_edges || []).map((edge: any) => edge?.node?.id)]).filter(id => typeof id === 'string'));
  if (action === 'comment' && requestProof.commentTextAndActorVerified && commentIds.size === 1) {
    const id = [...commentIds][0];
    if (id.length > 5 && !/^(?:client|temp|local)/i.test(id)) return { externalId: id, code: 'SERVER_CONFIRMED' };
  }
  while (stack.length) {
    const node = stack.pop(); if (++visited > 100000) return null;
    if (!node || typeof node !== 'object') continue;
    if (action === 'like' && node.feedback_react?.feedback) {
      const f = node.feedback_react.feedback;
      if (typeof f.id === 'string' && (f.viewer_has_reacted === true || f.viewer_feedback_reaction_info?.id))
        return { code: 'SERVER_CONFIRMED' };
    }
    if (action === 'comment' && (node.__typename === 'Comment' || node.__typename === undefined && commentIds.has(node.id)) && node.author?.id === job.accountId
      && node.body?.text === job.plan.comment && typeof node.id === 'string' && node.id.length > 5
      && !/^(?:client|temp|local)/i.test(node.id))
      return { externalId: node.id, externalUrl: safeFacebookUrl(node.url), code: 'SERVER_CONFIRMED' };
    if (action === 'share' && node.__typename === 'Story' && node.actors?.[0]?.id === job.accountId && /^\d+$/.test(node.post_id || '')) {
      const views = [node, node.comet_sections?.content?.story, node.comet_sections?.context_layout?.story].filter(view => view
        && (view === node || (view.__typename === undefined || view.__typename === 'Story')
          && (view.id === node.id || view.post_id === node.post_id)
          && (!view.post_id || view.post_id === node.post_id) && (!view.id || view.id === node.id)));
      if (!views.some(view => view.message?.text === job.plan.share)) continue;
      const externalUrl = views.map(view => safeFacebookUrl(view.url || view.wwwURL || view.permalink_url)).find(Boolean);
      if (externalUrl) return { externalId: node.post_id, externalUrl, code: 'SERVER_CONFIRMED' };
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
  }
  return null;
}
