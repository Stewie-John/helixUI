# Versioning

HelixUI uses its own semantic-version sequence independently of the upstream
project from which it was originally forked.

Versions have the form:

```text
MAJOR.MINOR.PATCH
```

- `MAJOR` changes for incompatible behavior or migration requirements.
- `MINOR` changes for backward-compatible features.
- `PATCH` changes for backward-compatible fixes.

The first independent stable release is `1.0.0` under the npm package:

```text
@stewiejohn/helixui
```

The historical package `@stewiejohn/helix-ui@1.23.0` belongs to a
pre-independent compatibility line that inherited another project's version
number. It is not part of HelixUI's new sequence and will be deprecated in npm
with an upgrade notice pointing to the independent package.
