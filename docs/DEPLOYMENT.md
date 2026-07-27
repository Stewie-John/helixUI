# Deployment

## Local installation

```bash
git clone https://github.com/Stewie-John/helixUI.git
cd helixui
npm ci --include=dev
cp .env.example .env
npm run build
npm run server
```

Open `http://127.0.0.1:3001` and create the first administrator account.

## Network deployment

Do not expose the Node server directly to the public internet. Put it behind an
HTTPS reverse proxy, preserve WebSocket upgrade headers, and allow only the
proxy to reach the application port. Set an explicit `CORS_ORIGIN`, strong
`JWT_SECRET`, strong `CREDENTIALS_ENCRYPTION_KEY`, and a dedicated
`WORKSPACES_ROOT`.

Example environment:

```env
HOST=127.0.0.1
PORT=3001
CORS_ORIGIN=https://helix.example.com
WORKSPACES_ROOT=/srv/helix/workspaces
CLOUDCLI_DATA_DIR=/srv/helix/data
JWT_SECRET=replace-with-64-random-hex-characters
CREDENTIALS_ENCRYPTION_KEY=replace-with-64-random-hex-characters
TRUST_PROXY=loopback
ALLOWED_HOSTS=helix.example.com
ENABLE_HSTS=true
```

For a trusted team sharing one workspace boundary, set `ENABLE_MULTI_USER=true`.
Do not use that mode for mutually untrusted users; deploy one isolated instance
per trust boundary instead.

The proxy must forward `/api/*`, static files, and WebSocket upgrades on `/ws`.
Set request-body and idle timeouts high enough for image prompts and long agent
turns.

For an Internet-reachable deployment, follow
[Public deployment](PUBLIC_DEPLOYMENT.md). It keeps the origin on loopback and
places an identity-aware access layer in front of both HTTP and WebSocket
traffic.

## Upgrades and rollback

Runtime state is external to the repository, so source upgrades do not replace
the database. Before upgrading, back up `CLOUDCLI_DATA_DIR`, install the desired
tag, run `npm ci --include=dev && npm run verify`, and restart only after active
turns finish. `--include=dev` is required for source builds even when the shell
exports `NODE_ENV=production`. Rollback by checking out the previous tag and
running `npm ci --include=dev && npm run build`.

Database migrations are forward-running. Test rollback against a copy of the
data directory before relying on it in production.
