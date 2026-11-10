// Controlled read-only loopback benchmark. It never opens Facebook or sends interactions.
import { chromium } from 'playwright-core';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadingFixture } from '../src/facebook/post-loading.fixture.ts';
import { PostLoader } from '../src/facebook/post-loading.ts';

const fixture = await loadingFixture(), browser = await chromium.launch({ channel: 'chrome', headless: true });
const rows: any[] = [];
const variants = [
  { name: 'baseline', blockMedia: false, fastReady: false },
  { name: 'media_only', blockMedia: true, fastReady: false },
  { name: 'ready_only', blockMedia: false, fastReady: true },
  { name: 'media_and_ready', blockMedia: true, fastReady: true },
];
try {
  const context = await browser.newContext();
  const warmup = await context.newPage(); await warmup.goto(fixture.origin + '/post', { waitUntil: 'load' }); await warmup.close();
  for (let round = 0; round < 6; round++) for (let index = 0; index < variants.length; index++) {
    const variant = variants[(index + round) % variants.length], page = await context.newPage();
    const loader = new PostLoader({ ...variant, blockedUrls: fixture.blockedUrls });
    await loader.prepare(page);
    const start = performance.now();
    await loader.load(page, fixture.origin + '/post?round=' + round, { postId: '30', sourceId: '20', actorId: '10', need: 'actions', origin: fixture.origin });
    const readyMs = performance.now() - start;
    // Same semantic milestone for every variant: the required Like button is usable.
    await page.getByRole('button', { name: 'Like', exact: true }).click({ trial: true });
    const usableMs = performance.now() - start;
    rows.push({ variant: variant.name, round, readyMs, usableMs, ...loader.diagnostics(page) as object });
    await page.close();
  }
  const median = (values: number[]) => { values.sort((a, b) => a - b); return (values[2] + values[3]) / 2; };
  const summary = variants.map(v => {
    const records = rows.filter(r => r.variant === v.name);
    return { variant: v.name, samples: records.length, medianUsableMs: median(records.map(r => r.usableMs)), medianBytes: median(records.map(r => r.bytes)),
      minCacheHits: Math.min(...records.map(r => r.cacheHits)), fallbacks: records.filter(r => r.fallback).length };
  });
  await mkdir('data', { recursive: true });
  await writeFile('data/loading-local-benchmark.json', JSON.stringify({ fixture: 'loopback, warm cache, 650ms unrelated deferred script, 2MB content media', rows, summary, serverRequests: Object.fromEntries(fixture.hits) }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); await fixture.close(); }
