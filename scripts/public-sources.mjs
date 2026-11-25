export const newsUrl = 'https://aihot.news/api/v1/hot-topics';
export const resetUrl = 'https://aihot.news/api/v1/codex-resets/recent';
const book = 'https://book.oiloil.org/articles/';
const guides = [
  { key: 'codexBook', url: `${book}unrolling-the-codex-agent-loop`, topic: /Codex/i, service: 'Codex' },
  { key: 'chatBook', url: `${book}how-i-use-llms`, topic: /ChatGPT/i, service: 'ChatGPT' },
];
const privateText = /[\w.+-]+@[\w.-]+|%40|(?:bearer|basic)\s+\S+|(?:api[_-]?key|password|access[_-]?token|authorization|secret)\s*[:=]|(?:sk-|gh[pousr]_|github_pat_|eyJ)[A-Za-z0-9_.-]{8,}/i;

export { clean, guides, publicUrl };

function clean(value) {
  if (typeof value !== 'string' || privateText.test(value) || /[<>]/.test(value)) return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))?$/.test(value)) return undefined;
  if (!Number.isFinite(Date.parse(value))) return undefined;
  const day = value.slice(0, 10);
  return new Date(day).toISOString().startsWith(day) ? value : undefined;
}

function publicUrl(value, section) {
  if (typeof value !== 'string' || privateText.test(value)) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
  if (section === 'guides') return guides.some(guide => guide.url === value) ? value : '';
  const path = url.pathname;
  if (url.hostname === 'aihot.news' && (section === 'news'
    ? /^\/(?:items|story)\/[\w-]+$/.test(path)
    : /^\/codex-reset(?:\/history\/\d{4}-\d\d-\d\d)?\/?$/.test(path))) return url.origin + path;
  if (section === 'resets' && /^(?:x|twitter)\.com$/.test(url.hostname) && /^\/\w+\/status\/\d+$/.test(path)) return url.origin + path;
  return '';
}

export function items(value) {
  if (!Array.isArray(value)) throw new Error('来源格式变化');
  return value;
}

function newsItems(payload) {
  return items(payload.items).map(row => ({
    title: clean(row.title),
    url: publicUrl(row.links?.story, 'news') || publicUrl(row.links?.aihot, 'news'),
    source: 'AIHOT 热点',
    at: date(row.latestAt),
  })).filter(row => row.title && row.url);
}

function resetItems(payload) {
  return items(payload.events).flatMap(event => {
    if (!['direct_reset', 'reset_credit'].includes(event?.type) || !['announced', 'confirmed'].includes(event.status)) return [];
    const posts = Array.isArray(event.posts) ? event.posts : [];
    const url = posts.map(post => publicUrl(post?.url, 'resets')).find(Boolean) || publicUrl(event.url, 'resets');
    const title = clean(event.title);
    if (!url || !title) return [];
    const product = clean(event.presentation?.productsZh) || '适用产品未注明';
    const scope = clean(event.presentation?.scopeLabel) || '适用账户范围未注明';
    const at = event.status === 'confirmed' ? date(event.confirmedAt) || date(event.occurredOn) : date(event.createdAt);
    const item = { title: product !== '适用产品未注明' && !title.includes(product) ? `${product} · ${title}` : title,
      url, source: 'AIHOT 重置监测', status: event.status, at, product,
      summary: `${product}；${scope}。${event.type === 'reset_credit' ? '重置卡发放' : '额度重置'}。` };
    if (event.confirmationBasis === 'receipt_review') item.summary += ' 确认依据为受核实账户的到账记录。';
    if (date(event.confirmedAt)) item.summary += ' 时间为确认消息发布时间。';
    const estimate = event.status === 'announced' && event.estimate;
    if (estimate && (date(estimate.from) || date(estimate.through))) {
      item.forecast = { status: 'forecast', from: date(estimate.from), through: date(estimate.through) };
      item.summary += ` AIHOT 预测窗口：${item.forecast.from || '起点未知'} 至 ${item.forecast.through || '终点未知'}。`;
    }
    return [item];
  });
}

function guideItem(html, guide) {
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const title = clean(visible.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, ''));
  const canonical = visible.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1];
  if (!title || canonical !== guide.url || !guide.topic.test(visible)) throw new Error('书页未核实');
  return [{ title, url: guide.url, source: 'Oil Book', product: guide.service,
    at: date(visible.match(/<meta\b[^>]*property="article:published_time"[^>]*content="([^"]+)"/i)?.[1]) }];
}

export async function request(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}, headers = {}) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error', credentials: 'omit', headers,
  });
  if (response.status !== 304 && !response.ok) throw new Error('来源请求失败');
  return response;
}

function cachedItems(previous, section, guide) {
  if (!Array.isArray(previous?.[section])) return [];
  return previous[section].flatMap(old => {
    const url = publicUrl(old?.url, section);
    if (!url || !clean(old.title) || (guide && url !== guide.url)) return [];
    if (section === 'resets' && !['announced', 'confirmed'].includes(old.status)) return [];
    const item = { title: clean(old.title), url, at: date(old.at),
      source: { news: 'AIHOT 热点', resets: 'AIHOT 重置监测', guides: 'Oil Book' }[section] };
    if (guide) item.product = guide.service;
    if (section === 'resets') {
      Object.assign(item, { product: clean(old.product), summary: clean(old.summary), status: old.status });
      if (old.forecast?.status === 'forecast' && old.status === 'announced') {
        item.forecast = { status: 'forecast', from: date(old.forecast.from), through: date(old.forecast.through) };
      }
    }
    return [item];
  });
}

