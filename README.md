<div align="center">
  <img src="public/logo.svg" alt="HelixUI" width="72" height="72">
  <h1>HelixUI</h1>
  <p>A self-hosted web workspace for AI coding agents.</p>
</div>

<p align="center">
  <a href="https://github.com/StewartJohn0/helixui/actions/workflows/ci.yml"><img src="https://github.com/StewartJohn0/helixui/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@stewiejohn/helixui"><img src="https://img.shields.io/npm/v/@stewiejohn/helixui" alt="npm version"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node.js 22 or newer"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0-or-later"></a>
  <a href="./README.zh-CN.md">中文</a>
</p>

HelixUI brings Claude Code, OpenAI Codex, Cursor CLI, Gemini CLI, and compatible
custom providers into one responsive browser workspace. It is built for people
who want terminal-grade agent workflows without giving up persistent sessions,
files, Git tools, usage visibility, or access from another device.

## Highlights

- **Persistent agent conversations** with streaming output, reconnect recovery,
  queued follow-ups, session organization, context usage, and goal history.
- **Real shell and terminal sessions** backed by PTYs, with reconnectable state
  and per-session continuity.
- **Integrated workspace tools** for file browsing, fuzzy search, drag-and-drop,
  editing, diffs, source control, and project-scoped navigation.
- **Multiple agent providers** through Claude Code, OpenAI Codex, Cursor,
  Gemini, and OpenAI-compatible endpoints.
- **Operational visibility** through quota, token, account usage, system
  resource, and active-work indicators.
- **Desktop and mobile layouts**, multilingual UI, voice-to-text, three visual
  themes, and installable PWA assets.
- **Release safety gates** covering privacy, workspace confinement, WebSocket
  origins, authentication boundaries, clean package installation, and
  production dependency audits.

## Requirements

- Node.js 22 or newer
- Linux or macOS for the full PTY experience
- At least one supported agent CLI installed and authenticated

## Quick start

### Install from npm

```bash
npm install -g @stewiejohn/helixui
helix-ui
```

### Install from source

```bash
git clone https://github.com/StewartJohn0/helixui.git
cd helixui
npm ci --include=dev
cp .env.example .env
npm run build
npm run server
```

Open `http://127.0.0.1:3001`. The first account created in an empty database
becomes the administrator, and public registration closes immediately.

Runtime state is stored outside the source checkout under `~/.cloudcli`.
Workspaces default to `~/CloudCLIWorkspaces`.

## Supported agents

Install and authenticate only the tools you intend to use:

| Provider | Required local tool |
| --- | --- |
| Claude | Claude Code CLI |
| OpenAI | Codex CLI |
| Cursor | Cursor CLI |
| Google | Gemini CLI |
| Compatible APIs | Provider base URL and API key |

Provider credentials and agent sessions remain on the machine running HelixUI.

## Security model

HelixUI can run shell commands with the permissions of its Unix account. Keep
the default localhost binding unless an authenticated HTTPS reverse proxy and
firewall protect the service. Application accounts are not an operating-system
sandbox; mutually untrusted users need separate containers, virtual machines,
Unix accounts, or HelixUI instances.

Before any network deployment, read [SECURITY.md](SECURITY.md) and the
[public deployment guide](docs/PUBLIC_DEPLOYMENT.md).

Common production overrides include:

```env
HOST=127.0.0.1
PORT=3001
WORKSPACES_ROOT=/absolute/path/to/dedicated/workspaces
CLOUDCLI_DATA_DIR=/absolute/path/to/persistent/private/data
ALLOWED_HOSTS=helix.example.com
CORS_ORIGIN=https://helix.example.com
WS_ALLOWED_ORIGINS=https://helix.example.com
JWT_SECRET=replace-with-64-random-hex-characters
CREDENTIALS_ENCRYPTION_KEY=replace-with-64-random-hex-characters
```

## Documentation

| Guide | Purpose |
| --- | --- |
| [.env.example](.env.example) | Configuration reference and secure defaults |
| [Deployment](docs/DEPLOYMENT.md) | Local and reverse-proxy deployment |
| [Public deployment](docs/PUBLIC_DEPLOYMENT.md) | Internet-facing threat model and hardening |
| [Security policy](SECURITY.md) | Trust boundaries and vulnerability reporting |
| [Support](SUPPORT.md) | Safe bug reports and diagnostic information |
| [Contributing](CONTRIBUTING.md) | Development and pull-request workflow |
| [Versioning](docs/VERSIONING.md) | Independent semantic-version scheme |
| [Releasing](docs/RELEASING.md) | GitHub and npm maintainer procedure |

## Development

```bash
npm ci --include=dev
npm run dev
```

Before opening a pull request:

```bash
npm run verify
```

Maintainers run `npm run release:check` before publishing. It scans for private
deployment data and secrets, runs stability and security-boundary tests,
type-checks and builds the frontend, packs and installs the npm artifact in a
clean home, verifies runtime isolation, and audits production dependencies.

## Versioning

HelixUI restarts at `1.0.0` under the independent npm package
`@stewiejohn/helixui`. The historical `@stewiejohn/helix-ui@1.23.0` package
belongs to a legacy compatibility line. See
[VERSIONING.md](docs/VERSIONING.md).

## Acknowledgments

HelixUI is a fork of
[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui). The upstream
project supplied the original server architecture, session management, and
multi-agent integration framework.

## License

[AGPL-3.0-or-later](LICENSE). Network users must be offered the corresponding
source as required by the license.
