#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT = path.join(DIST_DIR, 'openclaw.tgz');
const MANIFEST_OUTPUT = path.join(DIST_DIR, 'openclaw.manifest.json');

const args = process.argv.slice(2);
const force = args.includes('--force');
const versionArg = args.find((arg) => arg.startsWith('--version='));
const requestedVersion = versionArg ? versionArg.split('=')[1] : 'latest';
const npmRegistry = 'https://registry.npmjs.org/';
const EXEC_TIMEOUT = 20 * 60 * 1000; // 20 minutes
const targetPlatform =
  process.env.npm_config_platform ||
  process.env.NPM_CONFIG_PLATFORM ||
  process.platform;
const targetArch =
  process.env.npm_config_arch ||
  process.env.NPM_CONFIG_ARCH ||
  process.arch;

fs.mkdirSync(DIST_DIR, { recursive: true });

function log(message) {
  console.log(`[openclaw-builder] ${message}`);
}

function run(command, options = {}) {
  const env = { ...process.env };
  if (!env.HOME && process.platform === 'win32') {
    env.HOME = env.USERPROFILE || 'C:\\Users\\runneradmin';
  }
  execSync(command, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: EXEC_TIMEOUT,
    env,
    ...options,
  });
}

function runCapture(command, options = {}) {
  return execSync(command, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT,
    ...options,
  }).trim();
}

function getDaveyBindingDirName() {
  const platform =
    targetPlatform === 'win32'
      ? 'win32'
      : targetPlatform === 'darwin'
        ? 'darwin'
        : 'linux';
  const arch = targetArch === 'arm64' ? 'arm64' : 'x64';
  const suffix = platform === 'win32' ? 'msvc' : platform === 'linux' ? 'gnu' : '';
  return `davey-${platform}-${arch}${suffix ? `-${suffix}` : ''}`;
}

function resolveVersion(input) {
  const spec = input ? `openclaw@${input}` : 'openclaw';
  const raw = runCapture(`npm view ${spec} version --registry=${npmRegistry}`);
  if (!raw) {
    throw new Error(`Failed to resolve ${spec} from npm`);
  }

  return raw;
}

