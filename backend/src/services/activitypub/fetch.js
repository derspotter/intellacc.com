const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

const readLimitedText = async (res, maxBytes) => {
  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error('Response too large');
  }

  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Response too large');
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error('Response too large');
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
};

const fetchJson = async (url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, method = 'GET', body } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });

    const text = await readLimitedText(res, maxBytes);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Invalid JSON');
    }

    return { res, json, text };
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = {
  fetchJson
};

