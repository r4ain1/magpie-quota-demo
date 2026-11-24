const hour = 3_600_000;
const shanghaiDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const shanghaiTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const amounts = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const moneyUnits = new Set(['CNY', 'USD', 'EUR', 'HKD', 'JPY']);

export function dayInShanghai(date = new Date()) {
  return shanghaiDay.format(new Date(date));
}

function timestamp(value) {
  if (typeof value !== 'string' || !value) return NaN;
  return Date.parse(value);
}

export function isLateReport(report) {
  if (typeof report.late === 'boolean') return report.late;
  const scheduled = report.scheduledAt || `${report.day}T09:00:00+08:00`;
  return timestamp(report.generatedAt) >= timestamp(scheduled) + 60000;
}

function known(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function clean(value, label, max = 60) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1F\x7F]/u.test(value)) {
    throw new Error(`请填写有效的${label}（最多 ${max} 字）。`);
  }
  return value.trim();
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value)) throw new Error('记录编号无效。');
  return value;
}

function decimal(value) {
  if (!known(value) || value <= 0 || value > 1e12 || Math.abs(value - rounded(value)) > 1e-8) throw new Error('数量须大于零，最多保留两位小数。');
  return rounded(value);
}

function checkedWindows(raw, unit, now) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 16) throw new Error('请填写至少一个额度窗口，最多 16 个。');
  return raw.map(window => {
    const name = clean(window?.name, '窗口名称');
    const { remaining, capacity } = window;
    if (!known(remaining) || remaining > 1e12 || (capacity != null && (!known(capacity) || capacity <= 0 || capacity > 1e12 || remaining > capacity))) throw new Error('剩余额度须在零与窗口总额之间。');
    if (unit === '%' && (remaining > 100 || (capacity != null && capacity !== 100))) throw new Error('百分比窗口的总额为 100。');
    const resetAt = window.resetAt || null;
    if (resetAt && (!Number.isFinite(timestamp(resetAt)) || timestamp(resetAt) <= timestamp(now))) throw new Error('预计重置时间须在核对时间之后，也可以留空。');
    return { name, remaining: rounded(remaining), capacity: unit === '%' ? 100 : capacity == null ? null : rounded(capacity), resetAt: resetAt && new Date(resetAt).toISOString() };
  });
}

function logOnly(seat) {
  return seat.source === 'magpie' || (seat.unit === '%' && seat.windows.length > 1);
}

export function observationVersion(state, seatId) {
  const seat = state.seats.find(item => item.id === seatId);
  if (!seat) return '';
  const balanceEntry = state.entries.find(entry => entry.seatId === seatId && entry.kind !== 'recharge');
  return `${seat.observedAt}|${seat.baselineId || ''}|${balanceEntry?.id || ''}`;
}

function effectiveUsage(seat, entries) {
  if (logOnly(seat)) return 0;
  const reversed = new Set(entries.filter(entry => entry.kind === 'undo').map(entry => entry.ref));
  const baselineIndex = seat.baselineId ? entries.findIndex(entry => entry.id === seat.baselineId) : -1;
  return entries.reduce((total, entry, index) => {
    if (entry.kind !== 'usage' || entry.seatId !== seat.id || entry.unit !== seat.unit || reversed.has(entry.id)) return total;
    const elapsed = timestamp(entry.at) - timestamp(seat.observedAt);
    return elapsed > 0 || (elapsed === 0 && (baselineIndex === -1 || index < baselineIndex)) ? total + entry.amount : total;
  }, 0);
}

