# Snapshot deployment

This guide covers running **Snapshot** (web UI + API + Playwright capture) on a **Linux VM** or as a **Docker container**.

**Recommended production (VM):** nginx terminates **HTTPS**, Snapshot listens on **127.0.0.1:8787** only.

| Path | Purpose |
|------|---------|
| [`deploy/vm-deploy.sh`](deploy/vm-deploy.sh) | Install, build, systemd; optional `--nginx` HTTPS |
| [`deploy/lib/ensure-node.sh`](deploy/lib/ensure-node.sh) | Node.js version check + auto-install (sourced by VM script) |
| [`deploy/nginx-setup.sh`](deploy/nginx-setup.sh) | Add Snapshot nginx vhost + TLS (does not touch other sites) |
| [`deploy/nginx/snapshot.conf.template`](deploy/nginx/snapshot.conf.template) | Host nginx HTTPS `server{}` template |
| [`deploy/nginx/snapshot-http.conf.template`](deploy/nginx/snapshot-http.conf.template) | Host nginx HTTP-only `server{}` template |
| [`deploy/container-deploy.sh`](deploy/container-deploy.sh) | Docker deploy; `--host-nginx` / `--nginx` HTTP or HTTPS |
| [`deploy/docker-compose.yml`](deploy/docker-compose.yml) | App-only Compose (optional localhost bind) |
| [`deploy/docker-compose.nginx.yml`](deploy/docker-compose.nginx.yml) | App + Docker nginx HTTPS stack |
| [`deploy/docker-compose.nginx-http.yml`](deploy/docker-compose.nginx-http.yml) | App + Docker nginx HTTP-only stack |
| [`deploy/Dockerfile`](deploy/Dockerfile) | Multi-stage image (Playwright base + Snapshot) |
| [`deploy/docker-entrypoint.sh`](deploy/docker-entrypoint.sh) | Container entrypoint (`/data` permissions + start) |
| [`deploy/systemd/snapshot.service`](deploy/systemd/snapshot.service) | systemd unit template |

---

## Prerequisites

### VM

| Requirement | Notes |
|-------------|--------|
| Linux (Debian/Ubuntu preferred) | `playwright install-deps` uses `apt` |
| Node.js **≥ 20** | **Auto-installed** by `vm-deploy.sh` when missing or too old (see below) |
| pnpm | Enabled via Corepack after Node is present |
| **sudo** (recommended) | Required for auto Node install, Playwright OS libs, systemd, nginx |
| Optional: DNS name | Required for Let's Encrypt (`--certbot`) |
| Disk | Chromium + `node_modules` ≈ several GB; job PNGs under `data/` |

You do **not** need to install Node manually on a fresh VM — `./deploy/vm-deploy.sh` handles it. Container deploy bundles Node inside the image.
### Container

| Requirement | Notes |
|-------------|--------|
| Docker Engine | 24+ recommended |
| Docker Compose | `docker compose` plugin **or** `docker-compose` |
| RAM / shm | Compose sets `shm_size: 1gb` for Chromium |

---

## Quick start

### 1. Deploy on a VM (with HTTPS via nginx)

From the monorepo root on the target machine (repo already cloned). Prefer a **dedicated hostname** so existing nginx apps keep their own `server_name` blocks:

```bash
chmod +x deploy/vm-deploy.sh deploy/nginx-setup.sh

# HTTP only (lab / private network — port 80)
./deploy/vm-deploy.sh \
  --nginx \
  --domain snapshot.example.com \
  --http

# Full deploy + Let's Encrypt HTTPS (recommended for public)
./deploy/vm-deploy.sh \
  --nginx \
  --domain snapshot.example.com \
  --certbot \
  --email ops@example.com

# Or self-signed TLS (browsers will warn)
./deploy/vm-deploy.sh --nginx --domain snapshot.example.com --self-signed
```

What this does:

