// Loopback HTTP fixture: real Chromium cache/network, no routing mocks or Facebook calls.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function loadingFixture() {
  const hits = new Map<string, number>();
  let mediaRequired = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1);
    const send = (body: string | Buffer, type: string, cache = false) => {
      response.writeHead(200, { 'Content-Type': type + (type.startsWith('text/') ? '; charset=utf-8' : ''), 'Cache-Control': cache ? 'public, max-age=86400' : 'no-store' }); response.end(body);
    };
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) run(); }, ms); timers.add(timer);
    };
    if (url.pathname === '/critical.js') return send(`globalThis.require=n=>n==='CurrentUserInitialData'?{USER_ID:'10',ACCOUNT_ID:'10'}:n==='getAsyncParams'?()=>({__user:'10'}):null`, 'text/javascript', true);
    if (url.pathname === '/styles.css') return send('body{font:16px sans-serif}button{min-width:60px}', 'text/css', true);
    if (url.pathname === '/icon.svg') return send('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>', 'image/svg+xml', true);
    if (url.pathname === '/unrelated.js') return later(650, () => send('globalThis.unrelatedLoaded=true', 'text/javascript'));
    if (url.pathname === '/photo.svg') return later(60, () => send('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/><!--' + 'x'.repeat(1_000_000) + '--></svg>', 'image/svg+xml'));
    if (url.pathname === '/video.bin') return later(60, () => send(Buffer.alloc(1_000_000), 'application/octet-stream'));
    if (url.pathname === '/write') return send('{}', 'application/json');
    const actor = url.searchParams.get('actor') || '10', owner = url.searchParams.get('owner') || '20';
    const ready = Number(url.searchParams.get('ready') || 0);
    const controls = '<div role="dialog"><h1>Bài viết của Fixture</h1><div><button>Like</button><button>Comment</button><button>Share</button></div><a href="/post?story_fbid=30">Time</a><span aria-label="Only me"></span></div>';
    send(`<!doctype html><link rel="stylesheet" href="/styles.css"><script src="/critical.js"></script>
      ${actor === '10' ? '' : `<script>globalThis.require=n=>n==='CurrentUserInitialData'?{USER_ID:'${actor}',ACCOUNT_ID:'${actor}'}:n==='getAsyncParams'?()=>({__user:'${actor}'}):null</script>`}
      <script type="application/json">{"__typename":"Story","post_id":"30","actors":[{"id":"${owner}"}],"feedback":{"id":"feedback-30","owning_profile":{"id":"${owner}"}}}</script>
      <img src="/icon.svg"><img src="/photo.svg"><script>fetch('/video.bin').then(r=>r.arrayBuffer()).catch(()=>{});</script>
      <div id="root">${ready || mediaRequired ? '' : controls}</div>
      <script>${mediaRequired ? `fetch('/photo.svg').then(r=>r.text()).then(()=>root.innerHTML=${JSON.stringify(controls)}).catch(()=>{})` : ready ? `setTimeout(()=>root.innerHTML=${JSON.stringify(controls)},${ready})` : ''}</script>
      <script defer src="/unrelated.js"></script>`, 'text/html');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, hits, blockedUrls: [origin + '/photo.svg', origin + '/video.bin'],
    requireMedia(value: boolean) { mediaRequired = value; },
    async close() { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
