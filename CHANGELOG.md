# Changelog

All notable changes to HelixUI are documented here.

## Unreleased

The next release starts HelixUI's independent semantic-versioned release line.
The planned first stable version is `1.0.0`, published under the independent
npm package `@stewiejohn/helixui`.

### Reliability

- Keep productive Codex tasks running across app-server turn boundaries when a
  turn ends without a final answer, including safe context compaction,
  reconnect-visible status, queued follow-ups, and bounded idle recovery.
- Preserve visible user-turn boundaries and optimistic send state while server
  acknowledgements, reconnects, and history reconciliation are in progress.
- Recover active work state after refresh without replaying commands or
  completing parent turns from sub-agent output.
- Coalesce safe restart requests and wait for active turns before deployment.

### Interface

- Stabilize initial and streaming bottom-follow behavior while respecting
  deliberate upward scrolling.
- Keep the three-position appearance control geometrically stable and place
  the technology theme at the rightmost position.
- Improve responsive usage details, active-session timestamps, turn status,
  and compact tool-output presentation.

### Security and release engineering

- Upgrade React Router to a release that fixes the open-redirect and SSR error
  deserialization advisories.
- Verify workspace confinement, symlink escapes, WebSocket origins, host
  allowlists, authentication failures, package installation, runtime-data
  isolation, and production dependency advisories before release.
- Publish the npm package with public access and provenance from the protected
  GitHub Actions release workflow.

## Legacy package release 1.23.0 - 2026-07-22

Pre-independent compatibility release published as
`@stewiejohn/helix-ui@1.23.0` using an inherited upstream version sequence.
Independent HelixUI releases use the new `@stewiejohn/helixui` package and
restart at `1.0.0`.

- Added reconnect-safe command acknowledgement and replay deduplication.
- Stabilized streaming chat, active-turn recovery, terminal persistence, and shell mirroring.
- Added Codex, Claude, Cursor, Gemini, custom-provider, usage, goal, voice-input,
  file-tree, and Git workflow improvements.
- Moved runtime data outside the source tree and restricted workspace access.
- Added privacy scanning, security-boundary tests, CI, semantic releases, and
  public deployment documentation.

Earlier upstream history is available in
[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui/releases).
