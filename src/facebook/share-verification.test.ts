import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { currentPageShareAudience } from './share-verification.ts';

const url = 'https://www.facebook.com/permalink.php?story_fbid=40&id=10';
const stamp = `<a href="${url}"><time datetime="2026-11-09T10:00:00Z">Just now</time></a>`;
const label = (text: string) => `<span aria-label="${text}">Privacy</span>`;
const card = (header: string, body = '') => `<div role="article"><div>${header}</div>${body}</div>`;

test('current-page share proof cannot borrow privacy from a composer, toast, attachment or another post', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const cases: [string, 'only_me' | 'public' | null][] = [
      [card(stamp + label('Only me')), 'only_me'],
      [card(stamp + label('Public'), card('<a href="https://www.facebook.com/source/posts/30">Original</a>' + label('Only me'))), 'public'],
      [`<div role="dialog"><h1>Share</h1><div role="textbox" contenteditable="true"></div>${stamp}${label('Only me')}</div>`, null],
      [`<div role="status">${stamp}${label('Only me')}</div>`, null],
      [card(stamp + label('Only me') + label('Public')), null],
      [card(stamp + label('Friends') + label('Public')), null],
      [card(stamp.replace('story_fbid=40', 'story_fbid=140') + label('Only me')), null],
      [card(stamp.replace('id=10', 'id=99') + label('Only me')), null],
      [card(`<a href="${url}">Link in the caption</a>` + label('Only me')), null],
      [`<div style="display:none">${card(stamp + label('Only me'))}</div>`, null],
      [card(stamp, card('<a href="https://www.facebook.com/source/posts/30">Original</a>' + label('Only me'))), null],
      [card(stamp, '<div><a href="https://www.facebook.com/source/posts/pfbidOriginal">Original</a>' + label('Only me') + '</div>'), null],
    ];
    for (const [html, expected] of cases) {
      await page.setContent(html);
      assert.equal(await currentPageShareAudience(page, '40', '10', url), expected, html);
    }
    const opaque = 'https://www.facebook.com/example.account/posts/pfbidCreated40';
    await page.setContent(card(stamp.replace(url, opaque) + label('Only me')));
    assert.equal(await currentPageShareAudience(page, '40', '10', opaque), 'only_me');
    assert.equal(await currentPageShareAudience(page, '40', '10', opaque + 'Other'), null);
  } finally { await browser.close(); }
});
