import { applyAction, dayInShanghai } from './model.mjs';

export const storageKey = 'magpie.quota.demo.v1';
const hour = 3600000;

function sample(now) {
  const stamp = offset => new Date(now + offset * hour).toISOString();
  const window = (name, remaining, capacity, offset) => ({ name, remaining, capacity, resetAt: stamp(offset) });
  return {
    seats: [
      { id: 'demo-codex', label: 'Codex 主账户', service: 'Codex', unit: '%', source: 'magpie',
        observedAt: stamp(-0.04), windows: [window('5 小时窗口', 76, 100, 3.5), window('每周窗口', 89, 100, 90)] },
      { id: 'demo-chat', label: 'ChatGPT 团队账户', service: 'ChatGPT', unit: '次', source: 'manual',
        observedAt: stamp(-0.35), windows: [window('日窗口', 64, 80, 12), window('每周窗口', 216, 240, 84)] },
      { id: 'demo-reserve', label: 'Codex 备用账户', service: 'Codex', unit: '%', source: 'manual',
        observedAt: stamp(-0.5), windows: [window('5 小时窗口', 42, 100, 2)] }
    ],
    entries: [], feed: { news: [], resets: [], guides: [], checkedAt: null }
  };
}

export function readDemo() {
  const saved = localStorage.getItem(storageKey);
  if (saved === null) return sample(Date.now());
  const state = JSON.parse(saved);
  if (!Array.isArray(state?.seats) || !Array.isArray(state?.entries)) throw Error('本地演示数据无法读取。');
  return state;
}

export function demoFeed(feed, seats) {
  const sampleAt = seats.find(seat => seat.id === 'demo-codex')?.observedAt;
  if (!Number.isFinite(Date.parse(sampleAt))) return feed;
  const magpie = {
    status:'ok', lastSuccessAt:sampleAt,
    hostUsage:{scope:'host', status:'ok', date:dayInShanghai(sampleAt), collectedAt:sampleAt, tokens:18420, requests:12},
    auxiliaryPools:[{id:'demo-token-pool', label:'示例额度池', service:'WorkBuddy', unit:'tokens', source:'magpie', observedAt:sampleAt,
      windows:[{name:'赠送 tokens', remaining:72000, capacity:100000, resetAt:null}]}],
  };
  return { ...feed, sources:{...feed.sources, magpie} };
}

export async function saveDemoAction(action, current) {
  const write = () => {
    const state = localStorage.getItem(storageKey) === null ? current : readDemo();
    const next = applyAction(state, action, new Date().toISOString(), '演示用户');
    localStorage.setItem(storageKey, JSON.stringify({ ...next, feed: { news: [], guides: [], resets: [], checkedAt: null } }));
    return { ...next, feed: current.feed };
  };
  return navigator.locks ? navigator.locks.request(storageKey, write) : write();
}