1. **Ensures Node.js ≥ 20** — checks version; installs or upgrades if needed (then enables pnpm via Corepack)  
2. `pnpm install`, Playwright Chromium, builds UI + API  
3. Starts systemd unit `snapshot` with **`HOST=127.0.0.1`** when using `--nginx` (not public)  
4. Adds **only** an nginx site file for `server_name = snapshot.example.com`  
5. Runs `nginx -t` then `reload` — **does not edit** `nginx.conf` or other sites  

#### Node.js auto-install (VM only)

Implemented in [`deploy/lib/ensure-node.sh`](deploy/lib/ensure-node.sh), called by `vm-deploy.sh` before any build.

| When it runs | When it is skipped |
|--------------|-------------------|
| `./deploy/vm-deploy.sh` (default) | `./deploy/vm-deploy.sh --start` |
| `./deploy/vm-deploy.sh --build-only` | `./deploy/vm-deploy.sh --stop` |
| `./deploy/vm-deploy.sh --foreground` | `./deploy/vm-deploy.sh --status` |
| | `./deploy/vm-deploy.sh --uninstall-service` |

**Default version:** `SNAPSHOT_NODE_MIN_MAJOR` defaults to **`20`** when unset or empty (matches `package.json` `"engines": { "node": ">=20" }`). You do not need to export it for a normal deploy.

**Check:** if `node -v` reports major version **≥** the configured minimum, the script logs `Node vX.Y.Z OK (>= 20)` and continues.