export async function collectPublicFeed(previous = {}, options = {}) {
  const checkedAt = new Date(options.now ?? Date.now()).toISOString();
  const feed = { news: [], resets: [], guides: [], checkedAt, sources: {}, errors: [] };
  const sources = [
    { key: 'news', section: 'news', url: newsUrl, ttl: 60000, label: 'AIHOT 热点' },
    { key: 'resets', section: 'resets', url: resetUrl, ttl: 600000, label: 'AIHOT 重置监测' },
    ...guides.map(guide => ({ ...guide, section: 'guides', ttl: 3600000, label: `Oil Book（${guide.service}）` })),
  ];
  const results = await Promise.all(sources.map(async source => {
    const { key, section, url, ttl } = source;
    const cached = cachedItems(previous, section, section === 'guides' ? source : null);
    const old = previous?.sources?.[key];
    const lastSuccessAt = date(old?.lastSuccessAt);
    const etag = typeof old?.etag === 'string' && /^(?:W\/)?"[\w.-]{1,100}"$/.test(old.etag) && !privateText.test(old.etag) ? old.etag : undefined;
    const age = Date.parse(checkedAt) - Date.parse(lastSuccessAt);
    const hasCache = !!lastSuccessAt && Array.isArray(previous?.[section]) && (section !== 'guides' || cached.length > 0);
    const resetTime = key === 'resets' ? date(previous?.resetCheckedAt) : undefined;
    const skippedEvents = key === 'resets' && Number.isSafeInteger(old?.skippedEvents) && old.skippedEvents > 0 ? old.skippedEvents : 0;
    if (hasCache && ['ok', 'delayed', 'partial'].includes(old.status) && age >= 0 && age < ttl) {
      return { rows: cached, meta: { status: 'ok', lastSuccessAt, etag }, resetTime, monitorDelayed: old.monitorDelayed === true, skippedEvents };
    }
    try {
      const response = await request(url, options, hasCache && etag ? { 'If-None-Match': etag } : {});
      if (response.status === 304) {
        if (!hasCache) throw new Error('缺少缓存');
        return { rows: cached, meta: { status: 'ok', lastSuccessAt: checkedAt, etag }, resetTime, monitorDelayed: old.monitorDelayed === true, skippedEvents };
      }
      const payload = section === 'guides' ? await response.text() : await response.json();
      if (key === 'resets' && !date(payload.checkedAt)) throw new Error('缺少来源核对时间');
      const rows = key === 'news' ? newsItems(payload) : key === 'resets' ? resetItems(payload) : guideItem(payload, source);
      if (key === 'news' && payload.items.length && !rows.length) throw new Error('来源内容无法核实');
      const validator = response.headers.get('etag');
      return { rows, meta: { status: 'ok', lastSuccessAt: checkedAt,
        etag: typeof validator === 'string' && /^(?:W\/)?"[\w.-]{1,100}"$/.test(validator) && !privateText.test(validator) ? validator : undefined },
        monitorDelayed: key === 'resets' && payload.monitor?.status && payload.monitor.status !== 'healthy',
        skippedEvents: key === 'resets' ? payload.events.length - rows.length : 0,
        resetTime: key === 'resets' ? date(payload.checkedAt) : undefined };
    } catch {
      return { rows: hasCache ? cached : [], meta: { status: hasCache ? 'stale' : 'unavailable', lastSuccessAt, etag,
        ...(old?.monitorDelayed === true ? { monitorDelayed: true } : {}) }, resetTime, skippedEvents };
    }
  }));
  for (const [index, result] of results.entries()) {
    const source = sources[index];
    feed[source.section].push(...result.rows);
    feed.sources[source.key] = result.meta;
    if (result.resetTime) feed.resetCheckedAt = result.resetTime;
    if (result.monitorDelayed) {
      feed.sources[source.key].status = 'delayed';
      feed.sources[source.key].monitorDelayed = true;
      feed.errors.push('AIHOT 重置监测核查延迟，当前显示最近核实的结果。');
    }
    if (result.resetTime && result.meta.status === 'ok' && Date.parse(checkedAt) - Date.parse(result.resetTime) > 1800000) {
      feed.errors.push('AIHOT 最近成功核对重置的时间已超过 30 分钟。');
    }
    if (result.skippedEvents) {
      result.meta.skippedEvents = result.skippedEvents;
      if (result.meta.status === 'ok') result.meta.status = 'partial';
      feed.errors.push(`AIHOT 重置监测有 ${result.skippedEvents} 条事件未能核实，已跳过。`);
    }
    if (['stale', 'unavailable'].includes(result.meta.status)) feed.errors.push(`${source.label}核对失败，${result.meta.status === 'stale' ? '显示上次成功结果' : '暂无已核实数据'}。`);
  }
  return feed;
}
