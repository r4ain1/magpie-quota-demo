import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clean, collectPublicFeed, date, guides, publicUrl } from './public-sources.mjs';

const topic = /(?:^|[^a-z0-9])(?:chat\s*gpt|codex|open\s*ai)(?![a-z0-9])/i;
const sources = [
  { key: 'news', section: 'news', label: 'AIHOT 热点' },
  { key: 'resets', section: 'resets', label: 'AIHOT 重置监测' },
  ...guides.map(({ key, url }) => ({ key, url, section: 'guides', label: 'Oil Book' })),
];

export async function dashboardNews(previous = {}, options = {}) {
  const feed = await collectPublicFeed({}, options);
  const lastCheck = date(previous?.checkedAt) ?? null;
  const result = { checkedAt: lastCheck, news: [], resets: [], guides: [] };
  let verified = false;
  let failed = false;
  for (const { key, section, url, label } of sources) {
    const fresh = Boolean(feed.sources[key].lastSuccessAt);
    verified ||= fresh;
    failed ||= !fresh;
    const rows = fresh ? feed[section] : lastCheck && previous[section];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const title = clean(row?.title);
      const link = publicUrl(row?.url, section);
      if (!title || !link || (url ? link !== url : !topic.test(title))) continue;
      result[section].push({ title, url: link, source: label, at: date(row.at) });
    }
  }
  if (verified && (!failed || !lastCheck)) result.checkedAt = feed.checkedAt;
  return result;
}

export async function writeDashboardNews(path, options) {
  if (basename(path) !== 'dashboard-news.json') throw new Error('输出文件名须为 dashboard-news.json');
  let previous;
  try {
    previous = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = await dashboardNews(previous, options);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (import.meta.main) {
  const path = process.argv[2] ?? fileURLToPath(new URL('../brief/dashboard-news.json', import.meta.url));
  if (process.argv.length > 3) throw new Error('用法：node scripts/dashboard-news.mjs [输出路径]');
  await writeDashboardNews(path);
}
