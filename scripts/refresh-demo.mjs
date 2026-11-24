import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { collectPublicFeed } from './public-sources.mjs';

async function refresh(path) {
  let previous = {};
  let exists = false;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('需要普通文件');
    previous = JSON.parse(await readFile(path, 'utf8'));
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const feed = await collectPublicFeed(previous);
  await writeFile(path, `${JSON.stringify(feed, null, 2)}\n`, { flag: exists ? 'w' : 'wx' });
  for (const warning of feed.errors) console.warn(warning);
}

const args = process.argv.slice(2);
if (args.length !== 1 || basename(args[0]) !== 'feed.json') {
  console.error('用法：node scripts/refresh-demo.mjs <feed.json 路径>');
  process.exitCode = 2;
} else {
  try { await refresh(args[0]); } catch {
    console.error('公开资讯刷新失败，请检查 feed.json 的格式和读写权限。');
    process.exitCode = 1;
  }
}
