const {
  parseIp,
  buildAsnIndex,
  lookupAsn,
  classifyNetwork,
  parseTorExitList,
  isTorExit
} = require('../src/utils/ipIntel');

// iptoasn.com combined format: range_start\trange_end\tasn\tcountry\tdescription
const FIXTURE_TSV = [
  '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET',
  '1.0.1.0\t1.0.3.255\t0\tNone\tNot routed',
  '80.128.0.0\t80.159.255.255\t3320\tDE\tDTAG Internet service provider operations',
  '88.198.0.0\t88.198.255.255\t24940\tDE\tHETZNER-AS',
  '2a01:4f8::\t2a01:4f8:ffff:ffff:ffff:ffff:ffff:ffff\t24940\tDE\tHETZNER-AS',
  '2a02:8100::\t2a02:8109:ffff:ffff:ffff:ffff:ffff:ffff\t3209\tDE\tVODANET International IP-Backbone of Vodafone'
].join('\n');

describe('ipIntel.parseIp', () => {
  test('parses dotted IPv4 to a 32-bit integer', () => {
    expect(parseIp('1.2.3.4')).toEqual({ version: 4, value: 16909060n });
  });

  test('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(parseIp('::ffff:1.2.3.4')).toEqual({ version: 4, value: 16909060n });
  });

  test('parses compressed IPv6', () => {
    expect(parseIp('2a01:4f8::1')).toEqual({ version: 6, value: 0x2a0104f8000000000000000000000001n });
  });

  test('returns null for garbage', () => {
    expect(parseIp('not-an-ip')).toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('')).toBeNull();
    expect(parseIp(null)).toBeNull();
  });
});

describe('ipIntel.lookupAsn', () => {
  const index = buildAsnIndex(FIXTURE_TSV);

  test('finds the IPv4 range containing an address', () => {
    expect(lookupAsn(index, '80.130.4.9')).toEqual({ asn: 3320, country: 'DE', name: 'DTAG Internet service provider operations' });
    expect(lookupAsn(index, '88.198.10.10')).toEqual({ asn: 24940, country: 'DE', name: 'HETZNER-AS' });
  });

  test('is inclusive at both range ends', () => {
    expect(lookupAsn(index, '1.0.0.0').asn).toBe(13335);
    expect(lookupAsn(index, '1.0.0.255').asn).toBe(13335);
  });

  test('finds IPv6 ranges and IPv4-mapped addresses', () => {
    expect(lookupAsn(index, '2a01:4f8:1:2::3').asn).toBe(24940);
    expect(lookupAsn(index, '2a02:8108:abcd::1').asn).toBe(3209);
    expect(lookupAsn(index, '::ffff:88.198.1.1').asn).toBe(24940);
  });

  test('returns null for unrouted and unknown addresses', () => {
    expect(lookupAsn(index, '1.0.2.7')).toBeNull();
    expect(lookupAsn(index, '9.9.9.9')).toBeNull();
    expect(lookupAsn(index, '2001:db8::1')).toBeNull();
    expect(lookupAsn(index, 'garbage')).toBeNull();
  });

  test('lookup on an empty index is null, not a crash', () => {
    expect(lookupAsn(buildAsnIndex(''), '1.2.3.4')).toBeNull();
    expect(lookupAsn(null, '1.2.3.4')).toBeNull();
  });
});

describe('ipIntel.classifyNetwork', () => {
  test('flags hosting and cloud providers by AS description', () => {
    expect(classifyNetwork('HETZNER-AS')).toBe('hosting');
    expect(classifyNetwork('DIGITALOCEAN-ASN')).toBe('hosting');
    expect(classifyNetwork('AMAZON-02')).toBe('hosting');
    expect(classifyNetwork('OVH SAS')).toBe('hosting');
    expect(classifyNetwork('Contabo GmbH')).toBe('hosting');
    expect(classifyNetwork('Acme Web Hosting Ltd')).toBe('hosting');
    expect(classifyNetwork('Some VPS Provider')).toBe('hosting');
  });

  test('leaves ISPs and mobile carriers unclassified', () => {
    expect(classifyNetwork('DTAG Internet service provider operations')).toBe('unknown');
    expect(classifyNetwork('VODANET International IP-Backbone of Vodafone')).toBe('unknown');
    expect(classifyNetwork('Telefonica Germany GmbH & Co.OHG')).toBe('unknown');
    expect(classifyNetwork('')).toBe('unknown');
    expect(classifyNetwork(null)).toBe('unknown');
  });

  test('matches whole words only', () => {
    expect(classifyNetwork('GHOSTNET Telecom')).toBe('unknown');
  });
});

describe('ipIntel.parseTorExitList', () => {
  test('returns a set of normalised addresses, ignoring blanks and comments', () => {
    const set = parseTorExitList('185.220.101.1\n\n# comment\n2a0b:f4c2::9 \n::ffff:185.220.101.2\n');
    expect(set.size).toBe(3);
    expect(isTorExit(set, '185.220.101.1')).toBe(true);
    expect(isTorExit(set, '::ffff:185.220.101.1')).toBe(true);
    expect(isTorExit(set, '185.220.101.2')).toBe(true);
    expect(isTorExit(set, '2a0b:f4c2::9')).toBe(true);
    expect(isTorExit(set, '2a0b:f4c2:0:0:0:0:0:9')).toBe(true);
    expect(isTorExit(set, '185.220.101.3')).toBe(false);
    expect(isTorExit(set, 'garbage')).toBe(false);
    expect(isTorExit(new Set(), '185.220.101.1')).toBe(false);
  });
});
