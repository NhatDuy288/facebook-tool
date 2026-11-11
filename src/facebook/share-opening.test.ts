import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { openShareComposer } from './share-opening.ts';

const composer=`<div role="dialog" id="composer" hidden><button>Your Feed</button><span>Test</span><button>Only me</button>
  <div role="textbox" contenteditable="true" aria-label="A changed Facebook editor label"></div>
  <button onclick="globalThis.published++">Post</button><div role="dialog" hidden>Hidden child</div></div>`;
const fixture=(onclick:string,extra='')=>`<main><div id="bar"><button onclick="${onclick}">Share</button></div></main>${composer}${extra}<script>globalThis.published=0;</script>`;

test('Share opens an actual Feed menu immediately, without waiting the old four-second composer timeout',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{const page=await browser.newPage();
    await page.setContent(fixture("document.querySelector('#menu').hidden=false;globalThis.menuAt=performance.now()",
      `<div role="menu" id="menu" hidden><button role="menuitem" onclick="globalThis.menuDelay=performance.now()-globalThis.menuAt;this.parentElement.hidden=true;document.querySelector('#composer').hidden=false">Share to Feed</button><button onclick="globalThis.published++">Share now</button></div>`));
    const stages:string[]=[];
    const dialog=await openShareComposer(page,page.locator('#bar'),{signal:new AbortController().signal,stage:s=>stages.push(s)});
    assert.equal(await dialog.count(),1);assert.ok(stages.includes('share_open_click_feed'));
    assert.ok(await page.evaluate(()=> (globalThis as any).menuDelay)<1000,'visible menu should be selected without the old serial 4-second wait');
    assert.equal(await page.evaluate(()=> (globalThis as any).published),0);
  }finally{await browser.close();}
});

test('Feed-bound composer supports a changed textbox name and delayed editor, excluding hidden nested dialogs',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{const page=await browser.newPage();
    await page.setContent(fixture("document.querySelector('#composer').hidden=false;document.querySelector('[role=textbox]').hidden=true;setTimeout(()=>document.querySelector('[role=textbox]').hidden=false,150)"));
    const dialog=await openShareComposer(page,page.locator('#bar'),{signal:new AbortController().signal});
    assert.equal(await dialog.locator('[role=textbox]').isVisible(),true);
    assert.equal(await page.evaluate(()=> (globalThis as any).published),0);
  }finally{await browser.close();}
});

test('Share refuses pre-existing or ambiguous surfaces, and cancellation never clicks publish',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{let page=await browser.newPage();
    await page.setContent(fixture("globalThis.clicked=true"));await page.locator('#composer').evaluate(n=>(n as HTMLElement).hidden=false);
    await assert.rejects(openShareComposer(page,page.locator('#bar'),{signal:new AbortController().signal}),/UI_UNSUPPORTED/);
    assert.equal(await page.evaluate(()=>!!(globalThis as any).clicked),false);
    await page.setContent(fixture("document.querySelector('#composer').hidden=false",composer.replaceAll('id="composer"','id="other"')));
    await page.locator('#other').evaluate(n=>(n as HTMLElement).hidden=false);
    // A second pre-existing composer is rejected as well; no Share click adopts it.
    await assert.rejects(openShareComposer(page,page.locator('#bar'),{signal:new AbortController().signal}),/UI_UNSUPPORTED/);
    await page.setContent(fixture("document.querySelector('#composer').hidden=false;document.querySelector('#other').hidden=false",composer.replaceAll('id="composer"','id="other"')));
    await assert.rejects(openShareComposer(page,page.locator('#bar'),{signal:new AbortController().signal}),/UI_UNSUPPORTED/);
    assert.equal(await page.evaluate(()=> (globalThis as any).published),0);
    await page.close();page=await browser.newPage();
    await page.setContent(fixture("document.querySelector('#menu').hidden=false",'<div role="menu" id="menu" hidden><button onclick="globalThis.published++">Share now</button></div>'));
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),200);
    await assert.rejects(openShareComposer(page,page.locator('#bar'),{signal:controller.signal}));clearTimeout(timer);
    assert.equal(page.isClosed(),true);
  }finally{await browser.close();}
});
