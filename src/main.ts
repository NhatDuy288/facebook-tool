import { createServer } from 'node:http';
import { createServer as createLockServer, type AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Store } from './store.ts';
import { Engine } from './engine.ts';
import { BrowserSession, activeAccount } from './facebook/browser.ts';
import { FacebookReader } from './facebook/reader.ts';
import { FacebookActions } from './facebook/actions.ts';
import { errorCode, message } from './errors.ts';
import { ACTIONS } from './config.ts';
import { READ_TARGETS, assertSourcesConfigured, renderSourceOptions } from './facebook/feed/read-target.ts';
assertSourcesConfigured();

const root = fileURLToPath(new URL('../', import.meta.url)), dataDir = join(root, 'data');
await mkdir(dataDir, { recursive: true });
const lockPath = join(dataDir, 'app.lock');
// The OS releases this exclusive loopback listener after a crash. A stale/partial PID file
// must never prevent recovery or let a second process reset an active job's SQLite state.
const instanceGuard = createLockServer(socket => socket.destroy());
try {
  await new Promise<void>((resolve, reject) => { instanceGuard.once('error', reject); instanceGuard.listen(32144, '127.0.0.1', resolve); });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    let url = ''; try { url = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')).url || ''; } catch {}
    console.log('Tool đã chạy hoặc cổng khóa cục bộ đang được dùng. ' + url); process.exit(0);
  }
  console.error('Không mở được khóa tiến trình của tool.'); process.exit(1);
}
await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
const store = new Store(join(dataDir, 'tool.sqlite'));
const browser = new BrowserSession(), reader = new FacebookReader(browser), adapter = new FacebookActions(browser);
const engine = new Engine(store, reader, adapter);
const key = randomBytes(24).toString('hex'); let origin = '', closing = false;
const assets: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const server = createServer(async (request, response) => {
  const reply = (status: number, value: unknown, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${key}'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` });
    response.end(typeof value === 'string' ? value : JSON.stringify(value));
  };
  if (!origin || request.headers.host !== new URL(origin).host) { reply(403, {}); return; }
  if (request.method === 'GET' && assets[request.url || '']) {
    const asset = assets[request.url!];
    let body = await readFile(join(root, 'public', asset.file), 'utf8');
    if (request.url === '/') body = body.replaceAll('__TOOL_NONCE__', key).replaceAll('__SOURCE_OPTIONS__', renderSourceOptions());
    reply(200, body, asset.type); return;
  }
  if (request.headers['x-tool-key'] !== key) { reply(403, {}); return; }
  if (closing) { reply(200, { closing: true, phase: 'stopping' }); return; }
  if (request.method === 'GET' && request.url === '/api/status') {
    reply(200, { ...engine.status(), sources: READ_TARGETS, browser: { channel: browser.channel, sessionSaved: store.config().keepSession }, closing }); return;
  }
  if (request.method !== 'POST' || request.headers.origin !== origin || closing) { reply(403, {}); return; }
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 512 * 1024) throw Error('CONFIG_INVALID'); chunks.push(buffer); }
    let input: any;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Error('CONFIG_INVALID'); }
    if (request.url === '/api/config') {
      const config = engine.saveConfig(input); reply(200, { config }); return;
    }
    if (request.url !== '/api/command') { reply(404, {}); return; }
    switch (input.action) {
      case 'account': reply(200, { account: await activeAccount(await browser.sourcePage()) }); return;
      case 'login': await engine.openLogin(); break;
      case 'baseline': engine.baseline(); break;
      case 'start': engine.start(); break;
      case 'stop': void engine.stop(); break;
      case 'shutdown': reply(202, {}); void shutdown(); return;
      case 'test_existing': engine.testExisting(String(input.postId || '')); break;
      case 'resume': engine.resume(String(input.jobId || '')); break;
      case 'reconcile':
        if (!ACTIONS.includes(input.name)) throw Error('CONFIG_INVALID');
        reply(200, await engine.reconcile(String(input.jobId || ''), input.name)); return;
      case 'resolve':
        if (!ACTIONS.includes(input.name) || !['done', 'not_sent'].includes(input.result)) throw Error('CONFIG_INVALID');
        if (engine.busy()) throw Error('BUSY');
        store.resolve(String(input.jobId || ''), input.name, input.result); break;
      // Development inspection is read-only, fixed to our own worker tabs. No arbitrary URL or script endpoint.
      case 'diagnostics': reply(200, await adapter.diagnostics()); return;
      default: reply(400, {}); return;
    }
    reply(202, {});
  } catch (error) {
    const code = errorCode(error);
    if (!response.headersSent) reply(400, { code, message: message(code) });
  }
});
async function shutdown() {
  if (closing) return; closing = true;
  await engine.close().catch(() => {});
  await browser.close();
  await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ running: false, stoppedAt: new Date().toISOString() }));
  server.close(); clearInterval(maintenance); store.close(); await unlink(lockPath).catch(() => {}); instanceGuard.close();
}
const maintenance = setInterval(() => store.pruneLogs(), 24 * 60 * 60_000); maintenance.unref();
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await browser.launch(store.config(), join(dataDir, 'browser-profile'), origin + '/');
  await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ running: true, pid: process.pid, url: origin + '/', startedAt: new Date().toISOString() }));
  store.log('info', 'APP_STARTED', 'Tool đã mở trên laptop. Phiên theo dõi chỉ bắt đầu khi bấm Bắt đầu.');
  browser.context.on('close', () => { void shutdown(); });
  console.log('Facebook Laptop Tool: ' + origin + '/');
  console.log('Giữ cửa sổ này để tool hoạt động. Đóng bằng nút Đóng tool trên giao diện.');
} catch (error) {
  console.error(message(errorCode(error))); await shutdown(); process.exitCode = 1;
}
