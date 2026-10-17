const fs = require('fs');
const path = require('path');

test('the same-origin deployment forwards Sentry context and management paths without stripping their prefix', () => {
  const nginx = fs.readFileSync(path.join(__dirname, '../deploy/nginx/sysnode.conf.example'), 'utf8');
  const sentry = nginx.match(/location\s+\/api\/sentry\/v1\/\s*\{([^}]+)\}/);
  expect(sentry).not.toBeNull();
  expect(sentry[1]).toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:3001\s*;/);
  expect(sentry[1]).toMatch(/include\s+\/etc\/nginx\/snippets\/sysnode-proxy\.conf\s*;/);
  expect(nginx).toMatch(/location\s+\/\s*\{\s*proxy_pass\s+http:\/\/127\.0\.0\.1:3000\s*;/);
});
