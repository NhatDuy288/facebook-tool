// Export local diagnostics only. Control keys are never printed or saved.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const dataDir = new URL('../data/', import.meta.url);
let runtime = null;
try { runtime = JSON.parse(await readFile(new URL('runtime.json', dataDir), 'utf8')); } catch {}
let evidence;
if (runtime?.running && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(runtime.url)) {
  const response = await fetch(runtime.url), html = await response.text();
  const key = html.match(/window\.toolKey="([a-f0-9]{48})"/)?.[1];
  if (!response.ok || !key) throw Error('CONTROL_PAGE_UNAVAILABLE');
  const history = await fetch(new URL('api/scan-history', runtime.url), { headers: { 'X-Tool-Key': key } });
  if (!history.ok) throw Error('SCAN_HISTORY_UNAVAILABLE: restart the updated tool first');
  evidence = await history.json();
} else {
  const db = new DatabaseSync(fileURLToPath(new URL('tool.sqlite', dataDir)), { readOnly: true });
  try {
    evidence = { recent: null, saved: db.prepare('SELECT id,at,trigger,job_id,details_json FROM scan_snapshots ORDER BY id DESC LIMIT 5').all()
      .map(row => ({ id: row.id, at: row.at, trigger: row.trigger, jobId: row.job_id, snapshot: JSON.parse(row.details_json) })) };
  } finally { db.close(); }
}
await mkdir(dataDir, { recursive: true });
const output = new URL('scan-history-' + new Date().toISOString().replaceAll(':', '-') + '.json', dataDir);
await writeFile(output, JSON.stringify(evidence, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ file: fileURLToPath(output), recentReads: evidence.recent?.reads.length ?? 0, savedSnapshots: evidence.saved.length }));
