# Security Policy

## Supported versions

Security fixes are provided for the latest tagged release. Upgrade before
reporting a vulnerability that only affects an older version.

## Audited transitive exception

The packaged Claude Agent SDK currently pulls `@modelcontextprotocol/sdk`,
whose published dependency range selects `@hono/node-server` 1.x. npm reports
[GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)
against that package. HelixUI does not import Hono or expose the affected
Windows `serve-static` handler. Source installs force `@hono/node-server`
2.0.5 or newer, and the package-install check permits only this exact,
unreachable advisory chain; any additional advisory still fails the release.

## Deployment boundary

HelixUI can execute shell commands and AI-agent tools with the permissions of
the operating-system account that runs the server. Application logins separate
preferences, credentials, API keys, usage records, and attribution, but they are
not an operating-system sandbox.

- Run one instance per trust boundary.
- Give untrusted users separate containers, virtual machines, or Unix accounts.
- Keep the default `HOST=127.0.0.1`, or publish through an authenticated HTTPS
  reverse proxy and firewall.
- Restrict `WORKSPACES_ROOT` to a dedicated directory.
- Never run the service as root.
- Leave `ENABLE_SELF_UPDATE` and `VITE_IS_PLATFORM` disabled unless their trust
  requirements are understood and enforced.

The first account created in an empty database is the administrator. Public
registration closes immediately after that bootstrap account is created.
Additional accounts are disabled unless `ENABLE_MULTI_USER=true` is explicitly
set. Those accounts have separate preferences and credentials, but still share
the instance's workspaces and operating-system authority.

## Secrets and backups

Runtime data is stored under `~/.cloudcli` by default and is not part of the
source repository. Back up the database together with `.jwt-secret` and
`.credential-key`; protect the backup as sensitive material.

## Reporting

Do not open a public issue for an exploitable vulnerability. Use GitHub's
private security advisory feature for this repository and include reproduction
steps, affected versions, and expected impact.
