import type { Locator, Page } from 'playwright-core';
import type { ActionStage } from '../types.ts';

const SHARE = /^(Chia sẻ|Share|Chia sẻ bài viết của .+|Share .+['’]s post)$/i;
export const FEED_HEADER = /^(Chia sẻ lên Bảng feed(?: \(Chỉ đọc\))?|Share to (?:your )?Feed(?: \(Read.only\))?|Your Feed|Bảng feed)$/i;
const FEED_MENU = /^(Chia sẻ lên (?:Bảng feed|bảng tin|trang cá nhân)|Viết bài|Share to (?:Feed|your timeline)|Write post)$/i;
export type ShareOpeningShape = { kind: 'none' | 'composer' | 'menu' | 'ambiguous'; dialogs: number; editors: number; feedOptions: number };
export type ShareOpeningHooks = { signal: AbortSignal; stage?: (stage: ActionStage) => void; diagnostic?: (shape: ShareOpeningShape) => void };

// Serialized into the page: one DOM pass per poll, no DOM writes or text/content
// logging. Only a Feed-bound leaf dialog or an explicit open-composer menu item
// qualifies. "Share now" and publish controls are never clicked here.
export function shareOpeningProbe(mode: 'inspect' | 'surface' | 'editor'): ShareOpeningShape | false {
  const visible = (node: Element) => { const b=node.getBoundingClientRect(),s=getComputedStyle(node);
    return b.width>0&&b.height>0&&s.visibility!=='hidden'&&s.display!=='none'; };
  const name = (node: Element) => (node.getAttribute('aria-label') || (node as HTMLElement).innerText || '').trim();
  const header = /^(Chia sẻ lên Bảng feed(?: \(Chỉ đọc\))?|Share to (?:your )?Feed(?: \(Read.only\))?|Your Feed|Bảng feed)$/i;
  const menu = /^(Chia sẻ lên (?:Bảng feed|bảng tin|trang cá nhân)|Viết bài|Share to (?:Feed|your timeline)|Write post)$/i;
  const leafDialogs=[...document.querySelectorAll('[role="dialog"]')].filter(d=>visible(d)
    && ![...d.querySelectorAll('[role="dialog"]')].some(visible));
  const composers=leafDialogs.filter(d=>[...d.querySelectorAll('[role="button"],button')].some(b=>visible(b)&&header.test(name(b))));
  const editors=composers.flatMap(d=>[...d.querySelectorAll('[role="textbox"][contenteditable="true"]')].filter(visible));
  const choices=[...document.querySelectorAll('[role="menuitem"],[role="menu"] [role="button"],[role="menu"] button')]
    .filter(b=>visible(b)&&menu.test(name(b)));
  const ambiguous=composers.length>1||editors.length>1||choices.length>1||!!composers.length&&!!choices.length;
  const shape: ShareOpeningShape={kind:ambiguous?'ambiguous':composers.length?'composer':choices.length?'menu':'none',dialogs:composers.length,editors:editors.length,feedOptions:choices.length};
  if(mode==='surface'&&shape.kind==='none')return false;
  if(mode==='editor'&&shape.kind!=='ambiguous'&&!(shape.kind==='composer'&&shape.editors===1))return false;
  return shape;
}

function composers(page: Page): Locator {
  return page.locator('[role="dialog"]').filter({visible:true})
    .filter({hasNot:page.locator('[role="dialog"]').filter({visible:true})})
    .filter({has:page.getByRole('button',{name:FEED_HEADER})});
}

export async function openShareComposer(page: Page, bar: Locator, hooks: ShareOpeningHooks): Promise<Locator> {
  const {signal,stage,diagnostic}=hooks;
  const abort=()=>{void page.close().catch(()=>{});};
  signal.throwIfAborted();signal.addEventListener('abort',abort,{once:true});
  try {
    const before=await page.evaluate(shareOpeningProbe,'inspect' as const) as ShareOpeningShape;
    if(before.kind!=='none')throw Error('UI_UNSUPPORTED');
    stage?.('share_open_find_button');
    const button=bar.getByRole('button',{name:SHARE}).filter({visible:true});
    if(await button.count()!==1)throw Error('UI_UNSUPPORTED');
    stage?.('share_open_click_button');
    await button.click({timeout:8000});signal.throwIfAborted();
    stage?.('share_open_wait_surface');
    // The old path allowed 4 s for the dialog and then 2.5 s for its menu.
    // Preserve that total first-surface budget without paying 4 s before a menu.
    let state=await waitSurface(page,6500);diagnostic?.(state);
    if(state.kind==='ambiguous')throw Error('UI_UNSUPPORTED');
    if(state.kind==='menu') {
      stage?.('share_open_click_feed');
      const menu=page.getByRole('menuitem',{name:FEED_MENU})
        .or(page.getByRole('menu').getByRole('button',{name:FEED_MENU})).filter({visible:true});
      if(await menu.count()!==1)throw Error('UI_UNSUPPORTED');
      await menu.click({timeout:6000});signal.throwIfAborted();
    }
    stage?.('share_open_wait_editor');
    const ready=await page.waitForFunction(shareOpeningProbe,'editor' as const,{polling:50,timeout:6000});
    state=await ready.jsonValue() as ShareOpeningShape;await ready.dispose();diagnostic?.(state);
    if(state.kind!=='composer'||state.editors!==1)throw Error('UI_UNSUPPORTED');
    const dialog=composers(page),editors=dialog.locator('[role="textbox"][contenteditable="true"]').filter({visible:true});
    if(await dialog.count()!==1||await editors.count()!==1)throw Error('UI_UNSUPPORTED');
    return dialog;
  }catch(error){
    signal.throwIfAborted();
    if(!page.isClosed())await page.evaluate(shareOpeningProbe,'inspect' as const).then(shape=>shape&&diagnostic?.(shape)).catch(()=>{});
    throw error;
  }finally{signal.removeEventListener('abort',abort);}
}

async function waitSurface(page: Page, timeout: number): Promise<ShareOpeningShape> {
  // Explicit polling also works while Chromium's window is minimized.
  const ready=await page.waitForFunction(shareOpeningProbe,'surface' as const,{polling:50,timeout});
  const state=await ready.jsonValue() as ShareOpeningShape;await ready.dispose();return state;
}
