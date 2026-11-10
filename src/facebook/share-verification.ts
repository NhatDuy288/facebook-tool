import type { Page } from 'playwright-core';

// One read-only DOM probe, without navigation or waiting for another Facebook response.
// Called only after the mutation has proved the new Story's author, content and original attachment.
export async function currentPageShareAudience(page: Page, postId: string, accountId: string, permalink: string): Promise<'only_me' | 'public' | null> {
  return page.evaluate(expected => {
    const visible = (node: Element) => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const clean = (value: string): string | null => {
      try {
        const url = new URL(value, location.href);
        if (url.origin !== 'https://www.facebook.com' || url.username || url.password) return null;
        for (const key of [...url.searchParams.keys()]) if (!['id', 'story_fbid'].includes(key)) url.searchParams.delete(key);
        url.hash = ''; return url.href;
      } catch { return null; }
    };
    const canonical = clean(expected.permalink);
    const postIdentity = (value: string): string | null => {
      try {
        const url = new URL(value, location.href);
        if (url.origin !== 'https://www.facebook.com' || url.username || url.password) return null;
        if (canonical && clean(value) === canonical) return expected.postId;
        const queryId = url.searchParams.get('story_fbid');
        if (queryId && /^(\d+|pfbid[A-Za-z0-9]+)$/.test(queryId)) return queryId;
        return url.pathname.match(/^\/[^/]+\/posts\/([^/]+)\/?$/)?.[1] || null;
      } catch { return null; }
    };
    const ownLink = (value: string) => {
      try {
        const url = new URL(value, location.href);
        return postIdentity(value) === expected.postId && (!url.searchParams.has('id') || url.searchParams.get('id') === expected.accountId);
      } catch { return false; }
    };
    const timestamp = (link: HTMLAnchorElement) => !!link.querySelector('time[datetime],abbr[data-utime]')
      || /^(?:Just now|Vừa xong|\d+\s*(?:seconds?|minutes?|hours?|days?|giây|phút|giờ|ngày)(?:\s+ago)?|\d{1,2}:\d{2}(?::\d{2})?)$/i.test(link.getAttribute('aria-label')?.trim() || '');
    const audiences = new Set<'only_me' | 'public'>();
    let otherAudience = false;
    const deadline = performance.now() + 25; let visited = 0;
    // A toast, the composer or the attached original is never a published-card header.
    for (const root of document.querySelectorAll('[role="article"],[role="dialog"]')) {
      if (++visited > 250 || performance.now() > deadline) return null;
      if (!visible(root) || root.querySelector('[contenteditable="true"][role="textbox"]')) continue;
      if (root.matches('[role="dialog"]') && !root.querySelector('[role="heading"],h1,h2')) continue;
      for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (!visible(link) || !ownLink(link.href) || !timestamp(link)) continue;
        let header: Element | null = link;
        for (let depth = 0; header && header !== root && depth < 5 && root.contains(header); depth++, header = header.parentElement) {
          const links = [...header.querySelectorAll<HTMLAnchorElement>('a[href]')];
          if (links.some(a => { const id = postIdentity(a.href); return id !== null && id !== expected.postId; })) break;
          if (header.querySelector('[role="article"]') || header.querySelector('[contenteditable="true"]')) break;
          for (const node of header.querySelectorAll('[aria-label],[title]')) {
            if (!visible(node)) continue;
            for (const value of [node.getAttribute('aria-label'), node.getAttribute('title')]) {
              const label = (value || '').trim().replace(/^(?:Shared with|Đã chia sẻ với)\s*:?\s*/i, '');
              if (/^(Only me|Chỉ mình tôi)$/i.test(label)) audiences.add('only_me');
              if (/^(Public|Công khai)$/i.test(label)) audiences.add('public');
              if (/^(Friends|Bạn bè|Custom|Tùy chỉnh)(?:$|\s)/i.test(label)) otherAudience = true;
            }
          }
        }
      }
    }
    return !otherAudience && audiences.size === 1 ? [...audiences][0] : null;
  }, { postId, accountId, permalink });
}
