'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const { isIP, BlockList } = require('node:net');
const { POOLS } = require('./privacyRegistry');
const { address } = require('./privacyRelayerRegistry');
const MAX_STATUS_BYTES = 64 * 1024;
const STATUS_TIMEOUT_MS = 5000;
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, bits, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(ip, bits, 'ipv6');
function publicAddress(ip) {
  const family = isIP(ip);
  return family === 4 ? !blocked.check(ip, 'ipv4') : family === 6 && global6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) throw new Error('privacy_relayer_endpoint_invalid');
  let url;
  // Classic ENS records may contain a bare DNS hostname. Accept only that
  // narrow form and apply the same HTTPS and hostname checks as an origin.
  const normalized = /^[a-z0-9.-]+$/i.test(value) ? `https://${value}` : value;
  try { url = new URL(normalized); } catch (_) { throw new Error('privacy_relayer_endpoint_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== '/' || isIP(url.hostname) || url.hostname.startsWith('[') || url.hostname.length > 253 ||
      !url.hostname.includes('.') || url.hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('privacy_relayer_endpoint_invalid');
  return url.origin;
}
function parseStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.netId !== 1 ||
      !raw.instances || typeof raw.instances !== 'object' || Object.keys(raw.instances).length > 32) throw new Error('privacy_relayer_status_invalid');
  const eth = raw.instances.eth;
  if (!eth || eth.decimals !== 18 || !eth.instanceAddress || typeof eth.instanceAddress !== 'object' ||
      Array.isArray(eth.instanceAddress) || Object.keys(eth.instanceAddress).length > 32) throw new Error('privacy_relayer_status_invalid');
  const supportedPools = [];
  // Never publish an endpoint-supplied contract. The address must match the
  // fixed Classic ETH pool for that denomination; other assets are ignored.
  for (const pool of POOLS) {
    const denom = pool.id.slice(4);
    if (Object.hasOwn(eth.instanceAddress, denom)) {
      if (address(eth.instanceAddress[denom]) !== pool.address) throw new Error('privacy_relayer_status_invalid');
      supportedPools.push(pool.id);
    }
  }
  const fee = raw.tornadoServiceFee;
  if ((typeof fee !== 'string' && typeof fee !== 'number') ||
      !/^(?:(?:0|[1-9][0-9]?)(?:\.[0-9]{1,18})?|100(?:\.0{1,18})?)$/.test(String(fee)) || !supportedPools.length) throw new Error('privacy_relayer_status_invalid');
  const h = raw.health?.status;
  if (![true, false, 'true', 'false'].includes(h)) throw new Error('privacy_relayer_status_invalid');
  if (!Number.isSafeInteger(raw.currentQueue) || raw.currentQueue < 0 || raw.currentQueue > 1000000 ||
      typeof raw.version !== 'string' || raw.version.length > 64 || !/^[a-zA-Z0-9.+_-]+$/.test(raw.version)) throw new Error('privacy_relayer_status_invalid');
  return { rewardAccount: address(raw.rewardAccount), supportedPools, serviceFeePercent: String(fee),
    reportedHealthy: h === true || h === 'true', queueLength: raw.currentQueue, version: raw.version };
}
function createPrivacyRelayerStatus({ lookup = dns.lookup, request = https.request, now = Date.now } = {}) {
  return async function inspect(value, context = {}) {
    const origin = endpoint(value);
    const host = new URL(origin).hostname;
    context.beforeRequest?.();
    // This deadline includes DNS, TLS and response bytes, rather than only socket
    // inactivity. Native HTTPS never consults HTTP(S)_PROXY environment values.
    let timer, req, response;
    let expired = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; response?.destroy(); req?.destroy(); reject(new Error('privacy_relayer_status_timeout')); }, STATUS_TIMEOUT_MS);
    });
    const run = async () => {
      const answers = await lookup(host, { all: true, verbatim: true });
      if (expired) throw new Error('privacy_relayer_status_timeout');
      if (!Array.isArray(answers) || !answers.length || answers.length > 8 || answers.some((a) =>
        !a || !publicAddress(a.address) || isIP(a.address) !== a.family)) throw new Error('privacy_relayer_dns_rejected');
      context.beforeRequest?.();
      // All answers were checked. Pin one immutable answer; the connect cannot
      // perform a second DNS lookup or follow a redirect to a private address.
      const chosen = { address: answers[0].address, family: answers[0].family };
      const raw = await new Promise((resolve, reject) => {
        req = request({ protocol: 'https:', hostname: host, servername: host, port: 443, method: 'GET', path: '/status',
          agent: false, rejectUnauthorized: true, maxHeaderSize: 8192,
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
          lookup: (_name, options, cb) => typeof options === 'function' ? options(null, chosen.address, chosen.family) :
            options?.all ? cb(null, [{ ...chosen }]) : cb(null, chosen.address, chosen.family),
        }, (res) => {
          response = res;
          if (res.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] || '') ||
              (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
              (res.headers['content-length'] && (!/^\d+$/.test(res.headers['content-length']) || Number(res.headers['content-length']) > MAX_STATUS_BYTES))) {
            res.destroy(); reject(new Error('privacy_relayer_status_rejected')); return;
          }
          let size = 0; const parts = [];
          res.on('data', (part) => {
            size += part.length;
            if (size > MAX_STATUS_BYTES) { res.destroy(); reject(new Error('privacy_relayer_status_too_large')); }
            else parts.push(part);
          });
          res.on('error', () => reject(new Error('privacy_relayer_status_unavailable')));
          res.on('aborted', () => reject(new Error('privacy_relayer_status_unavailable')));
          res.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
            catch (_) { reject(new Error('privacy_relayer_status_invalid')); }
          });
        });
        req.on('error', () => reject(new Error('privacy_relayer_status_unavailable')));
        req.end();
      });
      return { origin, ...parseStatus(raw), observedAt: now() };
    };
    try { return await Promise.race([run(), timeout]); }
    finally { clearTimeout(timer); }
  };
}
module.exports = { createPrivacyRelayerStatus, publicAddress, endpoint, parseStatus, MAX_STATUS_BYTES, STATUS_TIMEOUT_MS };
