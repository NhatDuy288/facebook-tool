import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_WINDOW_SIZE, DEFAULT_CONFIG, validateConfig, planContent } from './config.ts';
test('UI configuration validates hashtags, content and enabled actions', () => {
  const c = validateConfig({ ...DEFAULT_CONFIG, comments: [' nội dung 1 ', 'nội dung 2'], hashtags: ['#thử_nghiệm', '#test', '#test'] });
  assert.deepEqual(c.comments, ['nội dung 1', 'nội dung 2']);
  assert.deepEqual(c.hashtags, ['#thử_nghiệm', '#test']);
  for (const patch of [{ pollSeconds: 0 }, { comments: [] }, { hashtags: ['test'] }, { hashtags: ['#hai từ'] },
    { actions: { like: false, share: false, comment: false } }, { target: 'https://example.com' }])
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, ...patch }), /CONFIG_INVALID/);
});
test('comment rotation and share audience are determined before a post arrives', () => {
  assert.deepEqual(Array.from({ length: 5 }, (_, n) => planContent(DEFAULT_CONFIG, n).comment), ['test 1', 'test 2', 'test 3', 'test 4', 'test 1']);
  assert.equal(planContent(DEFAULT_CONFIG, 0).audience, 'only_me');
  assert.equal(planContent({ ...DEFAULT_CONFIG, mode: 'live' }, 0).audience, 'public');
  const plan = planContent(DEFAULT_CONFIG, 0); plan.config.comments[0] = 'khác';
  assert.equal(DEFAULT_CONFIG.comments[0], 'test 1');
});

test('reader defaults use three visible posts and a two-second completion-to-next-read wait', () => {
  assert.equal(READ_WINDOW_SIZE, 3); assert.equal(DEFAULT_CONFIG.pollSeconds, 2);
});