export function getQuota(seat, entries = [], nowIso = new Date().toISOString()) {
  const unknown = { status: 'unknown', remaining: null, capacity: null, percent: null, resetAt: null, windowName: '' };
  if (!seat || seat.archived || !Array.isArray(seat.windows) || !seat.windows.length) return unknown;
  const now = timestamp(nowIso);
  const observed = timestamp(seat.observedAt);
  const delta = effectiveUsage(seat, entries);
  const rows = seat.windows.map(window => {
    const capacity = seat.unit === '%' ? 100 : known(window.capacity) && window.capacity > 0 ? window.capacity : null;
    const remaining = known(window.remaining) && (!capacity || window.remaining <= capacity) ? rounded(Math.max(0, window.remaining - delta)) : null;
    const percent = remaining != null && capacity ? remaining / capacity * 100 : null;
    return { remaining, capacity, percent, resetAt: window.resetAt || null, windowName: window.name };
  });
  if (rows.some(row => row.remaining == null) || !Number.isFinite(observed) || !Number.isFinite(now)) return unknown;
  const binding = [...rows].sort((first, second) => first.remaining - second.remaining || (first.percent ?? 101) - (second.percent ?? 101))[0];
  const maxAge = (seat.source === 'magpie' ? 2 : 24) * hour;
  const elapsed = rows.find(row => row.resetAt && (!Number.isFinite(timestamp(row.resetAt)) || timestamp(row.resetAt) <= now));
  if (elapsed || observed > now + 5 * 60000 || now - observed > maxAge) return { ...(elapsed || binding), status: 'stale' };
  return { ...binding, status: binding.remaining === 0 ? 'empty' : 'ready' };
}

function priorityReset(quota, now) {
  if (quota.percent == null || quota.percent < 50) return Infinity;
  const reset = timestamp(quota.resetAt);
  return reset > now && reset <= now + 24 * hour ? reset : Infinity;
}

export function recommendationReason(seat, seats, entries = [], nowIso = new Date().toISOString()) {
  const comparable = seats.filter(item => item.service === seat.service && (item.pool || '') === (seat.pool || '') &&
    item.unit === seat.unit && getQuota(item, entries, nowIso).status === 'ready');
  if (comparable.length === 1) return '本组同单位账户中，仅此账户读数有效且有余量。';
  const quota = getQuota(seat, entries, nowIso);
  if (Number.isFinite(priorityReset(quota, timestamp(nowIso)))) {
    return `限制窗口余 ${amounts.format(quota.percent)}%，在本组余量至少一半的账户中最早重置。`;
  }
  return `本组 ${comparable.length} 个同单位可用账户中，此账户的限制窗口余量最高。`;
}

export function recommend(seats, entries = [], nowIso = new Date().toISOString()) {
  const candidates = seats.map(seat => ({ seat, quota: getQuota(seat, entries, nowIso) })).filter(item => item.quota.status === 'ready');
  const group = seat => [seat.service, seat.pool || '', seat.unit].join('\u001f');
  const groups = [...new Set(candidates.map(item => group(item.seat)))].sort((first, second) => {
    const preferred = name => /codex|chatgpt/iu.test(name) ? 0 : 1;
    return preferred(first) - preferred(second) || first.localeCompare(second, 'zh-CN');
  });
  const now = timestamp(nowIso);
  const comparable = candidates.filter(item => group(item.seat) === groups[0]);
  comparable.sort((first, second) => {
    const firstTime = priorityReset(first.quota, now);
    const secondTime = priorityReset(second.quota, now);
    return (firstTime === secondTime ? 0 : firstTime - secondTime) || second.quota.remaining - first.quota.remaining || first.seat.id.localeCompare(second.seat.id);
  });
  return comparable[0]?.seat || null;
}

