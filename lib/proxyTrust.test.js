const proxyaddr = require('proxy-addr');
const { Address4, Address6 } = require('ip-address');

describe('proxy trust boundary', () => {
  const request = (remoteAddress, forwarded) => ({
    socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded },
  });
  test('a malformed mapped-IPv6 trust subnet cannot trust every IPv4 client', () => {
    const trust = proxyaddr.compile('::ffff:10.0.0.0/8');
    expect(trust('8.8.8.8')).toBe(false);
    expect(proxyaddr(request('8.8.8.8', '127.0.0.1'), trust)).toBe('8.8.8.8');
  });
  test('normal IPv4 and loopback proxy boundaries still work', () => {
    const trust = proxyaddr.compile(['10.0.0.0/8', 'loopback']);
    expect(proxyaddr(request('10.1.2.3', '203.0.113.9'), trust)).toBe('203.0.113.9');
    expect(proxyaddr(request('127.0.0.1', '203.0.113.9'), trust)).toBe('203.0.113.9');
    expect(proxyaddr(request('8.8.8.8', '127.0.0.1'), trust)).toBe('8.8.8.8');
  });
  test('address parsing rejects octal-ambiguous IPv4 and cross-family subnets', () => {
    expect(() => new Address4('012.0.0.1')).toThrow();
    expect(new Address4('10.1.2.3').isInSubnet(new Address6('::/0'))).toBe(false);
  });
});