**Install / upgrade:** if Node is missing or the major version is too low, the script installs automatically:
| OS / package manager | Method |
|----------------------|--------|
| Debian / Ubuntu (`apt-get`) | [NodeSource](https://github.com/nodesource/distributions) setup script + `apt install nodejs` |
| RHEL / Fedora / CentOS (`dnf` / `yum`) | NodeSource setup script + `dnf`/`yum install nodejs` |
| macOS | Homebrew `node@20` (or `node`) |

Requirements for auto-install:

- Network access to NodeSource (and `curl`)
- **root** or **sudo** on Linux

After Node is ready, `vm-deploy.sh` runs `corepack enable` and activates pnpm.

**Opt out** (air-gapped or custom Node layout):

```bash
# Install Node 20 yourself, then:
SNAPSHOT_SKIP_NODE_INSTALL=1 ./deploy/vm-deploy.sh
```

**Custom minimum:**

```bash
SNAPSHOT_NODE_MIN_MAJOR=22 ./deploy/vm-deploy.sh
```

**Clear a bad exported value** (empty env var is treated like unset and still defaults to `20`):

```bash
unset SNAPSHOT_NODE_MIN_MAJOR
./deploy/vm-deploy.sh
```

Then open:

- UI + API: `https://snapshot.example.com/`
- Health: `https://snapshot.example.com/api/health`
- App direct (localhost only): `http://127.0.0.1:8787/api/health`

#### App already deployed — add nginx later

```bash
./deploy/nginx-setup.sh \
  --domain snapshot.example.com \
  --certbot \
  --email ops@example.com
```

#### Existing nginx on the VM (important)

| Guarantee | Detail |
|-----------|--------|
| Additive only | Writes `/etc/nginx/sites-available/snapshot` (+ symlink) **or** `/etc/nginx/conf.d/snapshot.conf` |
| No global overwrite | Never replaces `/etc/nginx/nginx.conf` |
| No other vhosts | Does not edit files for other apps |
| Safe reload | Aborts if `nginx -t` fails (your other sites keep running) |
| Isolation | Uses its own `server_name`; other apps keep answering on their names |

Use a DNS name that is **not** already used by another `server_name` on this host.

Remove only the Snapshot site:

```bash
./deploy/nginx-setup.sh --remove
```

#### TLS / HTTP options (`nginx-setup.sh` / `vm-deploy.sh`)

| Mode | Flags | When |
|------|-------|------|
| **HTTP only** | `--http` | Lab / private network; nginx on port **80** only (no TLS) |
| Let's Encrypt | `--certbot --email you@example.com` | Public DNS pointing at the VM |
| Self-signed | `--self-signed` | Lab HTTPS (browsers warn) |
| Existing certs | `--cert fullchain.pem --key privkey.pem` | Corporate / already issued |

HTTP example (app already running):

```bash
./deploy/nginx-setup.sh --domain snapshot.example.com --http
```

Then open `http://snapshot.example.com/` (open firewall port **80**).

#### Without nginx (HTTP on 8787)

```bash
./deploy/vm-deploy.sh
```

Useful commands:

```bash
./deploy/vm-deploy.sh --status
./deploy/vm-deploy.sh --stop
./deploy/vm-deploy.sh --start
./deploy/vm-deploy.sh --foreground
./deploy/vm-deploy.sh --build-only
./deploy/vm-deploy.sh --uninstall-service
journalctl -u snapshot -f
```

#### VM script options

| Flag | Behavior |
|------|----------|
| *(default)* | Install → build → systemd; optional nginx if `--nginx` / `--domain` |
| `--nginx --domain NAME` | After app start, configure nginx front |
| `--http` | nginx **HTTP** only (port 80) |
| `--certbot --email E` | Let's Encrypt HTTPS |
| `--self-signed` | Local TLS cert |
| `--cert` / `--key` | Custom certificate files |
| `--build-only` | Dependencies + Playwright + compile only |
| `--start` / `--stop` / `--status` | systemd + health |
| `--foreground` | Run in this terminal |
| `--public` | Bind `0.0.0.0` (requires `SNAPSHOT_API_TOKEN`) |
| `--uninstall-service` | Remove systemd unit only (nginx site stays until `--remove`) |

#### VM environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` / `SNAPSHOT_PORT` | `8787` | App listen port |
| `HOST` / `SNAPSHOT_HOST` | `127.0.0.1` (or `0.0.0.0` with `--public`) | Bind address; nginx forces `127.0.0.1` |
| `SNAPSHOT_API_TOKEN` | — | Optional API token; **required** with `--public` |
| `SNAPSHOT_MAX_QUEUE` | `8` | Max pending capture jobs |
| `SNAPSHOT_DATA_DIR` | `<repo>/data` | Jobs + screenshots |
| `SNAPSHOT_WEB_DIST` | `<repo>/apps/web/dist` | Built Vite UI |
| `SNAPSHOT_CORS_ORIGINS` | `*` / `https://<domain>` with nginx | CORS allow-list |
| `SNAPSHOT_DOMAIN` | — | Hostname for nginx vhost |
| `SNAPSHOT_CERTBOT_EMAIL` | — | Let's Encrypt account email |
| `SNAPSHOT_SERVICE_NAME` | `snapshot` | systemd unit name |
| `SNAPSHOT_SKIP_APT` | unset | Set to `1` to skip `playwright install-deps` |
| `SNAPSHOT_NODE_MIN_MAJOR` | `20` | Minimum Node major version; defaults to `20` if unset **or empty** |
| `SNAPSHOT_SKIP_NODE_INSTALL` | unset | Set to `1` to require pre-installed Node; no auto-install |

Generated file (gitignored): `deploy/snapshot.env` — loaded by systemd via `EnvironmentFile=`.

#### Firewall

With nginx **HTTP**:

```bash
sudo ufw allow 80/tcp
# Do NOT expose 8787 publicly when HOST=127.0.0.1
```

With nginx **HTTPS**:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Do NOT expose 8787 publicly when HOST=127.0.0.1
```

Without nginx (localhost or lab only):

```bash
./deploy/vm-deploy.sh
# LAN exposure (requires token):
export SNAPSHOT_API_TOKEN="$(openssl rand -hex 32)"
./deploy/vm-deploy.sh --public
```

By default the app binds **127.0.0.1** only. Use `--public` only on trusted networks and always set `SNAPSHOT_API_TOKEN`.

---

### nginx-setup.sh reference

```bash
./deploy/nginx-setup.sh --help

./deploy/nginx-setup.sh --domain snapshot.example.com --http
./deploy/nginx-setup.sh --domain snapshot.example.com --certbot --email ops@example.com
./deploy/nginx-setup.sh --domain snapshot.example.com --self-signed
./deploy/nginx-setup.sh --domain snapshot.example.com \
  --cert /etc/ssl/certs/snapshot.pem \
  --key /etc/ssl/private/snapshot.key

./deploy/nginx-setup.sh --remove
```

Proxy settings in the templates:

- `client_max_body_size 200m` (HAR uploads)
- `proxy_read_timeout 300s`
- **HTTP mode (`--http`):** listen **80** only, reverse-proxy to the app
- **HTTPS modes:** HTTP → HTTPS redirect + ACME `/.well-known/acme-challenge/`

If you **must** share an existing HTTPS `server{}` (not recommended), see [`deploy/nginx/snapshot-location.conf.example`](deploy/nginx/snapshot-location.conf.example) — that path is **manual**; the script will not edit your other site files.

---

### 2. Deploy as a container

Pick a mode based on whether the **host already runs nginx** (same rule as the VM script):

| Mode | When | Command |
|------|------|---------|
| **Host nginx HTTP** | nginx already on the VM; no TLS yet | `--host-nginx --domain … --http` |
| **Host nginx HTTPS** | nginx already on the VM | `--host-nginx --domain … --certbot` |
| **Docker nginx HTTP** | No host nginx; HTTP only | `--nginx --domain … --http` |
| **Docker nginx HTTPS** | No host nginx / pure Docker host | `--nginx --domain … --self-signed` |
| **Simple HTTP** | Lab / VPN only | default (`127.0.0.1:8787`) |

#### 2a. Recommended: container + existing host nginx

**HTTP:**

```bash
./deploy/container-deploy.sh \
  --host-nginx \
  --domain snapshot.example.com \
  --http
```

**HTTPS (Let's Encrypt):**

```bash
./deploy/container-deploy.sh \
  --host-nginx \
  --domain snapshot.example.com \
  --certbot \
  --email ops@example.com
```

- UI (HTTP): `http://snapshot.example.com/`
- UI (HTTPS): `https://snapshot.example.com/`
- App direct: `http://127.0.0.1:8787/api/health` (localhost only)

#### 2b. Self-contained Docker nginx

**HTTP** (host port 80 only):

```bash
./deploy/container-deploy.sh \
  --nginx \
  --domain snapshot.example.com \
  --http
```

Uses [`deploy/docker-compose.nginx-http.yml`](deploy/docker-compose.nginx-http.yml).

**HTTPS** (host ports 80/443):

```bash
./deploy/container-deploy.sh \
  --nginx \
  --domain snapshot.example.com \
  --self-signed
```

Uses [`deploy/docker-compose.nginx.yml`](deploy/docker-compose.nginx.yml).

**Do not** combine Docker `--nginx` with an existing host nginx on the same ports — prefer `--host-nginx` instead.

#### 2c. Simple HTTP (no TLS)

```bash
./deploy/container-deploy.sh
# or: SNAPSHOT_PORT=8080 ./deploy/container-deploy.sh

# Expose on all interfaces (requires token):
export SNAPSHOT_API_TOKEN="$(openssl rand -hex 32)"
./deploy/container-deploy.sh --public
```

Default bind is **127.0.0.1** — reachable only from the host unless you pass `--public`.

#### Container hardening (base Compose)

| Setting | Value | Why |
|---------|-------|-----|
| `init: true` | on | Reap Chromium zombie processes |
| `shm_size` | `1gb` | Chromium stability |
| `mem_limit` | `2g` (override `SNAPSHOT_MEM_LIMIT`) | Cap runaway captures |
| `SNAPSHOT_BIND` | `127.0.0.1` or `0.0.0.0` | Host publish address |
| `SNAPSHOT_API_TOKEN` | server | Optional bearer token; enables API auth |
| `SNAPSHOT_MAX_QUEUE` | server | Max pending jobs (default `8`) |
| Healthcheck | `/api/health` | Start period 40s |

Useful commands:

```bash
./deploy/container-deploy.sh --logs
./deploy/container-deploy.sh --status
./deploy/container-deploy.sh --down
./deploy/container-deploy.sh --build-only
```

#### Container script options

| Flag | Behavior |
|------|----------|
| *(default)* | Build + start HTTP on `SNAPSHOT_PORT` |
| `--public` | Publish on `0.0.0.0` (requires `SNAPSHOT_API_TOKEN`) |
| `--host-nginx --domain NAME` | Localhost publish + host nginx |
| `--nginx --domain NAME` | Docker nginx sidecar |
| `--http` | HTTP only (port 80; no TLS) |
| `--certbot --email E` | Let's Encrypt (**host-nginx** only) |
| `--self-signed` / `--cert` `--key` | TLS material |
| `--build-only` / `--up` / `--down` / `--logs` / `--status` | Lifecycle |

#### Container environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `SNAPSHOT_PORT` | `8787` | Host app port (simple / host-nginx) |
| `SNAPSHOT_BIND` | `127.0.0.1` | Host bind (`--public` → `0.0.0.0`; `--host-nginx` → `127.0.0.1`) |
| `SNAPSHOT_API_TOKEN` | — | Optional API token; **required** with `--public` |
| `SNAPSHOT_MAX_QUEUE` | `8` | Max pending capture jobs |
| `SNAPSHOT_CORS_ORIGINS` | `https://domain` with nginx | CORS allow-list |
| `SNAPSHOT_IMAGE` | `snapshot:latest` | Image tag |
| `SNAPSHOT_MEM_LIMIT` | `2g` | App container memory |
| `SNAPSHOT_HTTP_PORT` / `SNAPSHOT_HTTPS_PORT` | `80` / `443` | Docker-nginx host ports |

#### Image details

- Base: `mcr.microsoft.com/playwright:v1.62.1-jammy`  
- Runtime user: `pwuser` via entrypoint `gosu`  
- Data volume: `snapshot-data` → `/data`  

---

## Production process model

**VM binary or container + host nginx (preferred when nginx already exists):**

```text
Browser → :443 (host nginx TLS, dedicated server_name)
            → 127.0.0.1:8787 → Snapshot (systemd or Docker)
```

**Pure Docker nginx sidecar:**

```text
Browser → :443 (snapshot-nginx container)
            → snapshot:8787 (Docker network only)
```

Without nginx, the app defaults to **127.0.0.1:8787**. Use `--public` / `SNAPSHOT_BIND=0.0.0.0` only with `SNAPSHOT_API_TOKEN` on trusted networks.

After a **successful** job, uploaded HAR artifacts under the job folder are deleted; `job.json` + `screenshots/` remain (see README).

---

## API authentication

When `SNAPSHOT_API_TOKEN` is set, all `/api/*` routes except `/api/health` and `/api/auth/*` require authentication.

| Client | How |
|--------|-----|
| **Browser (web UI)** | POST `/api/auth/session` with `{ "token": "…" }` — sets an **HttpOnly** `snapshot_token` cookie for same-origin requests (including screenshot `<img>` tags). The UI shows a sign-in prompt when auth is required. |
| **Scripts / curl** | `Authorization: Bearer <token>` or `X-Snapshot-Token: <token>` |

Generate a token:

```bash
export SNAPSHOT_API_TOKEN="$(openssl rand -hex 32)"
```

There is **no** build-time frontend token (`VITE_*`) — tokens must not be embedded in the static UI bundle.

Optional extra protection: HTTP basic auth or SSO at nginx.

---

## Configuration reference

| Variable | Used by | Description |
|----------|---------|-------------|
| `PORT` | server | Listen port (default `8787`) |
| `HOST` / `SNAPSHOT_HOST` | server | Bind address (`127.0.0.1` behind nginx) |
| `SNAPSHOT_DATA_DIR` | server | Job storage root |
| `SNAPSHOT_WEB_DIST` | server | Path to Vite `dist` |
| `SNAPSHOT_CORS_ORIGINS` | server | `*` or comma-separated allow-list |
| `SNAPSHOT_API_TOKEN` | server | Optional bearer token; enables API auth |
| `SNAPSHOT_MAX_QUEUE` | server | Max pending jobs (default `8`) |
| `SNAPSHOT_DOMAIN` | nginx-setup | Vhost `server_name` |
| `SNAPSHOT_NODE_MIN_MAJOR` | vm-deploy / ensure-node | Required Node major; **default `20`** when unset or empty |
| `SNAPSHOT_SKIP_NODE_INSTALL` | vm-deploy / ensure-node | Disable automatic Node install |

---

## Updating

### VM

```bash
cd /path/to/snapshot
git pull
./deploy/vm-deploy.sh --build-only
sudo systemctl restart snapshot
# or: ./deploy/vm-deploy.sh --stop && ./deploy/vm-deploy.sh --start
```

### Container

```bash
cd /path/to/snapshot
git pull
./deploy/container-deploy.sh          # rebuild + recreate
```

Data in the Docker volume `snapshot-data` is kept across rebuilds.

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `SNAPSHOT_NODE_MIN_MAJOR: unbound variable` | Update to latest scripts (`ensure-node.sh` defaults to `20`); or `export SNAPSHOT_NODE_MIN_MAJOR=20` before deploy |
| `need root or sudo to install Node.js` | Run with sudo, add your user to sudoers, or install Node 20+ manually and set `SNAPSHOT_SKIP_NODE_INSTALL=1` |
| Node install fails (NodeSource / apt) | Check outbound HTTPS; on Ubuntu run `sudo apt-get install -y ca-certificates curl gnupg` then retry |
| `Node install finished but version is still insufficient` | Old Node earlier on `PATH` — `hash -r`; check `which node` and `/usr/bin/node -v` |
| `unsupported OS for automatic Node install` | Install Node ≥ 20 from https://nodejs.org/ or use container deploy |
| `Web UI not built` / HTTP 503 on `/` | Run `pnpm --filter @snapshot/web build` or full `./deploy/vm-deploy.sh --build-only` |
| Chromium fails to launch on VM | `pnpm --filter @snapshot/replay exec playwright install-deps chromium` (with sudo) |
| Container OOM / blank captures | Raise `SNAPSHOT_MEM_LIMIT`; keep `shm_size: 1gb` |
| Host nginx + Docker both want :443 | Use `--host-nginx` (not `--nginx`) so only host nginx binds 80/443 |
| Docker `--nginx` + existing sites broken | Stop stack (`--down`); switch to `--host-nginx` |
| App still on public `:8787` (container) | Use `--host-nginx` or `SNAPSHOT_BIND=127.0.0.1` |
| Health unreachable | Check port/firewall; `journalctl -u snapshot -f` or `./deploy/container-deploy.sh --logs` |
| Permission denied on `/data` | Entrypoint chowns as root then `gosu pwuser`; recreate volume if stuck |
| CORS errors with a separate UI host | Set `SNAPSHOT_CORS_ORIGINS=https://your-ui.example` |
| `nginx -t` failed during setup | Snapshot site not enabled; fix the rendered file — other sites unchanged |
| Wrong site / default server answers | Ensure DNS `server_name` is unique; check `nginx -T \| grep server_name` |
| Certbot failure | Port 80 reachable from Internet; DNS A/AAAA points at this VM |
| App still on public `:8787` | Confirm `HOST=127.0.0.1` in `deploy/snapshot.env` and restart `snapshot` |

---

## Security notes

- Prefer **nginx HTTPS** + app on **127.0.0.1** so the Node port is not public.
- Set **`SNAPSHOT_API_TOKEN`** for any network-exposed deployment (`--public`, or nginx on the Internet).
- Default binds are **127.0.0.1** (VM and container) — do not expose `:8787` on a firewall unless you intend to.
- Uploads can be large (up to ~200MB) and trigger headless Chromium — isolate the host accordingly.
- Job metadata and screenshots persist on disk until you delete them (`SNAPSHOT_DATA_DIR` / Docker volume).
