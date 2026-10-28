'use strict';

// HTTP is permitted only for an explicitly named loopback endpoint. Check the
// raw authority as well as the parsed hostname: WHATWG URL canonicalizes short
// and numeric IPv4 forms, which must not become implicit aliases here. Map
// localhost to a literal before connecting, so DNS cannot redirect it.
function privacyRpcUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('privacy_rpc_url_invalid'); }
  if (url.username || url.password || url.hash) throw new Error('privacy_rpc_url_invalid');
  const localHttp = url.protocol === 'http:' && typeof value === 'string' &&
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+(?:[/?]|$)/i.test(value) &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') && Boolean(url.port);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('privacy_rpc_url_invalid');
  if (localHttp && url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return { url, localHttp };
}

module.exports = { privacyRpcUrl };
