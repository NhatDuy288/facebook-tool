import { existsSync, readFileSync } from 'node:fs';

export type ReadTarget = 'test-profile' | 'page';
export type ReadSourceId = string;
export type ReadSource = { name: string; sourceId: string; url: string };
const localPath = new URL('../../../sources.local.json', import.meta.url);
const examplePath = new URL('../../../sources.example.json', import.meta.url);
// Tests always use public fixtures, independently of the operator's local sources.
const localExists = existsSync(localPath);
const path = process.env.NODE_TEST_CONTEXT || !localExists ? examplePath : localPath;
const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
function validateSources(value: unknown): Record<ReadTarget, ReadSource> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('SOURCES_CONFIG_INVALID');
  const result = {} as Record<ReadTarget, ReadSource>;
  for (const key of ['test-profile', 'page'] as const) {
    const source = (value as Record<string, any>)[key];
    if (!source || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 80
      || typeof source.sourceId !== 'string' || !/^[1-9]\d+$/.test(source.sourceId) || typeof source.url !== 'string') throw Error('SOURCES_CONFIG_INVALID');
    const url = new URL(source.url);
    if (url.origin !== 'https://www.facebook.com' || url.username || url.password || url.hash
      || (url.pathname === '/profile.php' ? [...url.searchParams.keys()].some(k => k !== 'id')
        || url.searchParams.getAll('id').length !== 1 || url.searchParams.get('id') !== source.sourceId
        : !/^\/[A-Za-z0-9.]+\/?$/.test(url.pathname) || url.search !== '')
      || key === 'test-profile' && url.pathname !== '/profile.php') throw Error('SOURCES_CONFIG_INVALID');
    result[key] = { name: source.name.trim(), sourceId: source.sourceId, url: url.href };
  }
  return result;
}
export const READ_TARGETS = validateSources(raw);
export function assertSourcesConfigured() {
  if (!localExists) throw Error('Create sources.local.json from sources.example.json and configure your own source IDs/URLs before starting.');
}
export function assertTargetConfigured(target: ReadTarget) {
  if (['123456789','987654321'].includes(READ_TARGETS[target].sourceId)) throw Error('SOURCE_NOT_CONFIGURED');
}
export function matchesReadTargetUrl(value: string, target: ReadTarget): boolean {
  try {
    const u = new URL(value), expected = new URL(READ_TARGETS[target].url);
    const profile = expected.pathname === '/profile.php';
    if (u.origin !== expected.origin || u.username || u.password || u.hash
      || (profile ? u.pathname !== expected.pathname : u.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, ''))
      || [...u.searchParams.keys()].some(key => !['locale', ...(profile ? ['id'] : [])].includes(key))) return false;
    if (profile && (u.searchParams.getAll('id').length !== 1 || u.searchParams.get('id') !== READ_TARGETS[target].sourceId)) return false;
    const locales = u.searchParams.getAll('locale');
    return locales.length <= 1 && (!locales.length || /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8}){0,3}$/.test(locales[0]));
  } catch { return false; }
}
export function renderSourceOptions(): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll("'",'&#39;');
  return Object.entries(READ_TARGETS).map(([key, source]) => `<option value="${key}" data-url="${escape(source.url)}">${escape(source.name)}</option>`).join('');
}
