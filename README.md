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
node scripts/download-openclaw.js --version=2026.4.9
node scripts/download-openclaw.js --version=latest
```

Artifacts are written to `dist/`.

## CI

GitHub Actions workflow: `.github/workflows/build-openclaw.yml`

It can:

- build matrix artifacts for macOS and Windows
- upload workflow artifacts
- optionally create a GitHub Release with renamed assets like:
  - `v0.1.0-v2026.04.09-sudoclaw-macos-arm64.tgz`
  - `v0.1.0-v2026.04.09-sudoclaw-macos-x64.tgz`
  - `v0.1.0-v2026.04.09-sudoclaw-windows-arm64.tgz`
  - `v0.1.0-v2026.04.09-sudoclaw-windows-x64.tgz`
