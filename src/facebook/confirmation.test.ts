import test from 'node:test';
import assert from 'node:assert/strict';
import { mutationConfirmation, mutationActorAllowed, safeFacebookUrl, commentRequestProof, matchesFacebookPostUrl } from './confirmation.ts';
import type { Job } from '../types.ts';
import { DEFAULT_CONFIG, planContent } from '../config.ts';
const job:Job={id:'job',sessionId:'session',accountId:'10',sourceId:'20',post:{post_id:'30',creation_time:10,permalink:null,sourceVerification:'owner'},
  mode:'test',createdAt:'now',plan:planContent(DEFAULT_CONFIG,0),actions:[]};
test('UI write guard refuses a different selected actor even with the same logged-in user',()=>{
  const form=new URLSearchParams({fb_api_req_friendly_name:'useCometUFICreateCommentMutation',__user:'10',variables:JSON.stringify({input:{actor_id:'10'}})});
  assert.equal(mutationActorAllowed(form,'10'),true);
  form.set('variables',JSON.stringify({input:{actor_id:'99'}}));assert.equal(mutationActorAllowed(form,'10'),false);
  form.set('variables',JSON.stringify({input:{actor_id:'10'}}));form.set('__user','99');assert.equal(mutationActorAllowed(form,'10'),false);
  form.set('variables','{invalid');assert.equal(mutationActorAllowed(form,'10'),false);
});
const commentForm = (input: Record<string, unknown> = {}) => new URLSearchParams({ __user: '10', variables: JSON.stringify({ input: {
  actor_id: '10', feedback_id: 'feedback-original-30', message: { text: 'test 1' }, ...input,
} }) });
const proof = commentRequestProof(commentForm(), job, ['feedback-original-30']);
test('comment confirmations require a server comment bound to the exact actor, text and original post',()=>{
  const comment={__typename:'Comment',id:'comment_100',author:{id:'10'},body:{text:'test 1'}};
  assert.equal(mutationConfirmation([{data:{comment_create:{comment}}}],'comment',job,proof)?.externalId,'comment_100');
  assert.equal(mutationConfirmation([{data:{comment:{...comment,author:{id:'11'}}}}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment:{...comment,body:{text:'test 2'}}}}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment},errors:[{message:'denied'}]}],'comment',job,proof),null);
  assert.equal(mutationConfirmation([{data:{comment_create:{comment:{...comment,id:'client:100'}}}}],'comment',job,proof),null);
  assert.equal(mutationConfirmation([{data:{comment_create:{comment:{id:'server_comment_100'}}}}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment_create:{comment:{id:'server_comment_100'}}}}],'comment',job,proof)?.externalId,'server_comment_100');
});

test('singular and plural comment edges qualify only with bound request proof and no conflicting evidence', () => {
  const single = { data: { comment_create: { feedback: { id: 'feedback-original-30' },
    feedback_comment_edge: { node: { __typename: 'Comment', id: 'server_comment_100' } } } } };
  assert.equal(mutationConfirmation([single], 'comment', job, proof)?.externalId, 'server_comment_100');
  assert.equal(mutationConfirmation([single], 'comment', job), null);
  for (const input of [{ actor_id: '11' }, { message: { text: 'other' } }, { feedback_id: 'feedback-other-31' }, { parent_comment_id: 'parent_100' }]) {
    const bad = commentRequestProof(commentForm(input), job, ['feedback-original-30']);
    assert.equal(mutationConfirmation([single], 'comment', job, bad), null);
  }
  assert.equal(mutationConfirmation([single], 'comment', job, commentRequestProof(commentForm(), job, [])), null);
  const create = single.data.comment_create;
  const payload = (value: any) => [{ data: { comment_create: value } }];
  assert.equal(mutationConfirmation(payload({ feedback_comment_edges: [create.feedback_comment_edge] }), 'comment', job, proof)?.externalId, 'server_comment_100');
  for (const value of [
    { ...create, feedback: { id: 'other-feedback' } },
    { ...create, comment: { id: 'conflicting_comment_200' } },
    { ...create, comment: { id: 'server_comment_100', author: { id: '11' } } },
    { ...create, comment: { id: 'server_comment_100', body: { text: 'other' } } },
    { ...create, errors: [{ message: 'denied' }] },
    { feedback_comment_edges: {} },
    { feedback_comment_edge: { node: { __typename: 'Story', id: 'server_comment_100' } } },
    { feedback_comment_edge: { node: { id: 'temp:comment_100' } } },
  ]) assert.equal(mutationConfirmation(payload(value), 'comment', job, proof), null);
  assert.equal(mutationConfirmation([{ ...single, errors: [{ message: 'denied' }] }], 'comment', job, proof), null);
  const invalid = commentForm(); invalid.set('variables', '{broken');
  assert.equal(commentRequestProof(invalid, job, []).commentTextAndActorVerified, false);
  const incomplete = commentRequestProof(commentForm({ actor_id: undefined, feedback_id: undefined }), job, []);
  assert.equal(incomplete.commentRequestCompatible, true, 'missing evidence keeps the existing read-back path available');
  assert.equal(incomplete.commentTextAndActorVerified, false);
  assert.equal(incomplete.commentTargetVerified, false);
});
test('an original story or arbitrary HTTP success cannot confirm a new share',()=>{
  assert.equal(mutationConfirmation([{data:{ok:true}}],'share',job),null);
  const story={__typename:'Story',post_id:'40',actors:[{id:'20'}],message:{text:job.plan.share},url:'https://www.facebook.com/permalink.php?story_fbid=40&id=20'};
  assert.equal(mutationConfirmation([{data:{story}}],'share',job),null);
  assert.equal(mutationConfirmation([{data:{story:{...story,actors:[{id:'10'}]}}}],'share',job),null,'a URL owned by someone else cannot identify the new own post');
  assert.equal(mutationConfirmation([{data:{story:{...story,actors:[{id:'10'}],url:'https://www.facebook.com/permalink.php?story_fbid=40&id=10'}}}],'share',job)?.externalId,'40');
  const fragment={...story,id:'story40',actors:[{id:'10'}],message:undefined,url:undefined,
    permalink_url:'https://www.facebook.com/permalink.php?story_fbid=40&id=10',
    comet_sections:{content:{story:{id:'story40',message:{text:job.plan.share}}}}};
  assert.equal(mutationConfirmation([{data:{story_create:{story:fragment}}}],'share',job)?.externalId,'40');
  fragment.comet_sections.content.story.id='another_story';
  assert.equal(mutationConfirmation([{data:{story_create:{story:fragment}}}],'share',job),null);
  assert.equal(safeFacebookUrl('https://example.com/'),undefined);
  assert.equal(safeFacebookUrl('https://www.facebook.com/permalink.php?story_fbid=40&id=10&secret=abc#x'),'https://www.facebook.com/permalink.php?story_fbid=40&id=10');
});

