# Changelog

All notable changes to HelixUI will be documented in this file.


## [1.0.0](https://github.com/Stewie-John/helixUI/compare/v1.23.0...v1.0.0) (2026-07-27)

### New Features

* add hardened public deployment profile ([47b58c9](https://github.com/Stewie-John/helixUI/commit/47b58c9351bfaae2e3fe22a1739b7e52e248c71a))
* add Opus 5 and Sonnet 5 ([7803c46](https://github.com/Stewie-John/helixUI/commit/7803c466753a479d0bab49aa48fe186a18841b79))
* coordinate workspace sidebars ([3b59092](https://github.com/Stewie-John/helixUI/commit/3b59092871975bb8779960dfdf5bb899ce7ed9aa))
* expand the Files workspace ([b0145b4](https://github.com/Stewie-John/helixUI/commit/b0145b4ade1e7c947e9c808ec59fa14109830076))
* export rendered Markdown as PDF ([0f3ab80](https://github.com/Stewie-John/helixUI/commit/0f3ab8025936a29dab38fce933f60025519ed524))
* gate first-run registration behind an optional setup token ([2600c8d](https://github.com/Stewie-John/helixUI/commit/2600c8dfb815a4aaae883933379e76a382e3bb22))
* prepare independent public release ([614ac25](https://github.com/Stewie-John/helixUI/commit/614ac253dba371c346b953f701ec14c5562a2222))
* price model usage in USD ([6819b14](https://github.com/Stewie-John/helixUI/commit/6819b14f363933b5e9c476dfde0514e3e5af2f84))

### Bug Fixes

* allow unauthenticated release dry runs ([cc6fb02](https://github.com/Stewie-John/helixUI/commit/cc6fb0208b76248fcb3a2aea57a2c95b567adcca))
* clarify the Files focus mode ([3113e9b](https://github.com/Stewie-John/helixUI/commit/3113e9b1ca89484c413c2893524b06a75e7bfb0d))
* close remote-clone, workspace and session-scoping holes ([86dc39a](https://github.com/Stewie-John/helixUI/commit/86dc39ac030f2228bbf50506ea13aa7efed6fc91))
* eliminate chat polling initialization hazard ([2a27474](https://github.com/Stewie-John/helixUI/commit/2a274746553d57e4706aa1c7621ee8bbb605ce6a))
* establish independent 1.0.0 package line ([6d5e3d5](https://github.com/Stewie-John/helixUI/commit/6d5e3d505ff4503d402e8ad5b4f4936f0888eeae))
* fail closed when npm status is unavailable ([20deb04](https://github.com/Stewie-John/helixUI/commit/20deb040c253ac671a65cbe1eb8d7fd0d503264e))
* give modals dialog semantics and an escape hatch ([ed53bd9](https://github.com/Stewie-John/helixUI/commit/ed53bd94245655ae490e968182eff0f01b6b13c6))
* include ignored application source in releases ([5f78ef2](https://github.com/Stewie-John/helixUI/commit/5f78ef27f5f2556017b9b6f0dbd1cbab7385f914))
* keep chat pinned to live output ([98e37c3](https://github.com/Stewie-John/helixUI/commit/98e37c35083d84b7433b1cb172093121760436c9))
* keep navigation clear in technology theme ([12a6204](https://github.com/Stewie-John/helixUI/commit/12a62042fc2f7bac472776fe5d2e1ea749dff58a))
* keep the usage panel on the selected provider ([73ed57b](https://github.com/Stewie-John/helixUI/commit/73ed57b4f215c26d78074b462923ddbc317e96b2))
* let release workflow promote the stable version ([084e25f](https://github.com/Stewie-John/helixUI/commit/084e25ff9abb9b1927cfd9a9260ffd7d1a52c3c0))
* make sidebar row actions reachable without a mouse ([c817103](https://github.com/Stewie-John/helixUI/commit/c817103414c16670ec56f8212dfb95e2c562183f))
* measure context usage from the latest turn ([1648091](https://github.com/Stewie-John/helixUI/commit/164809124fa562e49a8c9ec6a748f61f1407c8d9))
* preserve chat turns without page reloads ([920df69](https://github.com/Stewie-John/helixUI/commit/920df6955563c61779c47dbfffe776868176bf1b))
* preserve files view across refreshes ([3c3717e](https://github.com/Stewie-John/helixUI/commit/3c3717e78e60afba9e81e6080597f98c4e5f388c))
* preserve login across permission denials ([75603f2](https://github.com/Stewie-John/helixUI/commit/75603f2446249cf099c5ff5649ea5aa935bb9e05))
* process command acknowledgements without TDZ ([3c75176](https://github.com/Stewie-John/helixUI/commit/3c75176bde34f41c432eaf53a581720b76d8ebc6))
* read Claude limits from the single-view usage screen ([059c0e8](https://github.com/Stewie-John/helixUI/commit/059c0e81bfe558cfa7f429ed4ef76e528a75c4e2))
* recover interrupted releases without republishing ([042edfe](https://github.com/Stewie-John/helixUI/commit/042edfebaefc10a5185effc78a2397a107ecf1b5))
* render LaTeX delimiters in Markdown files ([d0ef4dc](https://github.com/Stewie-John/helixUI/commit/d0ef4dc0c03e7e7d7e03abbffbee6f1c270e8ac9))
* render Markdown files by default ([f3c6756](https://github.com/Stewie-John/helixUI/commit/f3c6756826776fe8b9e32ca5e1242aee906d2e73))
* smooth message delivery and compact composer ([ccf946b](https://github.com/Stewie-John/helixUI/commit/ccf946bde50570a5b24190417d96a92a14b2c3fe))
* stabilize delivery, history, and file refreshes ([1ffb466](https://github.com/Stewie-John/helixUI/commit/1ffb4660bdd8559c7dcbb183e59843664875eb79))
* stop inferring compact continuation chains ([f67d3cb](https://github.com/Stewie-John/helixUI/commit/f67d3cba024c426d0d49fbb95b04c471b3ac789c))
* translate the UI strings that were pinned to Chinese ([9d3a7a7](https://github.com/Stewie-John/helixUI/commit/9d3a7a71312d933f3b26592fc62571312a489b4c))

### Performance

* keep the terminal out of the entry chunk and bound the image cache ([254902d](https://github.com/Stewie-John/helixUI/commit/254902d0f3fa2538a8636e39dc2209f1795fa321))

### Documentation

* add guarded source publishing flow ([cae8036](https://github.com/Stewie-John/helixUI/commit/cae8036c4d27ec282831a700b9869d3ca8c9ecc3))
* point releases to the canonical repository ([024ad8e](https://github.com/Stewie-John/helixUI/commit/024ad8e3ee228f7ee2296b5c1cc0db1522843b2f))
* polish release showcase and HelixUI identity ([b9fbb29](https://github.com/Stewie-John/helixUI/commit/b9fbb29c2c58e5c6f8487535e4be3c545375eac5))
* replace mockups with genuine product captures ([caa67fd](https://github.com/Stewie-John/helixUI/commit/caa67fdf361108dc9771c9c3c56b0defcd5ca683))
* showcase HelixUI visual operations workspace ([4d0b4e0](https://github.com/Stewie-John/helixUI/commit/4d0b4e09c4fdd5565e9648b0dfa4adeb72d3f100))

### Maintenance

* establish hardened public release baseline ([c5237ee](https://github.com/Stewie-John/helixUI/commit/c5237ee4b05ea1c7aca2da011ab6525eb7fce042))
* harden packaged release isolation ([32fb4a5](https://github.com/Stewie-John/helixUI/commit/32fb4a5c77a0ff3587d35c96d2fce0ae905d3f11))
* track the current Claude Agent SDK ([b29e497](https://github.com/Stewie-John/helixUI/commit/b29e497d6112f58b1c51c32a76872bbb216ae99a))

### CI/CD

* build native dependencies before verification ([ff5815f](https://github.com/Stewie-John/helixUI/commit/ff5815fddeda0609f5bf0551d16c1d740b05577c))

### Tests

* enforce packaged API authentication ([a60d6e9](https://github.com/Stewie-John/helixUI/commit/a60d6e94c0871fb5ae154744f1fde795a5a8cecf))

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
