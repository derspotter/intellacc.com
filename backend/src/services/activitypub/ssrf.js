const dns = require('dns').promises;
const net = require('net');

const isPrivateIpv4 = (ip) => {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return true;

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
};

const isPrivateIpv6 = (ip) => {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
  if (normalized.startsWith('fe80:')) return true; // link-local fe80::/10
  return false;
};

const isPrivateIp = (ip) => {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true;
};

const parseAndValidateUrl = (urlString) => {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported URL protocol');
  }

  if (!url.hostname) {
    throw new Error('Invalid URL hostname');
  }

  return url;
};

const assertSsrfSafeUrl = async (urlString, { allowPrivate = false, allowHosts = [] } = {}) => {
  const url = parseAndValidateUrl(urlString);

  const host = url.hostname.toLowerCase();
  if (allowHosts.map((h) => String(h).toLowerCase()).includes(host)) return url;

  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!allowPrivate) throw new Error('SSRF blocked: localhost');
    return url;
  }

  const resolved = await dns.lookup(host, { all: true, verbatim: true });
  if (!resolved || resolved.length === 0) throw new Error('DNS lookup failed');

  if (!allowPrivate) {
    for (const entry of resolved) {
      if (isPrivateIp(entry.address)) {
        throw new Error('SSRF blocked: private address');
      }
    }
  }

  return url;
};

module.exports = {
  assertSsrfSafeUrl
};