function removeIfExists(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function writeManifest(version) {
  const manifest = {
    package: 'openclaw',
    version,
    platform: targetPlatform,
    arch: targetArch,
    daveyBinding: `@snazzah/${getDaveyBindingDirName()}`,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(MANIFEST_OUTPUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  log(`Wrote manifest: ${MANIFEST_OUTPUT}`);
}

function ensureBuildArtifacts(pkgDir) {
  const distEntryMjs = path.join(pkgDir, 'dist', 'entry.mjs');
  const distEntryJs = path.join(pkgDir, 'dist', 'entry.js');

  if (fs.existsSync(distEntryMjs) || fs.existsSync(distEntryJs)) {
    return;
  }

  log('Published package has no dist/, installing full deps and building');

  const installCandidates = [
    `npm install --legacy-peer-deps --registry=${npmRegistry}`,
    'pnpm install',
  ];
  const buildCandidates = ['npm run build', 'pnpm build'];

  let built = false;

  for (const installCmd of installCandidates) {
    for (const buildCmd of buildCandidates) {
      try {
        run(installCmd, { cwd: pkgDir });
        run(buildCmd, { cwd: pkgDir });
        built = fs.existsSync(distEntryMjs) || fs.existsSync(distEntryJs);
        if (built) {
          log(`Build completed with "${installCmd}" + "${buildCmd}"`);
          return;
        }
      } catch (error) {
        log(`Build attempt failed: ${installCmd} && ${buildCmd}`);
      }
    }
  }

  if (!built) {
    throw new Error('Build completed but dist/entry.(m)js is still missing');
  }
}

function writeLauncher(pkgDir) {
  const launcherContent = `#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openclawPath = path.join(__dirname, 'openclaw.mjs');
let userArgs = process.argv.slice(2);
const isExecutablePath = (s) =>
  typeof s === 'string' &&
  (/node(\\\\.exe)?$/i.test(path.basename(s)) || /Sudowork(\\\\.exe)?$/i.test(path.basename(s)));
while (userArgs.length > 0 && isExecutablePath(userArgs[0])) userArgs = userArgs.slice(1);
process.argv = ['node', openclawPath, ...userArgs];
await import('./openclaw.mjs');
`;

  fs.writeFileSync(path.join(pkgDir, 'launcher.mjs'), launcherContent, 'utf8');

  const binDir = path.join(pkgDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const unixWrapper = `#!/bin/sh
CLI="$(dirname "$0")/../launcher.mjs"
STATE_DIR="${HOME}/.nexus/sudoclaw"
BUNDLED_NODE="${HOME}/.nexus/node/bin/node"

if [ ! -x "$BUNDLED_NODE" ]; then
  echo "Error: Bundled Node.js not found at $BUNDLED_NODE" >&2
  echo "Please restart Sudowork to install it." >&2
  exit 1
fi

exec env OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$STATE_DIR/sudoclaw.json" "$BUNDLED_NODE" "$CLI" "$@"
`;

  fs.writeFileSync(path.join(binDir, 'openclaw'), unixWrapper, { mode: 0o755 });

  const windowsWrapper = `@echo off
set "CLI=%~dp0..\\launcher.mjs"
set "OPENCLAW_STATE_DIR=%USERPROFILE%\\.nexus\\sudoclaw"
set "OPENCLAW_CONFIG_PATH=%USERPROFILE%\\.nexus\\sudoclaw\\sudoclaw.json"
set "BUNDLED_NODE=%USERPROFILE%\\.nexus\\node\\node.exe"

if not exist "%BUNDLED_NODE%" (
  echo Error: Bundled Node.js not found at %BUNDLED_NODE%
  echo Please restart Sudowork to install it.
  exit /b 1
)

"%BUNDLED_NODE%" "%CLI%" %*
`;

  fs.writeFileSync(path.join(binDir, 'openclaw.cmd'), windowsWrapper.replace(/\n/g, '\r\n'), 'utf8');
}

function createArchive(extractDir) {
  log(`Creating archive: ${OUTPUT}`);

  if (process.platform === 'win32') {
    const tmpOutput = path.join(extractDir, 'openclaw.tgz');
    run('tar -czf openclaw.tgz package', { cwd: extractDir });
    fs.copyFileSync(tmpOutput, OUTPUT);
    return;
  }

  run(`tar -czf "${OUTPUT}" -C "${extractDir}" package`);
}

function main() {
  const version = resolveVersion(requestedVersion);

  log(`Building openclaw@${version} for ${targetPlatform}-${targetArch}`);

  if (force) {
    removeIfExists(OUTPUT);
    removeIfExists(MANIFEST_OUTPUT);
  }

  if (fs.existsSync(OUTPUT) && fs.existsSync(MANIFEST_OUTPUT) && !force) {
    log('Archive already exists, skipping. Use --force to rebuild.');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-builder-'));

  try {
    run(`npm pack openclaw@${version} --registry=${npmRegistry}`, { cwd: tmpDir });

    const packedFile = fs.readdirSync(tmpDir).find((entry) => entry.endsWith('.tgz'));
    if (!packedFile) {
      throw new Error('npm pack did not produce a .tgz file');
    }

    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    run(`tar -xzf ../${packedFile}`, { cwd: extractDir });

    const pkgDir = path.join(extractDir, 'package');
    if (!fs.existsSync(pkgDir)) {
      throw new Error('Extracted package directory not found');
    }

    log('Installing runtime dependencies');
    run(`npm install --omit=dev --legacy-peer-deps --registry=${npmRegistry}`, {
      cwd: pkgDir,
    });

    ensureBuildArtifacts(pkgDir);
    writeLauncher(pkgDir);
    writeManifest(version);
    createArchive(extractDir);

    log(`Saved archive: ${OUTPUT}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[openclaw-builder] ${error.message}`);
  process.exit(1);
}
