import { getQuota, recommend, recommendationReason, buildReport, isLateReport, observationVersion } from './model.mjs';
import { readDemo, saveDemoAction, storageKey } from './demo.mjs';
import { beforeRender, afterRender } from './motion.mjs';

const demo = document.body.dataset.mode === 'demo';
const main = document.querySelector('#main');
const modal = document.querySelector('#editor');
const dialogBody = document.querySelector('#dialog-body');
const pages = { overview: '额度总览', ledger: '操作流水', brief: '团队早报', sources: '资讯指南' };
const kinds = { usage: '登记使用', recharge: '登记充值', undo: '撤销操作', observe: '核对窗口', add: '新增账户' };
const categories = { news: 'AIHOT 热点', resets: 'ChatGPT / Codex 重置信号', guides: 'OilOil 指南' };
const resetStatusLabels = new Map([['announced','已公告'],['confirmed','已确认']]);
const statuses = { ready: '可用', empty: '已用尽', stale: '待更新', unknown: '未知' };
const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
  system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>', external: '<path d="M6 18 18 6M7 6h11v11"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.6 5.4L8 16l2.6-5.4Z"/>',
  sunrise: '<path d="M2 18h20M5 21h14M7 15a5 5 0 0 1 10 0M12 3v3M3 8l2 2m16-2-2 2M2 15h2m16 0h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  chat: '<path d="M4 5h13a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-5 4v-4H3V7a2 2 0 0 1 1-2Z"/><path d="M7 9h8m-8 3h5"/>',
  layers: '<path d="m2 8 10-5 10 5-10 5Zm0 5 10 5 10-5M2 18l10 5 10-5"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4"/>'
};
const icon = key => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[key] ?? ''}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const numberFormat = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:2});
const dateFormats = new Map();
const num = value => Number.isFinite(value) ? esc(numberFormat.format(value)) : '—';
function date(value, options) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未知';
  const key = JSON.stringify(options);
  if (!dateFormats.has(key)) dateFormats.set(key, new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', ...options}));
  return dateFormats.get(key).format(new Date(value));
}
const stamp = value => date(value, {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
const sourceName = seat => seat.source === 'magpie' ? 'Magpie 采集' : '手工维护';
const unitName = unit => unit === '%' ? '百分点' : unit;
const page = () => Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
const command = (key, label, extra = '', style = 'btn') => `<button type="button" class="${style}" data-cmd="${key}" ${extra}>${label}</button>`;
const seatAttr = seat => `data-seat="${esc(seat.id)}"`;
const tabButton = (cmd, key, label, selected) => command(cmd, esc(label), `data-value="${esc(key)}" aria-pressed="${key === selected}"`, '');
let state, service, pool, quotaUnit, accountFilter = '', feedTab = 'news', ledgerFilter = '';
const journalKey = `magpie.pending-actions:${new URL('./api/action', document.baseURI).pathname}`;
let journalOwner;
let unresolved = [];
let refreshError = '';
const ledgerPageSize = 30;
let ledgerLimit = ledgerPageSize;
const cardPageSize = 12;
let cardLimit = cardPageSize;
let reportCache;
let reading = false;
let lastRead, version = 0, feedVersion = 0, feedError = '', feedLoading = false, busy = false, formContext, timer;
let published = { news:[], resets:[], guides:[], checkedAt:null };
let theme = 'system';
try { theme = localStorage.getItem('magpie.appearance') || 'system'; } catch {}
function paintTheme() {
  const names = {system:'跟随系统', light:'浅色', dark:'深色'};
  document.documentElement.dataset.theme = theme;
  const control = document.querySelector('#theme');
  control.innerHTML = icon(({system:'system',light:'sun',dark:'moon'})[theme]);
  control.title = control.ariaLabel = `外观：${names[theme]}，点击切换`;
}
paintTheme();
document.querySelector('#theme').onclick = () => {
  theme = ({system:'light',light:'dark',dark:'system'})[theme] ?? 'system';
  try { localStorage.setItem('magpie.appearance', theme); } catch {}
  paintTheme();
};
function tell(message) {
  const node = document.querySelector('#notice');
  node.textContent = message;
  clearTimeout(timer);
  timer = setTimeout(() => { node.textContent = ''; }, 4200);
}
const modeName = () => demo ? '公开演示' : state?.role === 'owner' ? '团队 · 管理员' : state?.role === 'member' ? '团队 · 成员' : '团队空间';
function renderMode() {
  document.querySelector('#mode').innerHTML = `<span class="badge">${modeName()}</span>`;
}
renderMode();
async function jsonRequest(path, body) {
  const response = await fetch(path, {
    method:body ? 'POST' : 'GET', cache:'no-store', credentials:'same-origin',
    signal:AbortSignal.timeout(20000),
    headers:body ? {'Content-Type':'application/json', Accept:'application/json'} : {Accept:'application/json'},
    ...(body ? {body:JSON.stringify(body)} : {})
  }).catch(error => {
    throw Error(error.name === 'TimeoutError' ? '请求超时，请重试。' : '无法连接服务，请检查网络后重试。');
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const detail = result?.message || result?.error || (typeof result === 'string' ? result : raw.slice(0, 400));
    const error = Error(typeof detail === 'string' && detail && !detail.trimStart().startsWith('<') ? detail : `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    if (rosterUnavailable(error)) showReadError(error);
    throw error;
  }
  if (!result || typeof result !== 'object') throw Error('服务返回的数据格式无效，请重试。');
  return result;
}
function validState(next) {
  if (!Array.isArray(next?.seats) || !Array.isArray(next?.entries)) throw Error('未收到完整的账户状态，请重新读取。');
  return next;
}
function rosterUnavailable(error) {
  return !demo && error.status === 503 && error.message.startsWith('暂时无法核对团队席位名单');
}
function showReadError(error) {
  ++version;
  state = formContext = reportCache = lastRead = null;
  journalOwner = null;
  refreshError = '';
  unresolved = [];
  if (modal.open) modal.close();
  dialogBody.replaceChildren();
  clearTimeout(timer);
  document.querySelector('#notice').textContent = '';
  renderMode();
  const motion = beforeRender();
  main.innerHTML = `<div class="panel"><h1>${error.status === 403 ? '团队访问申请' : '额度台暂时无法读取'}</h1>
    <p class="error" role="alert">${esc(error.message)}</p>${error.status === 403 && /等待负责人授权/.test(error.message) ? '<p>访问申请已自动登记，负责人批准后即可进入。</p>' : ''}${command('refresh','重新检查')}</div>`;
  afterRender(motion);
}
function journalIdentity(snapshot) {
  const {role, actor} = snapshot;
  const memberKey = role === 'owner' && actor === '负责人' ? 'owner' :
    role === 'member' && typeof actor === 'string' && /^成员 \d+$/.test(actor) ? actor.slice(3) : null;
  return memberKey && {role, actor, prefix:`${journalKey}:${role}:${memberKey}:`};
}
function validPending(action) {
  return typeof action?.id === 'string' && action.id.length > 0 && Object.hasOwn(kinds,action.kind);
}
function readJournal(owner) {
  const actions = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(owner.prefix)) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    const action = JSON.parse(raw);
    if (!validPending(action) || key !== owner.prefix + action.id) throw Error('本机待确认操作格式无效。');
    actions.push(action);
  }
  return actions;
}
function migrateSession(owner, entries) {
  const binding = `${journalKey}:scope`;
  const raw = sessionStorage.getItem(journalKey);
  if (raw !== null) {
    const legacy = JSON.parse(raw);
    if (!Array.isArray(legacy) || !legacy.every(validPending)) throw Error('旧会话的待确认记录格式无效。');
    const bound = sessionStorage.getItem(binding) === owner.prefix;
    const confirmed = new Set(entries.filter(entry => entry.actor === owner.actor).map(entry => entry.id));
    const unclaimed = [];
    for (const action of legacy) {
      if (confirmed.has(action.id)) continue;
      if (!bound) { unclaimed.push(action); continue; }
      const key = owner.prefix + action.id;
      if (localStorage.getItem(key) === null) localStorage.setItem(key,JSON.stringify(action));
    }
    if (unclaimed.length) {
      sessionStorage.setItem(journalKey,JSON.stringify(unclaimed));
      return false;
    }
    sessionStorage.removeItem(journalKey);
  }
  sessionStorage.setItem(binding,owner.prefix);
  return true;
}
function confirmJournal(owner, entries) {
  unresolved = readJournal(owner);
  if (!unresolved.length) return 0;
  const confirmed = new Set(entries.filter(entry => !entry.actor || entry.actor === owner.actor).map(entry => entry.id));
  const previousCount = unresolved.length;
  unresolved = unresolved.filter(action => {
    if (!confirmed.has(action.id)) return true;
    localStorage.removeItem(owner.prefix + action.id);
    return false;
  });
  return previousCount - unresolved.length;
}
function describeAction(action) {
  const label = action.label || state.seats.find(seat => seat.id === action.seatId)?.label || action.seatId;
  const amount = action.amount == null ? '' : ` · ${num(action.amount)} ${esc(unitName(action.unit))}`;
  return `${esc(kinds[action.kind])} · ${esc(label)}${amount}`;
}
function recoveryPanel() {
  if (demo || !unresolved.length) return '';
  return `<section class="panel" aria-label="待确认操作"><h2>操作结果待确认</h2>
    <p class="meta">可重新查询流水，或用原编号重试。另填表单会创建新操作。</p>${unresolved.map(action =>
      `<div class="ledger-row"><div><strong>${describeAction(action)}</strong><p class="meta">原编号 ${esc(action.id)}</p></div>
      <div class="row">${command('retry-action','按原编号重试',`data-id="${esc(action.id)}"`)}${command('dismiss-action','结束追踪',`data-id="${esc(action.id)}"`,'ghost')}</div></div>`).join('')}
    ${command('refresh','重新查询流水')}</section>`;
}
async function postAction(action, retry) {
  const owner = journalOwner;
  if (!owner) throw Error('暂未确认本机成员编号，请重新读取团队台账。');
  const key = owner.prefix + action.id;
  const raw = localStorage.getItem(key);
  if (retry && raw === null) throw Error('其他标签页已处理此操作，请重新核查流水。');
  const original = raw === null ? action : JSON.parse(raw);
  if (!validPending(original) || action.id !== original.id) throw Error('本机待确认操作格式无效。');
  if (raw === null) localStorage.setItem(key,JSON.stringify(action));
  unresolved = readJournal(owner);
  let next;
  try {
    next = validState(await jsonRequest('./api/action',original));
    if (next.role !== owner.role || (next.actor != null && next.actor !== owner.actor)) {
      const error = Error('团队身份已变化，请重新读取台账。');
      if (journalOwner === owner) showReadError(error);
      throw error;
    }
    const receipt = next.receipt;
    if (!(receipt?.id === original.id && receipt.actor === owner.actor) &&
        !next.entries.some(entry => entry.id === original.id && (!entry.actor || entry.actor === owner.actor))) {
      throw Error('尚未取得此操作的回执或流水。');
    }
  } catch (error) {
    if ([400,401,403,404,405,409,413,415,422].includes(error.status) ||
        (rosterUnavailable(error) && raw === null)) {
      localStorage.removeItem(key);
    }
    if (journalOwner === owner) unresolved = readJournal(owner);
    throw error;
  }
  localStorage.removeItem(key);
  if (journalOwner === owner) confirmJournal(owner,next.entries);
  return next;
}
function href(value) {
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? esc(url.href) : ''; } catch { return ''; }
}
function reportInfo(now) {
  const saved = state.report;
  const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(now));
  if (!demo && saved?.text && saved.day === day) return { report:saved, label:isLateReport(saved) ? '延时补报' : '准点日报' };
  const minute = now.slice(0,16);
  if (reportCache?.state !== state || reportCache.minute !== minute) reportCache = { state, minute, report:buildReport(state, now) };
  return { report:reportCache.report, label:demo ? '演示样报' : '即时预览' };
}
function briefCard(now) {
  const { report, label } = reportInfo(now);
  const excerpt = report.text.match(/(?:^|\n)优先使用\r?\n([^\n]+)/)?.[1] || report.text;
  const recharge = report.text.match(/(?:^|\n)昨日充值\r?\n([^\n]+)/)?.[1];
  return `<aside class="brief-card"><div class="brief-kicker"><span>${icon('sunrise')}${label}</span><time>${esc(report.day)}</time></div>
    <div class="brief-copy"><h2>团队早报</h2><p class="brief-excerpt">${esc(excerpt)}</p>
      ${recharge ? `<div class="brief-recharge"><span>昨日充值</span> ${esc(recharge)}</div>` : ''}</div>
    <div class="brief-foot"><span>实际生成 ${stamp(report.generatedAt)} · 北京时间</span><a class="text-link" href="#brief">阅读全文 ${icon('arrow')}</a></div></aside>`;
}
function meter(percent, label) {
  if (!Number.isFinite(percent)) return '<span class="unknown-meter">占比未知</span>';
  const value = Math.max(0, Math.min(100, percent));
  return `<div class="track" role="img" aria-label="${esc(label)}"><span style="width:${value}%"></span></div>`;
}
function amountMarkup(quota, unit, className) {
  return `<span class="${className}">${num(quota.remaining)}<small>${esc(unit)}</small></span>`;
}
function options(values, selected, all) {
  return (all ? `<option value="">${esc(all)}</option>` : '') + values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`).join('');
}
function recommendation(now) {
  const seats = state.seats.filter(seat => !seat.archived);
  const services = [...new Set(seats.map(seat => seat.service))];
  const preferred = recommend(seats, state.entries, now);
  const selectedService = services.includes(service) ? service : preferred?.service ?? services[0];
  const candidates = seats.filter(seat => seat.service === selectedService);
  const pools = [...new Set(candidates.map(seat => seat.pool || ''))];
  const inService = selectedService === preferred?.service ? preferred : recommend(candidates,state.entries,now);
  const selectedPool = pools.includes(pool) ? pool : inService ? inService.pool || '' : pools[0];
  const group = candidates.filter(seat => (seat.pool || '') === selectedPool);
  const units = [...new Set(group.map(item => item.unit))];
  const inPool = recommend(group,state.entries,now);
  const selectedUnit = units.includes(quotaUnit) ? quotaUnit : inPool?.unit ?? units[0];
  const seat = selectedUnit === inPool?.unit ? inPool : recommend(group.filter(item => item.unit === selectedUnit),state.entries,now);
  const selectors = `<div class="filters-inline">${services.length ? `<select aria-label="推荐服务" id="service">${options(services, selectedService)}</select>` : ''}
    ${pools.some(Boolean) ? `<select aria-label="推荐额度池" id="pool">${pools.map(value => `<option value="${esc(value)}" ${value === selectedPool ? 'selected' : ''}>${esc(value || '未分池')}</option>`).join('')}</select>` : ''}
    ${units.length > 1 ? `<select aria-label="推荐额度单位" id="quota-unit">${options(units,selectedUnit)}</select>` : ''}</div>`;
  const top = `<div class="hero-top"><span class="eyeline">${icon('compass')} 推荐账户</span>${selectors}</div>`;
  if (!seat) return `<section class="hero">${top}<div class="hero-middle"><h2>暂无可推荐账户</h2></div><small>此范围内尚无可用的额度窗口。</small></section>`;
  const quota = getQuota(seat, state.entries, now);
  const reason = recommendationReason(seat,seats,state.entries,now);
  const bars = seat.windows.map(window => {
    const current = window.name === quota.windowName;
    const percent = current ? quota.percent : getQuota({ ...seat, windows:[window] },
      seat.unit === '%' && seat.windows.length > 1 ? [] : state.entries, now).percent;
    return `<div class="window ${current ? 'limiting' : ''}"><span>${esc(window.name)}</span>${meter(percent, `${window.name}剩余 ${num(percent)}%`)}<span class="mono">${Number.isFinite(percent) ? `${num(percent)}%` : ''}</span></div>`;
  }).join('');
  return `<section class="hero">${top}<div class="hero-middle"><div><h2>${esc(seat.label)}</h2><small>${esc(quota.windowName || '窗口')} · 可用余量</small></div>
    ${amountMarkup(quota,seat.unit,'hero-number')}</div>${bars}<p class="reason">${esc(reason)}</p>
    <div class="hero-foot"><span>${icon('clock')} ${quota.resetAt ? `${stamp(quota.resetAt)} 重置` : '重置时间未知'} · 采样 ${stamp(seat.observedAt)}</span>${command('usage', `登记使用 ${icon('arrow')}`,seatAttr(seat),'text-link')}</div></section>`;
}
function accountCard(seat, now) {
  const quota = getQuota(seat, state.entries, now);
  const mark = /codex/i.test(seat.service) ? 'code' : /chatgpt/i.test(seat.service) ? 'chat' : 'layers';
  return `<article class="account"><div class="account-head"><span class="mark">${icon(mark)}</span><span class="meta">${esc(seat.service)} · ${esc(statuses[quota.status] ?? '未知')}</span></div>
    <h3>${esc(seat.label)}</h3><div class="meta">${sourceName(seat)}${seat.pool ? ` · ${esc(seat.pool)}` : ''}</div>
    <div class="account-value">${amountMarkup(quota,seat.unit,'card-number')}<span class="meta">${esc(quota.windowName || '窗口')} · ${quota.status === 'stale' ? '上次余量' : '剩余'}</span></div>
    ${meter(quota.percent, `可用比例 ${num(quota.percent)}%`)}<div class="meta reset">${icon('clock')} ${quota.resetAt ? `${stamp(quota.resetAt)} 重置` : '重置时间未知'}</div>
    <div class="card-actions">${command('usage','使用',seatAttr(seat),'')}${command('recharge','充值',seatAttr(seat),'')}
    ${seat.source === 'manual' ? command('observe','核对',seatAttr(seat),'') : ''}${command('details',`窗口 ${icon('arrow')}`,seatAttr(seat),'detail')}</div></article>`;
}
function accounts(now) {
  const seats = state.seats.filter(seat => !seat.archived);
  const services = [...new Set(seats.map(seat => seat.service))];
  if (!services.includes(accountFilter)) accountFilter = '';
  const visible = seats.filter(seat => !accountFilter || seat.service === accountFilter);
  return `<section class="section"><div class="section-head"><div class="heading-group"><h2>账户与窗口</h2><span class="count">${visible.length}</span></div>
    <div class="filter" aria-label="筛选账户">${['',...services].map(value => tabButton('accounts',value,value || '全部',accountFilter)).join('')}</div></div>
    ${visible.length ? `<div class="cards">${visible.slice(0,cardLimit).map(seat => accountCard(seat,now)).join('')}</div>` : '<div class="panel empty">暂无账户，可添加首个手工账户。</div>'}
    ${visible.length > cardLimit ? `<div class="ledger-paging">${command('more-cards',`再显示 ${Math.min(cardPageSize,visible.length-cardLimit)} 个账户`)}</div>` : ''}</section>`;
}
function resetHistory() {
  const expanded = main.querySelector('#reset-history')?.open;
  return `<div class="detail-window">
    <a class="text-link" href="https://aihot.news/codex-reset" target="_blank" rel="noopener noreferrer">查看 AIHOT 完整重置历史 ${icon('external')}</a>
    <details id="reset-history" ${expanded ? 'open' : ''}><summary id="reset-history-summary">历史实例 · <time datetime="2026-11-13">2026-11-13</time></summary>
      <p>2026 年 11 月 13 日，AIHOT 记录了 Codex 重置卡发放公告。具体到账时间由来源推算，适用账户范围未说明。</p>
      <p class="meta">此历史实例与当前席位额度独立。</p>
      <a class="text-link" href="https://aihot.news/codex-reset/history/2026-11-13" target="_blank" rel="noopener noreferrer">查看当日核实记录 ${icon('external')}</a>
    </details></div>`;
}
function sources(compact = false) {
  const feed = state.feed || {};
  const items = Array.isArray(feed[feedTab]) ? feed[feedTab] : [];
  const sourceLabels = {news:'AIHOT 热点',resets:'AIHOT 重置监测',codexBook:'Codex 指南',chatBook:'ChatGPT 指南'};
  const sourceKeys = feedTab === 'guides' ? ['codexBook','chatBook'] : [feedTab];
  const partial = feedTab === 'resets' && (feed.sources?.resets?.status === 'partial' || feed.sources?.resets?.partial === true || feed.sources?.resets?.skippedEvents > 0);
  const relevant = {news:/热点|hot news/i,resets:/重置|reset/i,guides:/Oil|指南|guide/i}[feedTab];
  const errors = (Array.isArray(feed.errors) ? feed.errors : []).filter(message => relevant.test(message));
  if (feedError) errors.push(feedError);
  const sourceTimes = sourceKeys.map(key => {
    const meta = feed.sources?.[key];
    const status = {stale:' · 显示缓存',unavailable:' · 暂不可用',delayed:' · 监测延迟'}[meta?.status] || '';
    return `<div class="meta">${sourceLabels[key]} · 最近成功读取 ${stamp(meta?.lastSuccessAt)}${status}</div>`;
  }).join('');
  const visible = compact ? items.slice(0,3) : items;
  let empty = `暂无已发布的${categories[feedTab]}。`;
  if (feedTab === 'resets') empty = feed.sources?.resets?.status === 'ok' ? '最近 7 天内，AIHOT 未收录已识别的重置事件。' : '暂无可展示的已核实事件。';
  if (errors.length) empty = '暂未取得此分类的内容。';
  if (partial) empty = '本次没有可展示的已核实事件。';
  if (feedLoading) empty = '正在读取公开来源…';
  return `<section class="${compact ? 'section' : ''}"><div class="section-head">${compact ? '<h2>资讯与指南</h2>' : ''}
    <div class="filter" aria-label="资讯分类">${Object.entries(categories).map(([key,name]) => tabButton('feed',key,name,feedTab)).join('')}</div></div>
    <div class="panel">${visible.map(item => {
      const url = href(item.url);
      const status = feedTab === 'resets' ? resetStatusLabels.get(item.status) : item.status;
      return `<article class="source-row"><div><div class="meta">${esc(item.source)}${item.at ? ` · ${stamp(item.at)}` : ''}${status ? ` · ${esc(status)}` : ''}</div>
        <h3>${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ${icon('external')}</a>` : esc(item.title)}</h3>${item.summary ? `<p class="meta">${esc(item.summary)}</p>` : ''}</div></article>`;
    }).join('') || `<p class="empty">${esc(empty)}</p>`}
    ${partial ? '<p class="meta">部分事件待核实</p>' : ''}
    ${errors.length ? `<p class="error">${errors.map(esc).join('<br>')}</p>${command('retry-feed','重新读取')}` : ''}
    ${sourceTimes}${feedTab === 'resets' ? `<div class="meta">监测方最近核查 ${stamp(feed.resetCheckedAt)}</div>${resetHistory()}` : ''}
    ${compact && items.length > visible.length ? '<a class="text-link" href="#sources">查看全部 →</a>' : ''}</div></section>`;
}
function pending() {
  if (demo || state.role !== 'owner' || !state.pending?.length) return '';
  return `<section class="section"><div class="section-head"><h2>待批准访问</h2></div><div class="panel">${state.pending.map(login =>
    `<div class="pending-row"><span>${esc(login)}</span>${command('allow','批准访问',`data-login="${esc(login)}"`)}</div>`).join('')}</div></section>`;
}
function members() {
  if (demo || state.role !== 'owner' || !Array.isArray(state.members)) return '';
  const expanded = main.querySelector('#members')?.open;
  return `<details class="section panel" id="members" ${expanded ? 'open' : ''}><summary>已授权成员（${state.members.length}）</summary>
    ${state.members.map(member => `<div class="pending-row"><span>${esc(member.alias)} <small>${esc(member.login)}</small></span>
      ${command('revoke','撤销访问',`data-login="${esc(member.login)}"`)}</div>`).join('') || '<p class="empty">暂无已授权成员。</p>'}</details>`;
}
function ledger() {
  const entries = state.entries.filter(entry => !ledgerFilter || entry.kind === ledgerFilter)
    .slice().sort((first, second) => Date.parse(second.at) - Date.parse(first.at));
  const undone = new Set(state.entries.filter(entry => entry.kind === 'undo').map(entry => entry.ref));
  const byId = new Map(state.entries.map(entry => [entry.id,entry]));
  const seatById = new Map(state.seats.map(seat => [seat.id,seat]));
  const visible = entries.slice(0,ledgerLimit);
  return `<div class="section-head"><div class="filter" aria-label="流水类型">${['','usage','recharge','observe','add','undo'].map(key => tabButton('ledger',key,kinds[key] || '全部',ledgerFilter)).join('')}</div></div>
    <div class="panel">${visible.map(entry => {
      const seat = seatById.get(entry.seatId);
      const ref = byId.get(entry.ref);
      return `<article class="ledger-row" data-entry="${esc(entry.id)}" tabindex="-1"><div><strong>${esc(kinds[entry.kind] ?? entry.kind)}</strong> · ${esc(seat?.label ?? entry.label ?? entry.seatId)}
        ${['usage','recharge'].includes(entry.kind) ? `<span class="ledger-amount">${num(entry.amount)} ${esc(unitName(entry.unit))}</span>` : ''}
        <div class="meta">${stamp(entry.at)} · ${esc(entry.actor || '未注明操作者')}${ref ? ` · 关联 ${esc(kinds[ref.kind])} ${stamp(ref.at)}` : ''}</div></div>
        ${entry.kind === 'undo' ? '' : undone.has(entry.id) ? '<span class="meta">已撤销</span>' : command('undo','撤销',`data-ref="${esc(entry.id)}"`)}</article>`;
    }).join('') || '<p class="empty">暂无操作流水。登记使用、充值或核对后可在此查看。</p>'}</div>
    ${entries.length ? `<div class="ledger-paging"><span class="meta" role="status">已显示 ${visible.length} / ${entries.length} 条</span>
      ${visible.length < entries.length ? command('more-entries',`再显示 ${Math.min(ledgerPageSize,entries.length-visible.length)} 条`) : ''}</div>` : ''}`;
}
function brief(now) {
  const { report, label } = reportInfo(now);
  return `<article class="panel report"><div class="brief-kicker"><span>${icon('sunrise')}${label}</span><time>${esc(report.day)}</time></div>
    <pre>${esc(report.text)}</pre><div class="detail-window meta">生成于 ${stamp(report.generatedAt)}（北京时间）${label === '即时预览' ? ' · 今日 09:00 准点日报尚未发布' : ''}</div></article>`;
}
function render() {
  if (!state) return;
  const motion = beforeRender();
  const now = new Date().toISOString();
  const view = page();
  document.title = `${pages[view]} · 余量 / MAGPIE`;
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.hash === `#${view}`) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  const active = main.contains(document.activeElement) ? document.activeElement : null;
  const keyboardTarget = active?.dataset.cmd ? [...Object.entries(active.dataset)] : null;
  renderMode();
  main.innerHTML = `<div class="page-head"><div><h1>${pages[view]}</h1><div class="date-line">${icon('calendar')}<time>${date(now,{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</time><i></i>
    <span>${demo ? '模拟账户 · 仅本机保存' : '团队共享账户'}</span></div></div>
    ${view === 'overview' ? command('add',`${icon('plus')} 添加账户`) : ''}</div>
    ${recoveryPanel()}${refreshError ? `<p class="error" role="status">${esc(refreshError)}</p>` : ''}
    ${view === 'overview' ? `<div class="feature-grid">${recommendation(now)}${briefCard(now)}</div>${accounts(now)}${pending()}${sources(true)}${members()}` :
      view === 'ledger' ? ledger() : view === 'brief' ? brief(now) : sources()}
    <footer class="page-foot"><span>余量 / MAGPIE · ${modeName()}</span><span>北京时间 · 读取于 ${stamp(lastRead)} ${command('refresh',icon('refresh'),'aria-label="刷新额度台"','ghost')}</span></footer>`;
  if (active?.id) document.getElementById(active.id)?.focus({preventScroll:true});
  else if (keyboardTarget) [...main.querySelectorAll('[data-cmd]')].find(node => keyboardTarget.every(([key,value]) => node.dataset[key] === value))?.focus({preventScroll:true});
  else if (active?.dataset.entry) [...main.querySelectorAll('[data-entry]')].find(node => node.dataset.entry === active.dataset.entry)?.focus({preventScroll:true});
  else if (active?.href) [...main.querySelectorAll('a')].find(node => node.href === active.href)?.focus({preventScroll:true});
  afterRender(motion);
}

function input(name, label, value = '', attributes = 'required') {
  return `<label class="field">${label}<input name="${name}" value="${esc(value)}" ${attributes}></label>`;
}
function windowFields(window = {}) {
  const parsed = Date.parse(window.resetAt);
  const reset = Number.isFinite(parsed) ? new Date(parsed + 8 * 3600000).toISOString().slice(0,16) : '';
  return `<fieldset data-window><legend>额度窗口</legend>${input('window-name','窗口名称',window.name)}
    <div class="field-pair">${input('remaining','当前剩余',window.remaining,'type="number" min="0" step="any" required')}
    ${input('capacity','窗口容量（可留空）',window.capacity,'type="number" min="0.000001" step="any"')}</div>
    ${input('reset','重置时间（北京时间，可留空）',reset,'type="datetime-local"')}
    ${command('remove-window','移除此窗口','','ghost')}</fieldset>`;
}
function details(seat) {
  return `<p class="meta">${esc(seat.service)} · ${sourceName(seat)} · 最近读数 ${stamp(seat.observedAt)}（北京时间）</p>
    ${seat.windows.map(window => `<div class="detail-window"><strong>${esc(window.name)}</strong><div class="row"><span class="mono">${num(window.remaining)} / ${num(window.capacity)} ${esc(seat.unit)}</span><span class="meta">核对时读数</span></div>
      ${meter(Number.isFinite(window.remaining) && window.capacity > 0 ? window.remaining / window.capacity * 100 : null,window.name + '核对时余额')}<p class="meta">${window.resetAt ? `${stamp(window.resetAt)} 重置` : '重置时间未知'}</p></div>`).join('') || '<p class="empty">暂无窗口读数。</p>'}
    <div class="actions">${command('usage','登记使用',seatAttr(seat),'btn primary')}${command('recharge','登记充值',seatAttr(seat))}${seat.source === 'manual' ? command('observe','核对窗口',seatAttr(seat)) : ''}</div>`;
}
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
function openDialog(kind, seat, ref, login, original) {
  if (busy || (kind === 'observe' && seat?.source !== 'manual')) return;
  const id = newId();
  formContext = { kind, seat, ref, login, id, seatId: seat?.id ?? ref?.seatId ?? `manual-${id}` };
  if (kind === 'observe') formContext.expectedVersion = observationVersion(state,seat.id);
  if (original) formContext.original = original;
  const extraTitles = {allow:'批准访问',revoke:'撤销成员访问','retry-action':'重试原操作','dismiss-action':'结束追踪'};
  const title = kind === 'details' ? seat.label : extraTitles[kind] ?? kinds[kind];
  let content = '';
  if (kind === 'details') content = details(seat);
  else {
    let fields = '';
    if (kind === 'usage' || kind === 'recharge') {
      const history = kind === 'usage' && (seat.source === 'magpie' || (seat.windows.length > 1 && seat.unit === '%'));
      const unit = history ? '次' : seat.unit;
      const note = history ? (seat.source === 'magpie' ? '仅记录任务次数，窗口余量以 Magpie 采集读数为准。' : '多个百分比窗口分别计量，此处仅登记任务次数。') :
        kind === 'recharge' ? '按实际支付币种登记金额，窗口额度以核对或采集读数为准。' :
        unit === '%' ? '每使用 1 个百分点，此手工窗口的余量减少 1 个百分点。' : '';
      fields = `<p class="meta">${esc(seat.label)} · ${sourceName(seat)}</p>${note ? `<p class="muted">${note}</p>` : ''}
        ${kind === 'recharge' ? `<label class="field">支付币种<select name="unit">${options(['CNY','USD','EUR','HKD','JPY'],'CNY')}</select></label>` : `<input type="hidden" name="unit" value="${esc(unit)}">`}
        ${input('amount',kind === 'recharge' ? '充值金额' : `使用量（${esc(unitName(unit))}）`,'','required type="number" min="0.01" step="0.01" inputmode="decimal" autofocus')}`;
    } else if (kind === 'add' || kind === 'observe') {
      fields = kind === 'add' ? `<p class="meta">建立手工维护的账户，并登记首次窗口读数。</p>
        ${input('label','账户名称','','required autofocus')}<div class="field-pair">
        ${input('service','所属服务','','required list="service-list"')}<datalist id="service-list">${options([...new Set(['Codex','ChatGPT',...state.seats.map(item => item.service)])])}</datalist>
        ${input('unit','额度单位','%','required list="unit-list"')}<datalist id="unit-list"><option>%</option><option>次</option></datalist></div>` :
        `<p>${esc(seat.label)}</p><p class="meta">表内为当前台账估算值，最近采样于 ${stamp(seat.observedAt)}。请对照服务中的实时读数填写，单位为 ${esc(seat.unit)}。</p>`;
      const windows = kind === 'observe' && seat.windows.length ? seat.windows.map(window => {
        const entries = seat.unit === '%' && seat.windows.length > 1 ? [] : state.entries;
        const quota = getQuota({...seat,windows:[window]},entries);
        return {...window,remaining:quota.remaining ?? window.remaining};
      }) : [{}];
      fields += `<div id="windows">${windows.map(windowFields).join('')}</div>${command('add-window',`${icon('plus')} 增加窗口`)}`;
    } else if (kind === 'undo') {
      fields = `<p>撤销 ${esc(seat?.label ?? ref.label ?? ref.seatId)} 的「${esc(kinds[ref.kind])}」？</p><p class="meta">原记录时间 ${stamp(ref.at)}，撤销将另记一条关联流水。</p>`;
    } else if (kind === 'allow') {
      fields = `<p>允许 <strong>${esc(login)}</strong> 以成员身份访问此团队？</p><p class="muted">批准后，该成员可查看团队全部已导入席位的额度、窗口读数和操作台账。</p>`;
    } else if (kind === 'revoke') {
      fields = `<p>撤销 <strong>${esc(login)}</strong> 的成员权限？</p><p class="muted">此人将失去查看团队席位、台账和登记新操作的权限。既有流水会保留。</p>`;
    } else if (original) {
      fields = `<p>${describeAction(original)}</p><p class="meta">原编号 ${esc(original.id)}</p>
        ${original.windows?.map(window => `<p>${esc(window.name)} · ${num(window.remaining)} / ${num(window.capacity)} · ${stamp(window.resetAt)}</p>`).join('') || ''}
        ${original.ref ? `<p class="meta">关联流水 ${esc(original.ref)}</p>` : ''}
        <p>${kind === 'dismiss-action' ? '人工核对完成或决定放弃重试后，可清除此账户在本机的提醒。已入账的操作仍保留在团队流水中。' : '将按此编号和原始内容重新提交。服务端按编号确认同一笔操作。'}</p>`;
    }
    const submitLabel = extraTitles[kind] ?? `${demo ? '模拟' : ''}${({usage:'登记使用',recharge:'登记充值',add:'新增账户',observe:'保存核对',undo:'撤销记录'})[kind]}`;
    content = `<form id="action-form">${fields}<p class="meta">${demo ? '公开演示 · 此操作仅保存在本机' : !original && unresolved.length && kinds[kind] ? '已有操作结果待确认。提交此表单将另记一笔，原操作可在待确认列表中重试。' : ''}</p>
      <p class="error" id="form-error" role="alert"></p><div class="actions form-footer">${command('close','取消')}<button class="btn primary" type="submit">${submitLabel}</button></div></form>`;
  }
  dialogBody.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${command('close',icon('close'),'aria-label="关闭对话框"','icon-button')}</div>${content}`;
  if (!modal.open) modal.showModal();
  const autofocus = dialogBody.querySelector('[autofocus]');
  if (autofocus) autofocus.focus();
}
function collect(form, context) {
  const { kind, id, seatId, ref } = context;
  const data = new FormData(form);
  const action = { id, kind, seatId };
  if (kind === 'observe') action.expectedVersion = context.expectedVersion;
  if (kind === 'undo') return { ...action, ref: ref.id };
  if (kind === 'usage' || kind === 'recharge') {
    const amount = Number(data.get('amount'));
    if (!(amount > 0) || !Number.isFinite(amount)) throw Error('请输入大于零的数量。');
    if (data.get('unit') === '次' && !Number.isInteger(amount)) throw Error('次数应为正整数。');
    return { ...action, amount, unit:data.get('unit') };
  }
  if (kind === 'add') {
    for (const key of ['label','service','unit']) {
      action[key] = String(data.get(key) ?? '').trim();
      if (!action[key]) throw Error('请填写账户名称、服务和单位。');
    }
  }
  action.windows = [...form.querySelectorAll('[data-window]')].map(group => {
    const val = key => group.querySelector(`[name="${key}"]`).value;
    const name = val('window-name').trim();
    const remaining = Number(val('remaining'));
    const capacity = val('capacity') ? Number(val('capacity')) : null;
    const resetAt = val('reset') ? new Date(`${val('reset')}+08:00`) : null;
    if (!name || remaining < 0 || (capacity !== null && (!(capacity > 0) || remaining > capacity)) || (resetAt && !Number.isFinite(resetAt.getTime()))) throw Error('请检查窗口名称、重置时间和读数，剩余量应在零与容量之间。');
    return { name, remaining, capacity, resetAt:resetAt?.toISOString() ?? null };
  });
  if (!action.windows.length) throw Error('至少需要一个额度窗口。');
  if (new Set(action.windows.map(window => window.name)).size !== action.windows.length) throw Error('请为各窗口填写不同的名称。');
  return action;
}
async function submit(event) {
  if (event.target.id !== 'action-form') return;
  event.preventDefault();
  if (busy) return;
  const form = event.target;
  const context = formContext;
  const button = form.querySelector('[type="submit"]');
  const fields = form.querySelectorAll('input,select,[data-cmd="add-window"],[data-cmd="remove-window"]');
  const errorNode = form.querySelector('#form-error');
  let token = version;
  errorNode.textContent = '';
  try {
    if (context.kind === 'dismiss-action') {
      if (!journalOwner) throw Error('请先重新读取团队台账。');
      localStorage.removeItem(journalOwner.prefix + context.original.id);
      unresolved = readJournal(journalOwner);
      modal.close();
      render();
      tell('已结束本机追踪');
      return;
    }
    const access = ['allow','revoke'].includes(context.kind);
    const action = access ? { login:context.login } : context.original ?? collect(form,context);
    busy = true;
    button.disabled = true;
    for (const field of fields) field.disabled = true;
    token = ++version;
    const next = access ? await jsonRequest(`./api/${context.kind}`,action) :
      demo ? await saveDemoAction(action,state) : await postAction(action,Boolean(context.original));
    if (token !== version) return;
    state = validState(next);
    if (demo) state = { ...state, feed:published };
    lastRead = new Date().toISOString();
    refreshError = '';
    if (modal.open && formContext === context) modal.close();
    render();
    tell(access ? (context.kind === 'allow' ? '已批准团队访问' : '已撤销成员访问') : `${demo ? '模拟' : ''}${kinds[action.kind]}已保存`);
  } catch (error) {
    if (token !== version) return;
    let message = error.message || '保存失败，请重试。';
    const original = unresolved.find(item => item.id === (context.original?.id ?? context.id));
    if (original && context.kind !== 'dismiss-action') {
      context.original = original;
      message += ' 结果待确认。可按原编号重试，或关闭后查询流水。';
      button.textContent = '按原编号重试';
    } else {
      const actionKind = context.original?.kind ?? context.kind;
      const conflict = actionKind === 'observe' && (error.status === 409 || /版本|冲突|已变化|已变更|重新核对|有新.*(流水|操作|记录|读数)|其他.*(操作|更新)/.test(message));
      if (conflict) {
        context.conflict = true;
        message += ' 请对照最新读数重新核对。当前输入已保留，载入最新窗口会替换草稿。';
        if (!form.querySelector('[data-cmd="reload-observe"]')) errorNode.insertAdjacentHTML('afterend',command('reload-observe','载入最新窗口重新核对'));
      }
      if (context.kind === 'retry-action') context.rejected = true;
      else if (context.original) { delete context.original; button.textContent = '重新提交'; }
      context.id = newId();
    }
    if (modal.open && formContext === context) errorNode.textContent = message;
    else tell(message);
    render();
  } finally {
    busy = false;
    button.disabled = Boolean(context.conflict || context.rejected);
    for (const field of fields) field.disabled = Boolean(context.original);
  }
}
dialogBody.addEventListener('submit',submit);
modal.addEventListener('click',event => {
  if (event.target === modal && !dialogBody.contains(event.target)) {
    const box = modal.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) modal.close();
  }
});
async function loadFeed() {
  if (!demo) return load();
  const token = ++feedVersion;
  feedLoading = true;
  feedError = '';
  render();
  try {
    const feed = await jsonRequest('./feed.json');
    if (!['news','resets','guides'].every(key => Array.isArray(feed[key]))) throw Error('来源列表格式无效。');
    if (token === feedVersion) published = feed;
  } catch (error) {
    if (token === feedVersion) feedError = `公开来源读取失败：${error.message}`;
  } finally {
    if (token === feedVersion) {
      feedLoading = false;
      if (state) state = { ...state, feed:published };
      render();
    }
  }
}
async function load() {
  if (busy || reading) return;
  reading = true;
  const token = ++version;
  try {
    const incoming = validState(demo ? readDemo() : await jsonRequest('./api/state'));
    if (token !== version) return;
    state = demo ? { ...incoming, feed:published } : incoming;
    lastRead = new Date().toISOString();
    refreshError = '';
    if (!demo) {
      const owner = journalIdentity(incoming);
      if (journalOwner?.prefix !== owner?.prefix) {
        if (modal.open) modal.close();
        dialogBody.replaceChildren();
        formContext = null;
      }
      journalOwner = owner;
      unresolved = [];
      try {
        if (!owner) throw Error('暂未确认本机成员编号，请稍后重新读取。');
        try {
          if (!migrateSession(owner,incoming.entries)) refreshError = '旧会话中有无法确认归属的操作，请在原会话人工核对团队流水。';
        } catch {
          refreshError = '无法读取旧会话的待确认记录，请人工核对团队流水。';
        }
        const count = confirmJournal(owner,incoming.entries);
        if (count) tell(`已在团队流水中确认 ${count} 笔待核对操作`);
      } catch {
        refreshError = owner ? '无法读取本机待确认记录，请先人工核对团队流水。' : '暂未确认本机成员编号，请稍后重新读取。';
      }
    }
    render();
    return true;
  } catch (error) {
    if (token !== version) return;
    if (state && error.status !== 403 && error.status !== 401) {
      refreshError = `刷新失败，当前显示 ${stamp(lastRead)} 读取的状态。${error.message}`;
      render();
      return false;
    }
    showReadError(error);
  } finally { reading = false; }
}
async function reloadObservation() {
  const context = formContext;
  if (!context?.conflict || busy) return;
  const seatId = context.original?.seatId ?? context.seatId;
  const fresh = await load();
  if (!modal.open || formContext !== context) return;
  const seat = state?.seats.find(item => item.id === seatId && !item.archived && item.source === 'manual');
  if (!fresh || !seat) {
    dialogBody.querySelector('#form-error').textContent = fresh ? '该席位目前无法核对。草稿仍保留在此。' : '最新读数读取失败，草稿已保留，请稍后重试。';
    return;
  }
  openDialog('observe',seat);
}
document.addEventListener('click',event => {
  const target = event.target.closest('button[data-cmd]');
  if (!target) return;
  const { cmd, value, ref, login } = target.dataset;
  if (cmd === 'close') { modal.close(); return; }
  if (cmd === 'refresh') { void load(); return; }
  if (cmd === 'retry-feed') { void loadFeed(); return; }
  if (!state) return;
  const entry = state.entries.find(item => item.id === ref);
  const seat = state.seats.find(item => item.id === (target.dataset.seat ?? entry?.seatId));
  switch (cmd) {
    case 'feed': feedTab = value; break;
    case 'ledger': ledgerFilter = value; ledgerLimit = ledgerPageSize; break;
    case 'more-entries': {
      const firstNew = ledgerLimit;
      ledgerLimit += ledgerPageSize;
      render();
      const row = main.querySelectorAll('.ledger-row')[firstNew];
      row?.focus();
      return;
    }
    case 'accounts': accountFilter = value; cardLimit = cardPageSize; break;
    case 'more-cards': cardLimit += cardPageSize; break;
    case 'remove-window': {
      if (dialogBody.querySelectorAll('[data-window]').length <= 1) {
        dialogBody.querySelector('#form-error').textContent = '至少保留一个窗口。'; return;
      }
      target.closest('fieldset').remove();
      dialogBody.querySelector('[data-cmd="add-window"]').focus();
      return;
    }
    case 'add-window': {
      const group = dialogBody.querySelector('#windows');
      group.insertAdjacentHTML('beforeend',windowFields());
      group.lastElementChild.querySelector('input').focus();
      return;
    }
    case 'undo': if (entry) openDialog(cmd,seat,entry); return;
    case 'allow': case 'revoke': if (!demo && state.role === 'owner') openDialog(cmd,null,null,login); return;
    case 'retry-action': case 'dismiss-action': {
      const original = unresolved.find(action => action.id === target.dataset.id);
      if (original) openDialog(cmd,null,null,null,original);
      return;
    }
    case 'reload-observe': void reloadObservation(); return;
    case 'add': openDialog(cmd); return;
    case 'usage': case 'observe': case 'details': case 'recharge':
      if (seat) openDialog(cmd,seat);
      return;
    default: return;
  }
  render();
});
main.addEventListener('change',event => {
  if (event.target.id === 'service') { service = event.target.value; pool = quotaUnit = undefined; }
  else if (event.target.id === 'pool') { service = main.querySelector('#service').value; pool = event.target.value; quotaUnit = undefined; }
  else if (event.target.id === 'quota-unit') { service = main.querySelector('#service').value; pool = main.querySelector('#pool')?.value ?? ''; quotaUnit = event.target.value; }
  else return;
  render();
});
window.addEventListener('hashchange',() => {
  if (modal.open) modal.close();
  ledgerLimit = ledgerPageSize;
  render();
  main.focus({preventScroll:true});
  window.scrollTo(0,0);
});
window.addEventListener('storage',event => {
  if (demo && event.key === storageKey) void load();
  if (!demo && journalOwner && event.storageArea === localStorage &&
      (event.key === null || event.key.startsWith(journalOwner.prefix))) {
    try {
      unresolved = readJournal(journalOwner);
      if (!busy && modal.open && formContext?.original && !unresolved.some(item => item.id === formContext.original.id)) {
        modal.close();
        tell('此操作已在其他标签页处理');
      }
    } catch {
      unresolved = [];
      refreshError = '无法读取本机待确认记录，请先人工核对团队流水。';
    }
    render();
  }
});
document.addEventListener('visibilitychange',() => {
  if (!demo && !document.hidden && !modal.open && !busy && (!lastRead || Date.now() - Date.parse(lastRead) > 45000)) void load();
});
if (!demo) window.setInterval(() => {
  if (!document.hidden && !modal.open && !busy) void load();
},45000);
await load();
if (demo && state) void loadFeed();
