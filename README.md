<div align="center">
  <img src="public/logo.svg" alt="HelixUI" width="72" height="72">
  <h1>HelixUI</h1>
  <p>A responsive web interface for local AI coding agents.</p>
</div>

<p align="center">
  <a href="https://github.com/StewartJohn0/helixui/actions/workflows/ci.yml"><img src="https://github.com/StewartJohn0/helixui/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0-or-later"></a>
  <a href="./README.zh-CN.md">中文</a>
</p>

HelixUI runs Claude Code, OpenAI Codex, Cursor CLI, Gemini CLI, and custom
OpenAI-compatible providers from one browser UI. It includes persistent chat,
streaming tool output, reconnectable shell and terminal sessions, file editing,
Git workflows, session organization, voice-to-text, usage panels, and responsive
desktop/mobile layouts.

## Security model

The server can run shell commands with the permissions of its Unix account.
Keep the default localhost binding unless an authenticated HTTPS reverse proxy
and firewall protect the service. Application accounts are not an OS sandbox;
use separate instances or containers for mutually untrusted users. Read
[SECURITY.md](SECURITY.md) before network deployment.

## Requirements

- Node.js 22 or newer
- At least one supported agent CLI installed and authenticated
- Linux or macOS for the full PTY experience

## Install from source

```bash
git clone https://github.com/StewartJohn0/helixui.git
cd helixui
npm ci --include=dev
cp .env.example .env
npm run build
npm run server
```

Open `http://127.0.0.1:3001`. The first account becomes the administrator and
public registration closes immediately afterward.

Runtime state is stored outside the repository under `~/.cloudcli`; workspaces
default to `~/CloudCLIWorkspaces`.

## npm installation

After an npm release is published:

```bash
npm install -g @stewiejohn/helix-ui
helix-ui
```

## Configuration

The secure defaults work locally. Common overrides are:

```env
HOST=127.0.0.1
PORT=3001
WORKSPACES_ROOT=/absolute/path/to/dedicated/workspaces
CLOUDCLI_DATA_DIR=/absolute/path/to/persistent/private/data
CORS_ORIGIN=https://helix.example.com
JWT_SECRET=replace-with-64-random-hex-characters
CREDENTIALS_ENCRYPTION_KEY=replace-with-64-random-hex-characters
```

See [.env.example](.env.example), [deployment guidance](docs/DEPLOYMENT.md),
and the hardened [public deployment guide](docs/PUBLIC_DEPLOYMENT.md).

## Development

```bash
npm ci --include=dev
npm run dev
```

Before opening a pull request:

```bash
npm run verify
```

`verify` scans for private deployment data and secrets, runs protocol and
security tests, type-checks the frontend, and creates a production build.
Maintainers use `npm run release:check`, which additionally installs the packed
artifact in a clean home, starts it to verify runtime isolation, and audits the
production dependency tree that consumers receive.

## Releases

Releases use semantic Git tags and immutable GitHub releases. See
[docs/RELEASING.md](docs/RELEASING.md). Do not commit `.env`, databases,
certificates, logs, screenshots from real deployments, or AI session data.

## Acknowledgments

HelixUI is a fork of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui),
distributed under AGPL-3.0-or-later. The upstream project supplied the original
server architecture, session management, and multi-agent integration framework.

## License

[AGPL-3.0-or-later](LICENSE). Network users must be offered the corresponding
source as required by the license.
