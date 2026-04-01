# sudorepo

Build and publish platform-specific `openclaw.tgz` bundles in a standalone repo.

## What this repo does

- Downloads `openclaw` from npm
- Installs platform-specific runtime dependencies
- Builds `dist/` when the published package does not include it
- Wraps the CLI so Sudowork can launch it with its bundled Node.js
- Produces `openclaw.tgz` plus `openclaw.manifest.json`

## Local usage

```bash
npm run build:openclaw
```

Optional flags:

```bash
node scripts/build-openclaw-tgz.js --version=2026.3.11
node scripts/build-openclaw-tgz.js --version=latest --force
```

Artifacts are written to `dist/`.

## CI

GitHub Actions workflow: `.github/workflows/build-openclaw.yml`

It can:

- build matrix artifacts for macOS and Windows
- upload workflow artifacts
- optionally create a GitHub Release with renamed assets like:
  - `openclaw-macos-arm64.tgz`
  - `openclaw-macos-x64.tgz`
  - `openclaw-windows-arm64.tgz`
  - `openclaw-windows-x64.tgz`
