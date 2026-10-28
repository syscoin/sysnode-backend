'use strict';

// This subprocess may call only its synthetic loopback node. Loading the full
// backend or its Syscoin/database workers is also a test failure.
const Module = require('module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'better-sqlite3' || /(?:^|\/)services\/(?:sysMain|masternodeTracker|rpcClient)$/.test(name) ||
      /(?:^|\/)server\.js$/.test(name)) throw new Error('unexpected full backend import');
  return load.call(this, name, ...args);
};
const http = require('http');
const https = require('https');
const request = http.request;
http.request = function (options, ...args) {
  const host = typeof options === 'string' ? new URL(options).hostname : options.hostname || options.host;
  if (host !== '127.0.0.1') throw new Error('non-loopback network request');
  return request.call(this, options, ...args);
};
https.request = () => { throw new Error('external HTTPS request'); };