test('share response privacy is accepted only for the created own story bound to the original attachment', () => {
  const story = { __typename: 'Story', post_id: '40', actors: [{ id: '10' }], message: { text: job.plan.share },
    permalink_url: 'https://www.facebook.com/permalink.php?story_fbid=40&id=10',
    attached_story: { post_id: '30', actors: [{ id: '20' }] }, privacy_scope: { type: 'ONLY_ME', label: 'Only me' } };
  const confirm = (value: any) => mutationConfirmation([{ data: { story_create: { story: value } } }], 'share', job);
  assert.deepEqual(confirm(story)?.shareProof, { identityVerified: true, audience: 'only_me' });
  assert.deepEqual(confirm({ ...story, permalink_url: 'https://www.facebook.com/example.account/posts/pfbidCreated40' })?.shareProof,
    { identityVerified: true, audience: 'only_me' });
  assert.deepEqual(confirm({ ...story, privacy_scope: { type: 'PUBLIC' } })?.shareProof, { identityVerified: true, audience: 'public' });
  assert.deepEqual(confirm({ ...story, privacy_scope: undefined })?.shareProof, { identityVerified: true, audience: null });
  assert.deepEqual(confirm({ ...story, privacy_scope: { type: 'CUSTOM', label: 'Only me' } })?.shareProof, { identityVerified: true, audience: null });
  assert.equal(confirm({ ...story, attached_story: { post_id: '31' } })?.shareProof?.identityVerified, false);
  assert.equal(confirm({ ...story, attached_story: { post_id: '30', actors: [{ id: '99' }] } })?.shareProof?.identityVerified, false);
  assert.equal(confirm({ ...story, attached_story: undefined })?.shareProof?.identityVerified, false);
  const attachedOnly = { ...story, privacy_scope: undefined, attached_story: { ...story.attached_story, privacy_scope: story.privacy_scope } };
  assert.equal(confirm(attachedOnly)?.shareProof?.audience, null, 'original privacy is not the new share privacy');
  assert.equal(mutationConfirmation([{ data: { unrelated: story } }], 'share', job)?.shareProof?.identityVerified, false);
  assert.equal(mutationConfirmation([{ data: { story_create: { story } }, errors: [{ message: 'denied' }] }], 'share', job), null);
  const conflicting = { ...story, id: 'story40', comet_sections: { context_layout: { story: { id: 'story40', privacy_scope: { type: 'PUBLIC' } } } } };
  assert.equal(confirm(conflicting)?.shareProof?.audience, null);
  assert.equal(matchesFacebookPostUrl('https://www.facebook.com/me/posts/40?tracking=1', '40', '10'), true);
  assert.equal(matchesFacebookPostUrl('https://www.facebook.com/permalink.php?story_fbid=41&id=10', '40', '10'), false);
});
