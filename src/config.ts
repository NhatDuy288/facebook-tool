import type { ReadTarget } from './facebook/feed/read-target.ts';

export const READ_WINDOW_SIZE = 3;
export type Mode = 'dry-run' | 'test' | 'live';
export type ActionName = 'like' | 'share' | 'comment';
export const ACTIONS: ActionName[] = ['like', 'share', 'comment'];
export type Config = {
  version: 1; target: ReadTarget; mode: Mode; pollSeconds: number; keepSession: boolean;
  comments: string[]; shareText: string; hashtags: string[];
  actions: Record<ActionName, boolean>;
};
export const DEFAULT_CONFIG: Config = {
  version: 1, target: 'test-profile', mode: 'dry-run', pollSeconds: 2, keepSession: true,
  comments: ['test 1', 'test 2', 'test 3', 'test 4'], shareText: 'test', hashtags: ['#test'],
  actions: { like: true, share: true, comment: true },
};
export function validateConfig(input: unknown): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('CONFIG_INVALID');
  const c = input as Record<string, any>;
  if (!['test-profile', 'page'].includes(c.target) || !['dry-run', 'test', 'live'].includes(c.mode)
    || !Number.isInteger(c.pollSeconds) || c.pollSeconds < 1 || c.pollSeconds > 300
    || typeof c.keepSession !== 'boolean' || typeof c.shareText !== 'string' || c.shareText.length > 5000
    || !Array.isArray(c.comments) || c.comments.length > 200
    || c.comments.some((s: unknown) => typeof s !== 'string' || !s.trim() || s.length > 2000)
    || !Array.isArray(c.hashtags) || c.hashtags.length > 50
    || c.hashtags.some((s: unknown) => typeof s !== 'string' || !/^#[\p{L}\p{M}\p{N}_]{1,100}$/u.test(s))
    || !c.actions || ACTIONS.some(a => typeof c.actions[a] !== 'boolean')
    || !ACTIONS.some(a => c.actions[a]) || c.actions.comment && !c.comments.length) throw Error('CONFIG_INVALID');
  const comments = c.comments.map((s: string) => s.trim());
  const hashtags = [...new Set<string>(c.hashtags)];
  return { version: 1, target: c.target, mode: c.mode, pollSeconds: c.pollSeconds, keepSession: c.keepSession,
    comments, shareText: c.shareText.trim(), hashtags,
    actions: { like: c.actions.like, share: c.actions.share, comment: c.actions.comment } };
}
export type ContentPlan = { comment: string | null; share: string; audience: 'only_me' | 'public'; config: Config; cursor: number };
export function planContent(config: Config, cursor: number): ContentPlan {
  return { config: structuredClone(config), cursor,
    comment: config.actions.comment ? config.comments[cursor % config.comments.length] : null,
    share: [config.shareText, config.hashtags.join(' ')].filter(Boolean).join('\n'),
    audience: config.mode === 'live' ? 'public' : 'only_me' };
}
