/**
 * Downloads openclaw as a tgz into resources/
 * so it can be bundled as an extraResource in the packaged Electron app.
 *
 * Builds dist/ at pack time if missing (npm packaging bug #49338).
 * The output tgz is ready for end users — no runtime build needed.
 *
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT = path.join(DIST_DIR, 'openclaw.tgz');
const OUTPUT_MANIFEST = path.join(DIST_DIR, 'openclaw.manifest.json');
const TARGET_PLATFORM =
  process.env.npm_config_platform ||
  process.env.NPM_CONFIG_PLATFORM ||
  process.platform;
const TARGET_ARCH =
  process.env.npm_config_arch ||
  process.env.NPM_CONFIG_ARCH ||
  process.arch;

// 支持从命令行传递版本: --version=2026.04.09
const versionArg = process.argv.find((arg) => arg.startsWith('--version='));
const CLI_VERSION = versionArg ? versionArg.split('=')[1] : null;
const DEFAULT_VERSION = '2026.4.9';
const NPM_REGISTRY = 'https://registry.npmjs.org/';

fs.mkdirSync(DIST_DIR, { recursive: true });

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.warn(`[openclaw][diag] Failed to parse JSON ${filePath}: ${error.message}`);
    return null;
  }
}

function logFileSummary(label, filePath, options = {}) {
  const {
    maxChars = 1200,
    patterns = [],
  } = options;

  if (!fs.existsSync(filePath)) {
    console.log(`[openclaw][diag] ${label}: missing (${filePath})`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const preview = content.slice(0, maxChars);
  console.log(`[openclaw][diag] ${label}: ${filePath}`);
  console.log(`[openclaw][diag] ${label} preview (${Math.min(content.length, maxChars)}/${content.length} chars):`);
  console.log(preview);

  for (const pattern of patterns) {
    const index = content.indexOf(pattern);
    if (index === -1) {
      console.log(`[openclaw][diag] ${label} pattern not found: ${pattern}`);
      continue;
    }
    const start = Math.max(0, index - 240);
    const end = Math.min(content.length, index + pattern.length + 480);
    console.log(`[openclaw][diag] ${label} pattern match for "${pattern}" at offset ${index}:`);
    console.log(content.slice(start, end));
  }
}

function logPackageVersion(label, pkgDir, packageName) {
  const pkgJsonPath = path.join(pkgDir, 'node_modules', ...packageName.split('/'), 'package.json');
  const pkgJson = readJsonIfExists(pkgJsonPath);
  if (!pkgJson) {
    console.log(`[openclaw][diag] ${label}: ${packageName} not installed`);
    return;
  }

  console.log(
    `[openclaw][diag] ${label}: ${packageName}@${pkgJson.version} (${pkgJson.type || 'type=unspecified'})`,
  );
}

function logCommandOutput(label, command, cwd) {
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    console.log(`[openclaw][diag] ${label}:`);
    console.log(output || '(empty)');
  } catch (error) {
    console.warn(`[openclaw][diag] ${label} failed: ${error.message}`);
    if (typeof error.stdout === 'string' && error.stdout.trim()) {
      console.warn(`[openclaw][diag] ${label} stdout:`);
      console.warn(error.stdout.trim());
    }
    if (typeof error.stderr === 'string' && error.stderr.trim()) {
      console.warn(`[openclaw][diag] ${label} stderr:`);
      console.warn(error.stderr.trim());
    }
  }
}

function logOpenClawDiagnostics(stage, pkgDir, entryPoint, outputFile) {
  console.log(`[openclaw][diag] ===== ${stage} =====`);
  console.log(
    `[openclaw][diag] env node=${process.version} npm_config_platform=${process.env.npm_config_platform || '(unset)'} npm_config_arch=${process.env.npm_config_arch || '(unset)'} platform=${process.platform} arch=${process.arch} targetPlatform=${TARGET_PLATFORM} targetArch=${TARGET_ARCH}`,
  );

  const openclawPkg = readJsonIfExists(path.join(pkgDir, 'package.json'));
  if (openclawPkg) {
    console.log(
      `[openclaw][diag] openclaw package version=${openclawPkg.version} type=${openclawPkg.type || 'type=unspecified'}`,
    );
    console.log(
      `[openclaw][diag] declared deps: @whiskeysockets/baileys=${openclawPkg.dependencies?.['@whiskeysockets/baileys'] || '(missing)'} protobufjs=${openclawPkg.dependencies?.protobufjs || '(missing)'} libsignal=${openclawPkg.dependencies?.libsignal || '(missing)'}`,
    );
  }

  logCommandOutput('npm version', 'npm --version', pkgDir);
  logPackageVersion(stage, pkgDir, '@whiskeysockets/baileys');
  logPackageVersion(stage, pkgDir, 'libsignal');
  logPackageVersion(stage, pkgDir, 'protobufjs');
  logPackageVersion(stage, pkgDir, '@bufbuild/protobuf');
  logCommandOutput(
    'npm ls @whiskeysockets/baileys protobufjs libsignal @bufbuild/protobuf',
    'npm ls @whiskeysockets/baileys protobufjs libsignal @bufbuild/protobuf --depth=3',
    pkgDir,
  );

  logFileSummary('entry source', entryPoint, {
    maxChars: 1600,
    patterns: ['await init_Defaults', 'init_Defaults', 'Promise.resolve().then(() => (init_'],
  });

  logFileSummary('baileys Defaults', path.join(pkgDir, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Defaults', 'index.js'), {
    maxChars: 1600,
    patterns: ['await ', 'top-level', 'export const', 'export {', 'from '],
  });

  logFileSummary('bundle output', outputFile, {
    maxChars: 1600,
    patterns: ['await init_Defaults', 'init_Defaults', 'var init_Defaults = __esm'],
  });
}

function getDaveyBindingDirName() {
  const platform = TARGET_PLATFORM === 'win32' ? 'win32' : TARGET_PLATFORM === 'darwin' ? 'darwin' : 'linux';
  const arch = TARGET_ARCH === 'arm64' ? 'arm64' : 'x64';
  const suffix = platform === 'win32' ? 'msvc' : platform === 'linux' ? 'gnu' : '';
  return `davey-${platform}-${arch}${suffix ? `-${suffix}` : ''}`;
}

function writeOpenClawManifest(version) {
  const manifest = {
    package: 'openclaw',
    version,
    platform: TARGET_PLATFORM,
    arch: TARGET_ARCH,
    daveyBinding: `@snazzah/${getDaveyBindingDirName()}`,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`[openclaw] Wrote manifest to ${OUTPUT_MANIFEST}`);
}


let version = CLI_VERSION || DEFAULT_VERSION;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-'));
try {
  // Download with npm pack
  execSync(`npm pack openclaw@${version} --registry=${NPM_REGISTRY}`, { cwd: tmpDir, stdio: 'inherit' });
  const files = fs.readdirSync(tmpDir);
  const tgz = files.find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack did not produce a .tgz file');

  const extractDir = path.join(tmpDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  // Extract - run tar from extractDir with relative path to avoid Windows path issues
  console.log(`[openclaw] Extracting ${tgz}...`);
  if (process.platform === 'win32') {
    execSync(`tar -xzf ../${tgz}`, { cwd: extractDir, stdio: 'inherit', shell: true });
  } else {
    execSync(`tar -xzf ../${tgz}`, { cwd: extractDir, stdio: 'inherit' });
  }

  const pkgDir = path.join(extractDir, 'package');
  const pkgJson = readJsonIfExists(path.join(pkgDir, 'package.json'));
  if (pkgJson?.version) {
    version = pkgJson.version;
  }
  const distEntry = path.join(pkgDir, 'dist', 'entry.mjs');
  const distEntryJs = path.join(pkgDir, 'dist', 'entry.js');

  // Install dependencies
  const npmTimeout = 1_200_000;
  console.log(`[openclaw] Installing dependencies (npm, flat structure, registry: ${NPM_REGISTRY}, timeout: ${npmTimeout / 1000}s)...`);
  try {
    execSync(`npm install --omit=dev --legacy-peer-deps --registry=${NPM_REGISTRY}`, {
      cwd: pkgDir,
      stdio: 'inherit',
      timeout: npmTimeout,
    });
  } catch (err) {
    console.error('[openclaw] npm install failed:', err?.message);
    throw new Error('npm install failed. Ensure npm is available and network is stable.');
  }

  const entryPoint = fs.existsSync(distEntry) ? distEntry : distEntryJs;
  const bundleOutput = path.join(pkgDir, 'openclaw.mjs');
  logOpenClawDiagnostics('post-install pre-bundle', pkgDir, entryPoint, bundleOutput);

  // Create launcher.mjs - fixes argv for Commander when run via bundled Node.js
  console.log('[openclaw] Creating launcher.mjs...');
  const launcherContent = `#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openclawPath = path.join(__dirname, 'openclaw.mjs');
let userArgs = process.argv.slice(2);
// Strip leading executable paths so Commander receives correct subcommand
const isExecutablePath = (s) => typeof s === 'string' && (
  /node(\\.exe)?$/i.test(path.basename(s)) || /Sudowork(\\.exe)?$/i.test(path.basename(s))
);
while (userArgs.length > 0 && isExecutablePath(userArgs[0])) userArgs = userArgs.slice(1);
process.argv = ['node', openclawPath, ...userArgs];
await import('./openclaw.mjs');
`;
  fs.writeFileSync(path.join(pkgDir, 'launcher.mjs'), launcherContent, 'utf-8');

  // Bundle openclaw runtime with esbuild (reduces thousands of files to one)
  console.log('[openclaw] Bundling openclaw runtime with esbuild...');
  const bundleScript = path.join(__dirname, 'bundle-openclaw.js');
  try {
    execSync(`node "${bundleScript}" "${pkgDir}"`, {
      stdio: 'inherit',
      timeout: 300_000, // 5 minutes
    });
    console.log('[openclaw] Bundle completed successfully.');
    logOpenClawDiagnostics('post-bundle', pkgDir, entryPoint, bundleOutput);
  } catch (err) {
    console.error(`[openclaw] Bundle failed: ${err?.message}`);
    logOpenClawDiagnostics('bundle-failed', pkgDir, entryPoint, bundleOutput);
    throw err;
  }

  writeOpenClawManifest(version);

  // Create final tarball - run from extractDir to avoid path issues
  console.log('[openclaw] Creating final tarball...');
  if (process.platform === 'win32') {
    const tmpOutput = path.join(extractDir, 'openclaw.tgz');
    try {
      execSync(`tar -czf openclaw.tgz package`, { cwd: extractDir, stdio: 'inherit', shell: true });
    } catch (e) {
      if (!fs.existsSync(tmpOutput)) throw e;
    }
    fs.copyFileSync(tmpOutput, OUTPUT);
  } else {
    execSync(`tar -czf "${OUTPUT}" -C "${extractDir}" package`, { stdio: 'inherit' });
  }

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`[openclaw] Saved to ${OUTPUT}`);
