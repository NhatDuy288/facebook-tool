import test from 'node:test';
import assert from 'node:assert/strict';
import { mutationConfirmation, mutationActorAllowed, safeFacebookUrl } from './confirmation.ts';
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
test('comment confirmations require a server comment with exact actor and assigned text',()=>{
  const comment={__typename:'Comment',id:'comment_100',author:{id:'10'},body:{text:'test 1'}};
  assert.equal(mutationConfirmation([{data:{comment_create:{comment}}}],'comment',job)?.externalId,'comment_100');
  assert.equal(mutationConfirmation([{data:{comment:{...comment,author:{id:'11'}}}}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment:{...comment,body:{text:'test 2'}}}}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment},errors:[{message:'denied'}]}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment:{...comment,id:'client:100'}}}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment_create:{comment:{id:'server_comment_100'}}}}],'comment',job),null);
  assert.equal(mutationConfirmation([{data:{comment_create:{comment:{id:'server_comment_100'}}}}],'comment',job,{commentTextAndActorVerified:true})?.externalId,'server_comment_100');
});
test('an original story or arbitrary HTTP success cannot confirm a new share',()=>{
  assert.equal(mutationConfirmation([{data:{ok:true}}],'share',job),null);
  const story={__typename:'Story',post_id:'40',actors:[{id:'20'}],message:{text:job.plan.share},url:'https://www.facebook.com/permalink.php?story_fbid=40&id=20'};
  assert.equal(mutationConfirmation([{data:{story}}],'share',job),null);
  assert.equal(mutationConfirmation([{data:{story:{...story,actors:[{id:'10'}]}}}],'share',job)?.externalId,'40');
  const fragment={...story,id:'story40',actors:[{id:'10'}],message:undefined,url:undefined,
    permalink_url:'https://www.facebook.com/permalink.php?story_fbid=40&id=10',
    comet_sections:{content:{story:{id:'story40',message:{text:job.plan.share}}}}};
  assert.equal(mutationConfirmation([{data:{story_create:{story:fragment}}}],'share',job)?.externalId,'40');
  fragment.comet_sections.content.story.id='another_story';
  assert.equal(mutationConfirmation([{data:{story_create:{story:fragment}}}],'share',job),null);
  assert.equal(safeFacebookUrl('https://example.com/'),undefined);
  assert.equal(safeFacebookUrl('https://www.facebook.com/permalink.php?story_fbid=40&id=10&secret=abc#x'),'https://www.facebook.com/permalink.php?story_fbid=40&id=10');
});
