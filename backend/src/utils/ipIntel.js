// Pure, offline IP intelligence helpers for the registration approval email.
//
// Data sources (fetched by services/ipIntelService, never queried per-request):
//   - iptoasn.com combined TSV: range_start\trange_end\tasn\tcountry\tdescription
//   - Tor Project bulk exit list: one address per line
//
// Nothing here talks to the network, so it is safe in jest and cheap to call.

const IPV4_MAX = (1n << 32n) - 1n;

const parseIpv4 = (text) => {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
};

const parseIpv6 = (text) => {
  let head = text;
  let tail = '';
  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1) {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null;
    head = text.slice(0, doubleColon);
    tail = text.slice(doubleColon + 2);
  }

  const expand = (segment) => {
    if (segment === '') return [];
    const groups = segment.split(':');
    const out = [];
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      // Embedded IPv4 in the last position (e.g. ::ffff:1.2.3.4)
      if (group.includes('.') && i === groups.length - 1) {
        const v4 = parseIpv4(group);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const headGroups = expand(head);
  const tailGroups = expand(tail);
  if (headGroups === null || tailGroups === null) return null;

  const total = headGroups.length + tailGroups.length;
  if (doubleColon === -1 && total !== 8) return null;
  if (doubleColon !== -1 && total > 7) return null;

  const groups = doubleColon === -1
    ? headGroups
    : [...headGroups, ...new Array(8 - total).fill(0), ...tailGroups];

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
};

// -> { version: 4 | 6, value: bigint } | null. IPv4-mapped IPv6 collapses to v4
// so that "::ffff:1.2.3.4" (what Node reports on dual-stack sockets) matches
// the IPv4 ranges.
const parseIp = (input) => {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  if (!text.includes(':')) {
    const v4 = parseIpv4(text);
    return v4 === null ? null : { version: 4, value: v4 };
  }

  const v6 = parseIpv6(text);
  if (v6 === null) return null;
  // ::ffff:a.b.c.d  ->  the upper 96 bits are 0x0000...ffff
  if ((v6 >> 32n) === 0xffffn) {
    return { version: 4, value: v6 & IPV4_MAX };
  }
  return { version: 6, value: v6 };
};

// Builds a binary-searchable index from the iptoasn TSV text.
//
// Memory matters: the combined file has ~580k ranges and lives in the backend
// process for as long as it runs. Ranges are therefore stored in typed
// arrays (IPv4: Uint32 start/end; IPv6: BigUint64 hi/lo pairs), country codes
// as indices into a small string table and AS names once per ASN. That keeps
// the whole index around 15 MB instead of ~250 MB of per-range objects.
// Unrouted rows (asn 0) are dropped. Input is expected sorted (iptoasn is);
// an unsorted input is sorted before packing.
const buildAsnIndex = (tsvText) => {
  const v4 = { start: [], end: [], asn: [], country: [] };
  const v6 = { start: [], end: [], asn: [], country: [] };
  const countries = [];
  const countryIndex = new Map();
  const names = new Map();

  // V8 substrings are slices that pin their parent. Anything kept past this
  // function must be copied flat, or the entire TSV text stays in memory.
  const flat = (text) => Buffer.from(text, 'utf8').toString('utf8');

  const countryId = (code) => {
    const key = code === 'None' ? '' : code;
    let id = countryIndex.get(key);
    if (id === undefined) {
      id = countries.length;
      const copy = flat(key);
      countries.push(copy);
      countryIndex.set(copy, id);
    }
    return id;
  };

  const lines = String(tsvText || '').split('\n');
  for (const line of lines) {
    if (!line || line.charCodeAt(0) === 35) continue; // '#'
    const cols = line.split('\t');
    if (cols.length < 5) continue;
    const asn = Number(cols[2]);
    if (!Number.isFinite(asn) || asn <= 0) continue;
    const start = parseIp(cols[0]);
    const end = parseIp(cols[1]);
    if (!start || !end || start.version !== end.version) continue;
    const bucket = start.version === 4 ? v4 : v6;
    bucket.start.push(start.value);
    bucket.end.push(end.value);
    bucket.asn.push(asn);
    bucket.country.push(countryId(cols[3]));
    if (!names.has(asn)) names.set(asn, flat(cols.slice(4).join('\t').trim()));
  }

  const order = (bucket) => {
    const n = bucket.start.length;
    let sorted = true;
    for (let i = 1; i < n && sorted; i += 1) {
      if (bucket.start[i] < bucket.start[i - 1]) sorted = false;
    }
    if (sorted) return null;
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => (bucket.start[a] < bucket.start[b] ? -1 : bucket.start[a] > bucket.start[b] ? 1 : 0));
    return idx;
  };

  const pack4 = (bucket) => {
    const idx = order(bucket);
    const n = bucket.start.length;
    const out = {
      start: new Uint32Array(n),
      end: new Uint32Array(n),
      asn: new Uint32Array(n),
      country: new Uint16Array(n)
    };
    for (let i = 0; i < n; i += 1) {
      const j = idx ? idx[i] : i;
      out.start[i] = Number(bucket.start[j]);
      out.end[i] = Number(bucket.end[j]);
      out.asn[i] = bucket.asn[j];
      out.country[i] = bucket.country[j];
    }
    return out;
  };

  const MASK64 = (1n << 64n) - 1n;
  const pack6 = (bucket) => {
    const idx = order(bucket);
    const n = bucket.start.length;
    const out = {
      startHi: new BigUint64Array(n),
      startLo: new BigUint64Array(n),
      endHi: new BigUint64Array(n),
      endLo: new BigUint64Array(n),
      asn: new Uint32Array(n),
      country: new Uint16Array(n)
    };
    for (let i = 0; i < n; i += 1) {
      const j = idx ? idx[i] : i;
      out.startHi[i] = bucket.start[j] >> 64n;
      out.startLo[i] = bucket.start[j] & MASK64;
      out.endHi[i] = bucket.end[j] >> 64n;
      out.endLo[i] = bucket.end[j] & MASK64;
      out.asn[i] = bucket.asn[j];
      out.country[i] = bucket.country[j];
    }
    return out;
  };

  const packed4 = pack4(v4);
  const packed6 = pack6(v6);
  return { v4: packed4, v6: packed6, countries, names, size: packed4.start.length + packed6.startHi.length };
};

