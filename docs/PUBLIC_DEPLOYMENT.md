# Public deployment

HelixUI can execute commands and read or write workspace files. Treat it as a
remote administration service, not as an ordinary public website.

The recommended production topology is:

```text
browser
  -> Cloudflare edge TLS
  -> Cloudflare Access identity policy + MFA
  -> named Cloudflare Tunnel
  -> http://127.0.0.1:3001
  -> HelixUI JWT login
```

Do not port-forward `3001` or `3443`. A named tunnel creates outbound
connections from the server, so the origin can remain unreachable from the
Internet. Do not use a temporary `trycloudflare.com` quick tunnel for
production.

## Requirements

- A domain managed by Cloudflare.
- A Cloudflare Zero Trust organization.
- A dedicated Linux account or container for HelixUI.
- A separate deployment for each group of mutually untrusted users.

Application accounts share the server OS identity and workspace boundary.
`ENABLE_MULTI_USER=true` is suitable only for a trusted team. It is not a
security boundary between hostile tenants.

## 1. Harden the origin

Create persistent private directories outside the source checkout and generate
independent secrets:

```bash
sudo install -d -m 700 -o helix -g helix /srv/helix/data /srv/helix/workspaces
openssl rand -hex 32
openssl rand -hex 32
```

Configure `.env`:

```env
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=loopback
ALLOWED_HOSTS=helix.example.com
CORS_ORIGIN=https://helix.example.com
WS_ALLOWED_ORIGINS=https://helix.example.com
WS_ALLOW_NO_ORIGIN=false
ENABLE_HSTS=true

CLOUDCLI_DATA_DIR=/srv/helix/data
WORKSPACES_ROOT=/srv/helix/workspaces
JWT_SECRET=replace-with-the-first-generated-secret
CREDENTIALS_ENCRYPTION_KEY=replace-with-the-second-generated-secret
JWT_EXPIRES_IN=12h

AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX=10
HEALTH_DETAILS=false
ENABLE_SELF_UPDATE=false
```

Keep `.env` mode `0600`. Do not enable `VITE_IS_PLATFORM` or
`TRUST_PROXY_AUTH`; the application login is the second authentication layer.

Restart HelixUI and verify that it is loopback-only:

```bash
ss -lntp | grep ':3001'
curl --fail http://127.0.0.1:3001/health
```

The listener must show `127.0.0.1:3001`, not `0.0.0.0:3001` or
`[::]:3001`.

Before publishing the tunnel, create the first administrator through localhost.
The first account in a new database becomes the administrator, so an empty
instance must never be reachable from the Internet. If the server has no local
browser, forward the loopback port over SSH:

```bash
ssh -L 3001:127.0.0.1:3001 your-server
```

Open `http://127.0.0.1:3001`, create the administrator, sign out and back in,
and confirm the application is usable before continuing.

## 2. Create the tunnel

In Cloudflare Zero Trust:

1. Go to **Networking > Tunnels** and create a named, remotely managed tunnel.
2. Install `cloudflared` with the command shown by Cloudflare and run it as a
   system service.
3. Add a **Published application** route:
   - Hostname: `helix.example.com`
   - Service URL: `http://127.0.0.1:3001`
4. Confirm that the connector status is healthy.

The tunnel token is a secret. Store it only in the service credentials; never
put it in `.env`, shell history, source control, screenshots, or support logs.

## 3. Protect the entire hostname with Access

Create a **Self-hosted** Access application for `helix.example.com`.

Use a default-deny policy with an explicit allowlist of individual email
addresses or an identity-provider group. Require MFA and use a short session
duration. Do not use:

- `Include Everyone`
- all valid email addresses
- a permanent `Bypass` policy
- an unprotected `/ws` path

Protect the whole hostname so static files, `/api`, `/ws`, and `/health` pass
through the same identity check. Then log in through HelixUI using a separate,
strong application password.

## 4. Close direct ingress

Once the public hostname works:

- Remove router/NAT forwarding for `3001` and `3443`.
- Block inbound access to those ports in the host and cloud firewalls.
- Keep SSH restricted to a VPN, bastion, or identity-aware access service.
- Confirm from a different network that the origin IP and ports are
  unreachable while the hostname remains available.

## 5. Operational controls

- Back up `CLOUDCLI_DATA_DIR` and workspace data separately.
- Patch the OS, Node.js, `cloudflared`, and HelixUI regularly.
- Review Access authentication logs and application login failures.
- Revoke application sessions when a device or account is lost.
- Give the service account no `sudo` access and no secrets outside its
  workspace.
- Keep model-provider credentials per deployment and rotate them after any
  suspected exposure.
- Test WebSocket reconnects and long-running turns after every proxy change.

No Internet-facing execution service can be made risk-free. This design removes
direct origin exposure and requires two independent authentication layers,
which is the minimum reasonable baseline for this application.
