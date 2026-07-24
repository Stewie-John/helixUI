# Versioning

HelixUI uses calendar versioning independently of the upstream project from
which it was originally forked.

Versions have the form:

```text
YYYY.M.PATCH
```

- `YYYY` is the release year.
- `M` is the release month without a leading zero.
- `PATCH` starts at `0` for the first release in that month and increments for
  compatible follow-up releases.

Examples:

- `2026.7.0`: first July 2026 release
- `2026.7.1`: compatible July 2026 correction
- `2026.8.0`: first August 2026 release

Breaking changes are called out explicitly in the changelog and release notes.
Calendar versions are valid semantic versions and can be published through npm.

The historical `1.23.0` package was a pre-independent compatibility release
whose number followed the inherited codebase. It is not the predecessor of a
similarly numbered upstream release and is not used as the basis for future
HelixUI version numbers.
