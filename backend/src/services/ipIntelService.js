// Offline IP intelligence for the registration approval email.
//
// Keeps two public datasets on local disk and in memory; NO per-signup network
// calls, so a visitor's address never leaves this server:
//   - iptoasn.com combined ranges (country + AS number + AS name)
//   - Tor Project bulk exit list
// Refreshed in the background (startRefreshLoop) at most once per
// IP_INTEL_MAX_AGE_HOURS. Lookups are synchronous binary searches.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  buildAsnIndex,
  lookupAsn,
  classifyNetwork,
  parseTorExitList,
  isTorExit
} = require('../utils/ipIntel');

const ASN_URL = process.env.IP_INTEL_ASN_URL || 'https://iptoasn.com/data/ip2asn-combined.tsv.gz';
const TOR_URL = process.env.IP_INTEL_TOR_URL || 'https://check.torproject.org/torbulkexitlist';
const DATA_DIR = process.env.IP_INTEL_DATA_DIR || path.join(__dirname, '..', '..', 'data', 'ip-intel');
const MAX_AGE_HOURS = Number(process.env.IP_INTEL_MAX_AGE_HOURS) > 0 ? Number(process.env.IP_INTEL_MAX_AGE_HOURS) : 24;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

const ASN_FILE = path.join(DATA_DIR, 'ip2asn-combined.tsv');
const TOR_FILE = path.join(DATA_DIR, 'tor-exits.txt');

const state = {
  asnIndex: null,
  torSet: null,
  loadedAt: null,
  refreshTimer: null
};

const loadFromStrings = ({ asnTsv = '', torText = '' } = {}) => {
  state.asnIndex = buildAsnIndex(asnTsv);
  state.torSet = parseTorExitList(torText);
  state.loadedAt = new Date();
  return { ranges: state.asnIndex.size, torExits: state.torSet.size };
};

const readIfExists = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

const loadFromDisk = () => {
  const asnTsv = readIfExists(ASN_FILE);
  const torText = readIfExists(TOR_FILE);
  if (asnTsv === null && torText === null) return null;
  return loadFromStrings({ asnTsv: asnTsv || '', torText: torText || '' });
};

const fileAgeHours = (file) => {
  try {
    return (Date.now() - fs.statSync(file).mtimeMs) / (60 * 60 * 1000);
  } catch (err) {
    return Infinity;
  }
};

const download = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'intellacc-ip-intel/1.0' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return url.endsWith('.gz') ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
};

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};

// Downloads whichever file is missing or older than MAX_AGE_HOURS, then
// (re)loads both into memory. Best-effort: a failed download keeps the last
// good file and the last good in-memory data.
const refresh = async ({ force = false } = {}) => {
  const jobs = [
    { url: ASN_URL, file: ASN_FILE, label: 'asn', minLength: 1000 },
    { url: TOR_URL, file: TOR_FILE, label: 'tor', minLength: 7 }
  ];
  const outcome = {};
  for (const job of jobs) {
    if (!force && fileAgeHours(job.file) < MAX_AGE_HOURS) {
      outcome[job.label] = 'fresh';
      continue;
    }
    try {
      const text = await download(job.url);
      if (text.length < job.minLength) throw new Error(`${job.label} payload too small (${text.length} bytes)`);
      writeAtomic(job.file, text);
      outcome[job.label] = 'downloaded';
    } catch (err) {
      outcome[job.label] = `failed: ${err.message}`;
      console.warn(`[IpIntel] ${job.label} refresh failed: ${err.message}`);
    }
  }
  const loaded = loadFromDisk();
  if (loaded) {
    console.log(`[IpIntel] loaded ${loaded.ranges} ranges, ${loaded.torExits} tor exits (${JSON.stringify(outcome)})`);
  }
  return { ...outcome, loaded };
};

const startRefreshLoop = ({ intervalMs = 6 * 60 * 60 * 1000 } = {}) => {
  if (state.refreshTimer) return;
  const tick = () => refresh().catch((err) => console.warn('[IpIntel] refresh error:', err.message));
  tick();
  state.refreshTimer = setInterval(tick, intervalMs);
  if (state.refreshTimer.unref) state.refreshTimer.unref();
};

const stopRefreshLoop = () => {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
};

// -> { available, asn, country, name, networkType, torExit }
const lookup = (ip) => {
  if (!state.asnIndex && !state.torSet) {
    return { available: false, asn: null, country: null, name: null, networkType: 'unknown', torExit: false };
  }
  const asnInfo = lookupAsn(state.asnIndex, ip);
  return {
    available: true,
    asn: asnInfo?.asn ?? null,
    country: asnInfo?.country ?? null,
    name: asnInfo?.name ?? null,
    networkType: classifyNetwork(asnInfo?.name),
    torExit: isTorExit(state.torSet, ip)
  };
};

const status = () => ({
  loadedAt: state.loadedAt,
  ranges: state.asnIndex?.size ?? 0,
  torExits: state.torSet?.size ?? 0,
  asnFileAgeHours: fileAgeHours(ASN_FILE),
  torFileAgeHours: fileAgeHours(TOR_FILE),
  dataDir: DATA_DIR
});

module.exports = {
  loadFromStrings,
  loadFromDisk,
  refresh,
  startRefreshLoop,
  stopRefreshLoop,
  lookup,
  status
};
