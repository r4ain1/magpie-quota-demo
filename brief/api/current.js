import { Buffer } from 'node:buffer';

const rawUrl = 'https://raw.githubusercontent.com/r4ain1/magpie-quota-demo/refs/tags/brief-current/current.json';
const contentsUrl = 'https://api.github.com/repos/r4ain1/magpie-quota-demo/contents/current.json?ref=brief-current';
const maxBytes = 256 * 1024;

function canonicalBase64url(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

async function readEnvelope(response) {
  if (Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    throw new Error('invalid-size');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('invalid-size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const envelope = JSON.parse(text);
  if (envelope?.v !== 1 || Object.keys(envelope).length !== 3
      || !canonicalBase64url(envelope.iv) || envelope.iv.length !== 16
      || !canonicalBase64url(envelope.data) || envelope.data.length < 22
      || text.split(':', 5).length !== 4) {
    throw new Error('invalid-envelope');
  }
  return bytes;
}

async function loadSnapshot(name, url, accept, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let failure = 'network';
  try {
    const response = await fetch(url, {
      headers: { Accept: accept, 'User-Agent': 'magpie-brief-transport' },
      redirect: 'error',
      signal: controller.signal
    });
    if (response.status !== 200) {
      failure = `http-${response.status}`;
      return { missing: response.status === 404 };
    }
    failure = 'invalid-or-interrupted-body';
    const bytes = await readEnvelope(response);
    failure = '';
    return { bytes };
  } catch {
    return {};
  } finally {
    if (failure) console.warn('brief snapshot upstream', name, controller.signal.aborted ? 'timeout' : failure);
    clearTimeout(timer);
    controller.abort();
  }
}

export default async function current(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (status, error) => {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error }));
  };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return fail(405, 'method_not_allowed');
  }
  if (request.url.includes('?')) return fail(400, 'query_not_supported');
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.statusCode = 204;
    return response.end();
  }
  const minute = Math.floor(Date.now() / 60_000);
  const raw = await loadSnapshot('raw', `${rawUrl}?minute=${minute}`, 'application/json', 2500);
  const snapshot = raw.bytes ? raw : await loadSnapshot('contents', contentsUrl, 'application/vnd.github.raw+json', 3500);
  if (!snapshot.bytes) {
    if (raw.missing && snapshot.missing) return fail(404, 'snapshot_not_found');
    response.setHeader('Retry-After', '15');
    return fail(502, 'snapshot_upstream_unavailable');
  }
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', snapshot.bytes.length);
  response.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30');
  response.end(request.method === 'HEAD' ? undefined : snapshot.bytes);
}