const find4 = (ranges, value) => {
  const target = Number(value);
  let lo = 0;
  let hi = ranges.start.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (target < ranges.start[mid]) {
      hi = mid - 1;
    } else if (target > ranges.end[mid]) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
};

const find6 = (ranges, value) => {
  const MASK64 = (1n << 64n) - 1n;
  const tHi = value >> 64n;
  const tLo = value & MASK64;
  const less = (aHi, aLo, bHi, bLo) => aHi < bHi || (aHi === bHi && aLo < bLo);
  let lo = 0;
  let hi = ranges.startHi.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (less(tHi, tLo, ranges.startHi[mid], ranges.startLo[mid])) {
      hi = mid - 1;
    } else if (less(ranges.endHi[mid], ranges.endLo[mid], tHi, tLo)) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
};

// -> { asn, country, name } | null
const lookupAsn = (index, ip) => {
  if (!index) return null;
  const parsed = parseIp(ip);
  if (!parsed) return null;
  const ranges = parsed.version === 4 ? index.v4 : index.v6;
  if (!ranges) return null;
  const i = parsed.version === 4 ? find4(ranges, parsed.value) : find6(ranges, parsed.value);
  if (i < 0) return null;
  const asn = ranges.asn[i];
  return {
    asn,
    country: index.countries[ranges.country[i]] || null,
    name: index.names.get(asn) || ''
  };
};

// Heuristic: hosting/cloud/VPS operators by AS description. Word-boundary
// matching so "GHOSTNET" does not trip on HOST. Deliberately a hint for the
// human reviewer, not a block rule.
const HOSTING_PATTERN = new RegExp(
  '\\b(' + [
    'HOSTING', 'HOSTED', 'HOST', 'HOSTS', 'CLOUD', 'DATACENTER', 'DATACENTRE',
    'DATA CENTER', 'DATA CENTRE', 'SERVER', 'SERVERS', 'VPS', 'DEDICATED',
    'COLO', 'COLOCATION',
    'AMAZON', 'AWS', 'GOOGLE', 'MICROSOFT', 'AZURE', 'ORACLE', 'ALIBABA',
    'TENCENT', 'DIGITALOCEAN', 'HETZNER', 'OVH', 'LINODE', 'AKAMAI', 'VULTR',
    'CHOOPA', 'CONTABO', 'LEASEWEB', 'SCALEWAY', 'IONOS', 'NETCUP', 'M247',
    'HOSTINGER', 'GODADDY', 'NAMECHEAP', 'WORLDSTREAM', 'DATACAMP', 'ZENLAYER',
    'HIVELOCITY', 'PSYCHZ', 'QUADRANET', 'FRANTECH', 'BUYVM', 'SERVERMANIA',
    'PACKETHUB', 'CLOUDFLARENET', 'FASTLY', 'LIMESTONE', 'DACENTEC', 'IPXO',
    'KAMATERA', 'UPCLOUD', 'EXOSCALE', 'GCORE', 'G-CORE', 'STACKPATH'
  ].join('|') + ')\\b',
  'i'
);

// -> 'hosting' | 'unknown'
const classifyNetwork = (asName) => {
  if (typeof asName !== 'string' || !asName.trim()) return 'unknown';
  return HOSTING_PATTERN.test(asName) ? 'hosting' : 'unknown';
};

const normaliseAddress = (ip) => {
  const parsed = parseIp(ip);
  if (!parsed) return null;
  if (parsed.version === 4) {
    const v = parsed.value;
    return [v >> 24n, (v >> 16n) & 0xffn, (v >> 8n) & 0xffn, v & 0xffn].map(String).join('.');
  }
  // Canonical lowercase hex without zero-compression is enough for set equality.
  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((parsed.value >> shift) & 0xffffn).toString(16));
  }
  return groups.join(':');
};

// -> Set of canonical addresses
const parseTorExitList = (text) => {
  const set = new Set();
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const canonical = normaliseAddress(line);
    if (canonical) set.add(canonical);
  }
  return set;
};

const isTorExit = (torSet, ip) => {
  if (!torSet || torSet.size === 0) return false;
  const canonical = normaliseAddress(ip);
  return canonical ? torSet.has(canonical) : false;
};

module.exports = {
  parseIp,
  buildAsnIndex,
  lookupAsn,
  classifyNetwork,
  parseTorExitList,
  isTorExit,
  normaliseAddress
};