export function applyAction(state, action, nowIso = new Date().toISOString(), actor = '我') {
  if (!action || Array.isArray(action) || typeof action !== 'object') throw new Error('记录格式无效。');
  const id = identifier(action.id);
  const seatId = identifier(action.seatId);
  const { kind } = action;
  const signature = JSON.stringify([kind, seatId, action.amount, action.unit, action.ref, action.label, action.service, action.windows, action.pool]);
  const prior = state.entries.find(entry => entry.id === id);
  if (prior) {
    if (prior.signature !== signature) throw new Error('相同编号已用于另一笔记录。');
    return state;
  }
  const at = new Date(nowIso).toISOString();
  const entry = { id, seatId, kind, at, actor, signature };
  const seat = state.seats.find(item => item.id === seatId);
  let seats = state.seats;
  if (kind === 'add') {
    if (seat) throw new Error('这个席位编号已存在。');
    const label = clean(action.label, '席位名称');
    const service = clean(action.service, '服务名称');
    const unit = clean(action.unit, '额度单位', 16);
    const windows = checkedWindows(action.windows, unit, at);
    seats = [...seats, { id: seatId, label, service, unit, windows, source: 'manual', observedAt: at, baselineId: id }];
  } else if (kind === 'undo') {
    const original = state.entries.find(item => item.id === action.ref && item.seatId === seatId);
    if (!original || original.kind === 'undo' || state.entries.some(item => item.kind === 'undo' && item.ref === original.id)) throw new Error('这笔记录已撤销，或已不可撤销。');
    if (original.kind === 'observe' || original.kind === 'add') {
      if (!seat || seat.baselineId !== original.id) throw new Error('席位已有新的核对结果，请根据新读数核对。');
      if (original.kind === 'add') {
        if (state.entries.some(item => item.seatId === seatId && item.id !== original.id)) throw new Error('席位已有后续流水，请保留此席位。');
        seats = seats.filter(item => item.id !== seatId);
      } else {
        seats = seats.map(item => item.id === seatId ? { ...item, ...original.previous } : item);
      }
    }
    Object.assign(entry, { ref: original.id, amount: original.amount, unit: original.unit });
  } else {
    if (!seat || seat.archived) throw new Error('这个席位目前不可用。');
    if (kind === 'usage') {
      const quota = getQuota(seat, state.entries, at);
      const amount = decimal(action.amount);
      const unit = logOnly(seat) ? '次' : seat.unit;
      if (action.unit && action.unit !== unit) throw new Error(`本项用量的单位为${unit}。`);
      if (unit === '次' && !Number.isInteger(amount)) throw new Error('次数须为整数。');
      if (!logOnly(seat) && (quota.status !== 'ready' || amount > quota.remaining)) throw new Error('当前记录的余量不足或已过期，请先核对额度。');
      Object.assign(entry, { amount, unit });
    } else if (kind === 'recharge') {
      const amount = decimal(action.amount);
      if (!moneyUnits.has(action.unit)) throw new Error('请选择支持的币种。');
      Object.assign(entry, { amount, unit: action.unit });
    } else if (kind === 'observe') {
      if (seat.source !== 'manual') throw new Error('此席位由 Magpie 同步。');
      if (action.expectedVersion != null && action.expectedVersion !== observationVersion(state, seatId)) {
        throw new Error('这期间已有新的席位记录。请重新打开核对窗口，按当前读数确认。');
      }
      const windows = checkedWindows(action.windows, seat.unit, at);
      entry.previous = { windows: seat.windows, observedAt: seat.observedAt, baselineId: seat.baselineId || null };
      seats = seats.map(item => item.id === seatId ? { ...item, windows, observedAt: at, baselineId: id } : item);
    } else {
      throw new Error('记录类型无效。');
    }
  }
  return { ...state, seats, entries: [entry, ...state.entries] };
}

function publicLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function buildReport(state, nowIso = new Date().toISOString()) {
  const generatedAt = new Date(nowIso).toISOString();
  const day = dayInShanghai(generatedAt);
  const active = state.seats.filter(seat => !seat.archived);
  const preferred = recommend(active, state.entries, generatedAt);
  const status = { ready: '可用', stale: '待复核', empty: '已用完', unknown: '余量未知' };
  const formatQuota = seat => {
    const quota = getQuota(seat, state.entries, generatedAt);
    const balance = quota.remaining == null ? '余量未知' : `${quota.status === 'stale' ? '上次剩余' : '剩余'} ${amounts.format(quota.remaining)}${seat.unit}`;
    const resets = quota.resetAt && Number.isFinite(timestamp(quota.resetAt)) ? `，窗口重置 ${shanghaiTime.format(new Date(quota.resetAt))}` : '';
    return `${balance}${resets}（${status[quota.status]}）`;
  };
  const lines = [`团队额度早报 · ${day}`, `北京时间 ${shanghaiTime.format(new Date(generatedAt))} 生成`, '', '优先使用'];
  lines.push(preferred ? `${preferred.service} · ${preferred.label}，${formatQuota(preferred)}。` : '暂无读数有效且有余量的席位。');
  if (preferred) lines.push(recommendationReason(preferred, active, state.entries, generatedAt));
  lines.push('', '各席位额度');
  if (!active.length) lines.push('尚未取得席位读数。');
  for (const seat of active) lines.push(`${seat.service} · ${seat.label}${seat.pool && !seat.label.includes(seat.pool) ? ` / ${seat.pool}` : ''}　${formatQuota(seat)}${Number.isFinite(timestamp(seat.observedAt)) ? `，采样 ${shanghaiTime.format(new Date(seat.observedAt))}` : ''}`);
  const auxiliary = state.feed?.sources?.magpie?.auxiliaryPools || [];
  if (auxiliary.length) {
    lines.push('', '辅助额度');
    for (const seat of auxiliary) {
      const observed = timestamp(seat.observedAt);
      const hasSampleTime = Number.isFinite(observed);
      const sample = hasSampleTime ? `采样 ${shanghaiTime.format(observed)}` : '采样时间未知，待复核';
      for (const window of seat.windows) {
        const reading = hasSampleTime && known(window.remaining) ? `${amounts.format(window.remaining)} ${seat.unit}` : '余量未知';
        lines.push(`${seat.service} · ${seat.label} · ${window.name}　${reading}，${sample}`);
      }
    }
  }
  const yesterday = dayInShanghai(new Date(timestamp(generatedAt) - 24 * hour));
  const reversals = new Set(state.entries.filter(entry => entry.kind === 'undo').map(entry => entry.ref));
  const activeIds = new Set(active.map(seat => seat.id));
  const totals = new Map();
  for (const entry of state.entries) {
    if (entry.kind !== 'recharge' || !activeIds.has(entry.seatId) || reversals.has(entry.id) || dayInShanghai(entry.at) !== yesterday) continue;
    totals.set(entry.unit, rounded((totals.get(entry.unit) || 0) + entry.amount));
  }
  lines.push('', '昨日充值', totals.size ? [...totals].map(([unit, value]) => `${unit} ${amounts.format(value)}`).join('，') : '没有登记充值。');
  const feed = state.feed || {};
  const sections = [
    ['ChatGPT / Codex 重置信号', feed.resets, '当前采集范围内无重置事件。'],
    ['AI 热点', feed.news, '暂无可展示的热点。'],
    ['OilOil 精选阅读', feed.guides, '暂无可展示的指南。'],
  ];
  for (const [label, items, empty] of sections) {
    lines.push('', label);
    if (!items?.length) {
      const sourceKeys = label.startsWith('ChatGPT') ? ['resets'] : label === 'AI 热点' ? ['news'] : ['codexBook','chatBook'];
      const missing = sourceKeys.some(key => ['unavailable', 'stale', 'delayed'].includes(feed.sources?.[key]?.status));
      const partial = sourceKeys.some(key => feed.sources?.[key]?.status === 'partial');
      lines.push(partial ? '部分事件仍待核实。' : missing ? '该来源本次未能完成核查。' : empty);
    }
    for (const item of (items || []).slice(0, 3)) {
      const at = item.at && Number.isFinite(timestamp(item.at)) ? ` · ${dayInShanghai(item.at)}` : '';
      const link = publicLink(item.url);
      const statusLabel = { announced: '已公告', confirmed: '已确认' }[item.status];
      lines.push(`${statusLabel ? `〔${statusLabel}〕` : ''}${item.title}（${item.source || label}${at}）${link ? ` ${link}` : ''}`);
      if (statusLabel && item.summary) lines.push(item.summary);
    }
    if (label.startsWith('ChatGPT') && Number.isFinite(timestamp(feed.resetCheckedAt))) {
      lines.push(`监测来源最近核查于北京时间 ${shanghaiTime.format(new Date(feed.resetCheckedAt))}。`);
    }
  }
  if (feed.errors?.length) lines.push('', '采集提示', ...feed.errors.map(String));
  const scheduledAt = new Date(`${day}T09:00:00+08:00`).toISOString();
  return { day, generatedAt, scheduledAt, late: timestamp(generatedAt) >= timestamp(scheduledAt) + 60000,
    text: lines.join('\n'), seatIds: [...active, ...auxiliary].map(seat => seat.id) };
}
