# sysnode-backend

Express API behind [sysnode.info](https://sysnode.info). Aggregates Syscoin Core RPC + Blockbook + masternode telemetry + a small authenticated subsystem for governance proposal drafts, vote reminders, and "Pay-with-Pali" collateral flows.

The public dashboard is served by [sysnode-info](https://github.com/syscoin/sysnode-info); this repo is the backend half of that stack.

## Runtime surface

Public, unauthenticated routes (read-only). Canonical URL casing is
**lowercase**, matching the historical `https://syscoin.dev/mnstats`
convention and the existing `/govlist`. Express's default routing is
case-insensitive, so legacy camelCase callers (`/mnStats`, `/mnList`,
…) continue to work at the route layer; the bundled nginx config
(`deploy/nginx/sysnode.conf.example`) uses a case-insensitive regex
match for the same reason, so external bookmarks/clients with mixed
casing keep working through the same-origin proxy. New integrations
should use lowercase.

- `GET  /mnstats` — chain + market + masternode summary, refreshed by `services/sysMain.js`
- `GET  /mncount` — historical masternode count series
- `GET  /mnlist` — fresh `masternode_list` RPC passthrough
- `POST /mnsearch` — paginated/searched view over the in-memory tracker snapshot
- `POST /govlist` — active + historical governance proposals (Syscoin Core `gobject list`)

Authenticated routes (cookie + CSRF, same-site):

- `/auth/*` — registration, verification, login, session, delete account
- `/vault` — encrypted per-user blob (notification prefs, proposal drafts; one row per user, conditional GET/PUT with ETag)
- `/gov/*` — masternode lookup, vote relay, vote receipts (`/gov/mns/lookup`, `/gov/vote`, `/gov/receipts`, …)
- `/gov/proposals/*` — governance proposal wizard, submissions, collateral PSBT

## Requirements

- Node.js 20 LTS (engines in `package.json` gate Node ≥ 20, < 24)
- A reachable `syscoind` on mainnet or testnet, with RPC enabled
- SMTP server for verification emails and vote reminders (or `MAIL_TRANSPORT=log` for dry-run)
- SQLite 3 (via `better-sqlite3`, no separate install; native module compiles at `npm install`)

Optional, used only for the Pali PSBT collateral path:

- A Blockbook instance for the same network as the RPC node (`https://blockbook.syscoin.org/` for mainnet, `https://blockbook-dev.syscoin.org/` for testnet)

## Local development

```bash
git clone https://github.com/syscoin/sysnode-backend.git
cd sysnode-backend
npm ci
cp .env.example .env        # then edit — see .env.example for inline docs
npm run dev                 # nodemon on :3001
npm test                    # full jest suite (~830 cases)
npm run audit:prod          # fail on critical production dependency issues
```

## Dependency Audit Triage

`npm run audit:prod` is wired into CI and fails on critical production
vulnerabilities. As of this update, the remaining production audit findings are
known transitive issues under `syscoinjs-lib`'s Ethereum proof stack
(`eth-proof` / `isomorphic-fetch` / `node-fetch` and `ethers` v5 helpers).
`npm audit fix --force` proposes changing `syscoinjs-lib` through a breaking
path, so that risk is tracked separately instead of forced into a dependency
maintenance PR.

`pm2` is intentionally not an application dependency. If you use it for process
supervision, install it globally or through your host image, as shown in the
single-host deployment notes below.

## Configuration

All configuration is via environment variables. `.env.example` is the source of truth and carries inline rationale for every field. The short form:

| Variable | Purpose |
| --- | --- |
| `PORT`, `BASE_URL` | Where the server listens, and the public URL baked into email links |
| `CORS_ORIGIN`, `FRONTEND_URL` | SPA origin for credentialed CORS and verification-link base |
| `TRUST_PROXY` | Reverse-proxy hop count (or CIDR) so `req.ip` is the real client |
| `SYSNODE_DB_PATH` | Path to the SQLite file (auto-created) |
| `SYSNODE_AUTH_PEPPER` | 32-byte hex secret; **required in production** |
| `SMTP_*`, `MAIL_FROM`, `MAIL_TRANSPORT` | Mail delivery; `MAIL_TRANSPORT=log` prints to stdout |
| `SYSCOIN_RPC_HOST`, `SYSCOIN_RPC_PORT` | RPC endpoint (default `127.0.0.1:8370`) |
| `SYSCOIN_RPC_COOKIE_PATH` | **Preferred** — absolute path to Core's `.cookie` for same-host deployments |
| `SYSCOIN_RPC_USER`, `SYSCOIN_RPC_PASS` | Fallback static creds for remote RPC nodes |
| `SYSCOIN_NETWORK`, `SYSCOIN_BLOCKBOOK_URL` | Enables the Pay-with-Pali collateral PSBT path |

## Production authenticated deployment

Real voting-key custody should use a same-origin deployment for the authenticated API surface. Serve the SPA and proxy `/auth`, `/vault`, and `/gov` from the same public HTTPS origin:

```text
https://sysnode.info/        -> sysnode-info build
https://sysnode.info/auth/*  -> sysnode-backend
https://sysnode.info/vault/* -> sysnode-backend
https://sysnode.info/gov/*   -> sysnode-backend
```

This keeps the `sid` and `csrf` cookies host-only with `Secure; SameSite=Lax`, and lets the SPA read the `csrf` cookie from the same host before mirroring it into `X-CSRF-Token`. Do not deploy the real-key auth/vault/voting surface as `sysnode.info` plus a cross-site API host.

For production, set at least:

```bash
NODE_ENV=production
FRONTEND_URL=https://sysnode.info
CORS_ORIGIN=https://sysnode.info
TRUST_PROXY=1              # or the exact trusted proxy/CIDR for your edge
SYSNODE_AUTH_PEPPER=<32-byte-hex-secret>
```

Production startup refuses non-secure cookies, non-HTTPS `FRONTEND_URL`, or a credentialed CORS origin that differs from `FRONTEND_URL`.

### Reverse proxy reference

A working same-origin nginx vhost lives at [`deploy/nginx/sysnode.conf.example`](deploy/nginx/sysnode.conf.example). The example is the canonical reference, not a drop-in: copy it to `/etc/nginx/conf.d/sysnode.conf`, replace `sysnode.example.com` with your real hostname, then run `sudo certbot --nginx -d <hostname>` to obtain a Let's Encrypt cert and let Certbot rewrite the `listen 443 ssl` block. Any TLS terminator that preserves `Host` and forwards `X-Forwarded-Proto: https` will work — the example is nginx because that's what we run, not because nginx is special.

### HSTS

Both apps emit `Strict-Transport-Security` from their own code: the backend via helmet's defaults (`max-age=31536000; includeSubDomains`), the frontend via the security-header map in `sysnode-info/server.js`. Do **not** add `add_header Strict-Transport-Security` at the edge — duplicating it produces two response headers, which is noisy in audits even though browsers only honour the first per RFC 6797 §8.1. The default Certbot snippet at `/etc/letsencrypt/options-ssl-nginx.conf` ships with HSTS enabled; comment that line out (or override per-vhost) when standing up a new box, otherwise every response will carry it twice.

Owning HSTS in code means any deployer — behind nginx, Caddy, a managed load balancer, or directly on a TLS-terminating Node — gets HSTS without having to remember to add it at their edge.

### Production host hardening

On production hosts, expose only SSH and the TLS terminator publicly. The Node processes on `:3000` and `:3001` are implementation details behind nginx and should not be reachable directly from the internet. If the app processes bind all interfaces, enforce this with the host firewall or cloud security group:

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Do **not** allow `3000/tcp` or `3001/tcp` on production. The `/auth`, `/vault`, `/gov`, `/mnstats`, `/mncount`, `/mnlist`, `/mnsearch`, and `/govlist` paths should be reachable only through the same-origin nginx vhost described above. Before `syscoind` is running, the backend is expected to fail closed if `SYSCOIN_RPC_COOKIE_PATH` is missing; nginx will return `502` for backend routes rather than exposing partial authenticated functionality.

### Cookie vs static RPC auth

The backend supports both authentication modes and picks **cookie over static** when both are configured (with a one-line warning at boot). Cookie auth is zero-secret-management: `syscoind` rewrites the cookie on every restart, and the backend picks up the new token automatically via a 401-driven replay. Use it for any deployment where the backend runs on the same host as `syscoind`.

For remote RPC nodes, either configure `rpcauth=` in `syscoin.conf` and use the static `SYSCOIN_RPC_USER` / `SYSCOIN_RPC_PASS` here, or mount the cookie file via a secure channel.

## Full-stack test deployment (single host)

These steps stand up `sysnode-backend` + [`sysnode-info`](https://github.com/syscoin/sysnode-info) on one Ubuntu box that already runs `syscoind`. HTTP-only; intended for staging and testing, not production. Everything installs into the user's home directory — **no `sudo` required** on most steps (a couple of optional hardening steps do need it; they are clearly marked).

Walked end-to-end against Ubuntu 24.04 LTS + Node 22. Port layout: backend :3001, frontend :3000.

### 1. Node.js 20 or 22 + basic tooling

Node.js ≥ 20, < 24 (see `engines` in `package.json`). If the box already has a Node in that range, skip the `nvm` block. Ubuntu 24.04 ships a compatible Node in its default repos; many one-click images come with Node 20 or 22 pre-installed.

```bash
# Only if you don't already have Node 20–23.x
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm use 22

# Use a user-local npm prefix so global installs don't need sudo
mkdir -p ~/.npm-global ~/.local/bin
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

npm install -g pm2 serve
```

### 2. Transactional email provider

Email delivery (account verification, password-change notices, vote reminders, proposal status updates) goes through any SMTP provider you choose — SMTP2GO, SendGrid, Brevo, Postmark, Mailgun, AWS SES, or a corporate mail relay all work identically from the app's perspective. Pick one, verify a sender domain you control on their dashboard, and note its SMTP host / port / username / password. You'll paste those into `.env` in the next section.

In production the backend refuses to boot unless `SMTP_HOST` is set (or `MAIL_TRANSPORT=log` is set explicitly for stdout-only dry-run), so this step is required before the backend will start with `NODE_ENV=production`.

### 3. Clone both repos

```bash
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/syscoin/sysnode-backend.git
git clone https://github.com/syscoin/sysnode-info.git
```

### 4. Configure the backend

```bash
cd ~/apps/sysnode-backend
npm ci

# Locate the Core cookie (path depends on the user that runs syscoind)
ls -l ~/.syscoin/.cookie 2>/dev/null || sudo ls -l /root/.syscoin/.cookie

PEPPER=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
COOKIE_PATH=/home/ubuntu/.syscoin/.cookie   # adjust to match the ls above
SERVER_IP=$(hostname -I | awk '{print $1}') # or hardcode the public IP

cat > .env <<EOF
PORT=3001
BASE_URL=http://${SERVER_IP}:3001
CORS_ORIGIN=http://${SERVER_IP}:3000
FRONTEND_URL=http://${SERVER_IP}:3000
NODE_ENV=development
TRUST_PROXY=loopback
SYSNODE_DB_PATH=./data/sysnode.db
SYSNODE_AUTH_PEPPER=${PEPPER}

# SMTP — paste your transactional provider's credentials here. Port 465 is
# treated as implicit TLS; any other port (587 is standard) uses STARTTLS.
# MAIL_FROM must be a sender address you have verified at the provider.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=no-reply@example.com
MAIL_TRANSPORT=smtp

# Syscoin Core RPC (cookie mode, preferred for same-host)
SYSCOIN_RPC_HOST=127.0.0.1
SYSCOIN_RPC_PORT=8370
SYSCOIN_RPC_COOKIE_PATH=${COOKIE_PATH}
SYSCOIN_RPC_LOG_LEVEL=error

# Pay-with-Pali (mainnet)
SYSCOIN_NETWORK=mainnet
SYSCOIN_BLOCKBOOK_URL=https://blockbook.syscoin.org/
EOF

mkdir -p data
```

> **The backend does not load `.env` automatically.** It has no `dotenv` dependency. We load the file with Node's native `--env-file=` flag (Node 20.6+), which is why every invocation of `node` for this repo below passes `--env-file=.env`.

> **Cookie file permissions.** If the backend user can't read `~/.syscoin/.cookie` (different uid than `syscoind`), add `rpccookieperms=group` to `~/.syscoin/syscoin.conf` and restart `syscoind`, then add the backend's user to the syscoin group. The backend's boot log prints the exact errno (`ENOENT` / `EACCES`) if it can't read the file.

Quick sanity check — confirms `.env` is loaded and RPC cookie auth works against Core:

```bash
node --env-file=.env -e '
  const { client, rpcServices } = require("./services/rpcClient");
  rpcServices(client.callRpc).getBlockchainInfo().call()
    .then(r => console.log(r.chain, r.blocks, "ibd=" + r.initialblockdownload))
    .catch(e => { console.error(e.message); process.exit(1); });
'
# expected: "main <height> ibd=false"
```

### 5. Build and serve the frontend

`REACT_APP_API_BASE` is a Create React App build-time variable — it must be set before `npm run build` or the bundle will keep pointing at the default.

```bash
cd ~/apps/sysnode-info
npm ci
SERVER_IP=$(hostname -I | awk '{print $1}')
REACT_APP_API_BASE=http://${SERVER_IP}:3001 npm run build
```

### 6. Start both under pm2

```bash
cd ~/apps/sysnode-backend
pm2 start "node --env-file=.env server.js" --name sysnode-backend

cd ~/apps/sysnode-info
pm2 start "serve -s build -l 3000" --name sysnode-info

pm2 save
pm2 list
```

Optional — survive a full reboot. Requires sudo; skip if you don't have it and just run `pm2 resurrect` after any reboot:

```bash
pm2 startup systemd -u $USER --hp $HOME   # prints one sudo line; paste it
```

### 7. Firewall (optional)

If `ufw` isn't active on the host, your cloud security-group / network-layer rules are what matter — adjust those instead.

```bash
sudo ufw status
# If active:
sudo ufw allow 3000/tcp   # frontend
sudo ufw allow 3001/tcp   # backend API
```

### 8. Smoke-test end to end

```bash
# Backend reachable + RPC cookie auth working (real stats from Core)
curl -s http://<server-ip>:3001/mnstats | head -c 200

# Mail pipeline. Replace TEST_RECIPIENT with an inbox you can open. If SMTP is
# wired up correctly a verification email arrives within seconds — check the
# spam folder too, transactional mail from a brand-new sender domain often
# lands there until reputation builds at the receiver.
cd ~/apps/sysnode-backend
TEST_RECIPIENT=you@example.com node --env-file=.env -e '
  const { createMailer } = require("./lib/mailer");
  createMailer({ transport: "smtp" }).sendVerification({
    to: process.env.TEST_RECIPIENT,
    link: process.env.BASE_URL + "/auth/verify?t=smoketest",
  }).then(() => console.log("sent to " + process.env.TEST_RECIPIENT))
    .catch(e => { console.error("FAILED:", e.message); process.exit(1); });
'
```

Then exercise the UI:

1. Open `http://<server-ip>:3000` — dashboard loads.
2. Register a user in the UI with an email address you can open — the verification email should arrive within seconds (check the spam folder too). Click the link to activate the account.
3. Go into the governance proposal wizard — the **Pay with Pali** button should be enabled (assuming your browser has Pali installed and the chain guard verified mainnet).

## Updating the stack

```bash
pm2 stop sysnode-backend sysnode-info

cd ~/apps/sysnode-backend
git pull && npm ci

cd ~/apps/sysnode-info
git pull && npm ci
REACT_APP_API_BASE=http://<server-ip>:3001 npm run build

pm2 restart sysnode-backend sysnode-info
```

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Backend exits at boot, `failed to read rpc cookie at ... ENOENT` | Wrong `SYSCOIN_RPC_COOKIE_PATH` | `sudo -u <syscoind-user> cat <path>` |
| Backend exits at boot, `... EACCES` | Backend user can't read the cookie | Use `rpccookieperms=group` + `usermod -aG` |
| Backend rejects RPC with 401 after a Core restart once, then recovers | Expected — cookie rotated, backend replayed with the new one | No action |
| Pay with Pali button disabled | `paliChainGuard` reports `pali_path_chain_mismatch` or `pali_path_rpc_down` | `GET /gov/proposals/network` returns a `paliPathReason` |
| Verification emails never arrive | SMTP creds wrong, sender domain not verified at the provider, or mail filtered into spam | Check backend logs for 5xx SMTP responses, the provider's dashboard for bounces/delivery status, and the recipient's spam folder |
| Frontend hits `https://syscoin.dev` instead of the test backend | `REACT_APP_API_BASE` not set at build time | Rebuild with the env var inline |

## License

MIT
