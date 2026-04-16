#!/usr/bin/env node

/**
 * Bundle openclaw runtime into a single aggregated JS file using esbuild.
 *
 * Reduces the thousands of files in node_modules/ down to one `openclaw.mjs`
 * plus only the native addon directories that cannot be bundled.
 *
 * Usage:
 *   node scripts/bundle-openclaw.js <package-dir>
 *
 * The script:
 *   1. Discovers native addons (.node files) and marks them external
 *   2. Bundles dist/entry.js (or dist/entry.mjs) + all JS deps into openclaw.mjs
 *   3. Cleans node_modules/ to keep only native binding directories
 *   4. Writes bundle-manifest.json for downstream validation
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bundled extensions to exclude from packaged artifacts for the lean runtime. */
const EXCLUDED_BUNDLED_EXTENSION_DIRS = new Set([
  'amazon-bedrock',
  'amazon-bedrock-mantle',
  'bluebubbles',
  'diagnostics-otel',
  'discord',
  'diffs',
  'googlechat',
  'imessage',
  'irc',
  'line',
  'matrix',
  'mattermost',
  'memory-lancedb',
  'minimax',
  'msteams',
  'nextcloud-talk',
  'nostr',
  'qqbot',
  'slack',
  'synology-chat',
  'telegram',
  'tlon',
  'twitch',
  'vydra',
  'whatsapp',
  'zalo',
  'zalouser',
]);

/** Packages that the core runtime still loads indirectly via bundled config/text surfaces. */
const REQUIRED_RUNTIME_PACKAGES = [
  'markdown-it',
  'playwright-core',
  'tar',
];

/** Packages that use dynamic require/import or optional native bindings.
 *  These are externalized so esbuild doesn't try to resolve them at bundle time. */
const KNOWN_OPTIONAL_EXTERNALS = [
  // Runtime loaders with relative self-references that break when inlined.
  'jiti',
  '@mariozechner/jiti',
  // LLM / AI
  'node-llama-cpp',
  // Media
  'ffmpeg-static',
  '@discordjs/opus',
  'node-opus',
  'opusscript',
  'sodium',
  'sodium-native',
  'libsodium-wrappers',
  'tweetnacl',
  'erlpack',
  'bufferutil',
  'utf-8-validate',
  'zlib-sync',
  'cpu-features',
  // File type detection
  'file-type',
  // Playwright / Chromium
  'playwright',
  'playwright-core',
  'chromium-bidi',
  'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
  'chromium-bidi/lib/cjs/cdp/CdpConnection',
  // Native / platform
  'koffi',
  // Sharp platform variants
  '@img/sharp-darwin-arm64',
  '@img/sharp-darwin-x64',
  '@img/sharp-linux-arm',
  '@img/sharp-linux-arm64',
  '@img/sharp-linux-s390x',
  '@img/sharp-linux-x64',
  '@img/sharp-linuxmusl-arm64',
  '@img/sharp-linuxmusl-x64',
  '@img/sharp-wasm32',
  '@img/sharp-win32-ia32',
  '@img/sharp-win32-x64',
  // Node-pty platform variants
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-arm64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-x64',
  // Clipboard platform variants
  '@mariozechner/clipboard-darwin-arm64',
  '@mariozechner/clipboard-darwin-x64',
  '@mariozechner/clipboard-linux-arm64-gnu',
  '@mariozechner/clipboard-linux-x64-gnu',
  '@mariozechner/clipboard-win32-x64-msvc',
  // Canvas platform variants
  '@napi-rs/canvas-darwin-arm64',
  '@napi-rs/canvas-darwin-x64',
  '@napi-rs/canvas-linux-arm64-gnu',
  '@napi-rs/canvas-linux-arm64-musl',
  '@napi-rs/canvas-linux-x64-gnu',
  '@napi-rs/canvas-linux-x64-musl',
  '@napi-rs/canvas-win32-x64-msvc',
  // Davey platform variants
  '@snazzah/davey-darwin-arm64',
  '@snazzah/davey-darwin-x64',
  '@snazzah/davey-linux-arm64-gnu',
  '@snazzah/davey-linux-x64-gnu',
  '@snazzah/davey-win32-x64-msvc',
];

/** Node.js built-in modules (with and without node: prefix) */
function getNodeBuiltins() {
  const builtins = [
    'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process',
    'cluster', 'console', 'constants', 'crypto', 'dgram',
    'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events',
    'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
    'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix',
    'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring',
    'readline', 'readline/promises', 'repl', 'sea', 'sqlite', 'stream',
    'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder',
    'sys', 'test', 'test/reporters', 'timers', 'timers/promises', 'tls',
    'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm',
    'wasi', 'worker_threads', 'zlib',
  ];
  const result = [];
  for (const b of builtins) {
    result.push(b, `node:${b}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countFiles(dir) {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else count++;
    }
  };
  walk(dir);
  return count;
}

function getPackageNameFromSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null;
  }

  if (/^[A-Za-z]:[\\/]/.test(specifier)) {
    return null;
  }

  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  const [pkgName] = specifier.split('/');
  return pkgName || null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function isLikelyPackageName(packageName) {
  return /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)$/i.test(packageName);
}

function collectRuntimeRequirePackages(bundleFile, builtins) {
  const packages = new Set();
  const jsFiles = [];

  const addJsFiles = (targetPath) => {
    if (!targetPath || !fs.existsSync(targetPath)) return;

    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
        addJsFiles(path.join(targetPath, entry.name));
      }
      return;
    }

    if (!/\.(?:[cm]?js)$/i.test(targetPath)) return;
    jsFiles.push(targetPath);
  };

  for (const target of Array.isArray(bundleFile) ? bundleFile : [bundleFile]) {
    addJsFiles(target);
  }

  const patterns = [
    /\brequire\d*\((['"])([^"'./][^"']*)\1\)/g,
    /\bimport\s*\((['"])([^"'./][^"']*)\1\)/g,
    /^\s*(?:import|export)\s+[^'"\n]*?\sfrom\s+(['"])([^"'./][^"']*)\1/gm,
    /^\s*import\s+(['"])([^"'./][^"']*)\1/gm,
  ];

  for (const filePath of jsFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const specifier = match[2];
        const pkgName = getPackageNameFromSpecifier(specifier);
        if (!pkgName || !isLikelyPackageName(pkgName) || builtins.has(specifier) || builtins.has(pkgName)) continue;
        packages.add(pkgName);
      }
    }
  }

  return [...packages].sort();
}

function collectBundleExternalPackages(metafile, outputFile, builtins) {
  if (!metafile || !metafile.outputs) return [];

  const resolvedOutput = path.resolve(outputFile);
  const outputEntry = Object.entries(metafile.outputs).find(([filePath]) => path.resolve(filePath) === resolvedOutput);
  if (!outputEntry) return [];

  const [, outputMeta] = outputEntry;
  const packages = new Set();

  for (const imported of outputMeta.imports || []) {
    if (!imported.external) continue;

    const pkgName = getPackageNameFromSpecifier(imported.path);
    if (!pkgName || !isLikelyPackageName(pkgName) || builtins.has(imported.path) || builtins.has(pkgName)) continue;
    packages.add(pkgName);
  }

  return [...packages].sort();
}

function collectTransitivePackageDeps(pkgDir, packageNames) {
  const nmDir = path.join(pkgDir, 'node_modules');
  const keepPackages = new Set();
  const visited = new Set();
  const queue = [...packageNames];

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || visited.has(packageName)) continue;
    visited.add(packageName);

    const packageDir = path.join(nmDir, packageName);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    keepPackages.add(packageName);

    const pkgJson = readJsonFile(packageJsonPath);
    if (!pkgJson || typeof pkgJson !== 'object') continue;

    const dependencySets = [
      pkgJson.dependencies,
      pkgJson.optionalDependencies,
    ];

    for (const deps of dependencySets) {
      if (!deps || typeof deps !== 'object') continue;
      for (const depName of Object.keys(deps)) {
        if (!visited.has(depName)) {
          queue.push(depName);
        }
      }
    }
  }

  return [...keepPackages].sort();
}

function collectNestedPackageTreeDeps(pkgDir, packageNames) {
  const nmDir = path.join(pkgDir, 'node_modules');
  const depNames = new Set();
  const visitedPackageDirs = new Set();
  const queue = [];

  for (const packageName of packageNames) {
    const packageDir = path.join(nmDir, packageName);
    if (fs.existsSync(packageDir)) {
      queue.push(packageDir);
    }
  }

  while (queue.length > 0) {
    const packageDir = queue.shift();
    if (!packageDir || visitedPackageDirs.has(packageDir)) continue;
    visitedPackageDirs.add(packageDir);

    const packageJsonPath = path.join(packageDir, 'package.json');
    const pkgJson = readJsonFile(packageJsonPath);
    if (pkgJson && typeof pkgJson === 'object') {
      const dependencySets = [
        pkgJson.dependencies,
        pkgJson.optionalDependencies,
      ];

      for (const deps of dependencySets) {
        if (!deps || typeof deps !== 'object') continue;
        for (const depName of Object.keys(deps)) {
          depNames.add(depName);
        }
      }
    }

    const nestedNodeModulesDir = path.join(packageDir, 'node_modules');
    if (!fs.existsSync(nestedNodeModulesDir)) continue;

    for (const entry of fs.readdirSync(nestedNodeModulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      if (entry.name.startsWith('@')) {
        const scopeDir = path.join(nestedNodeModulesDir, entry.name);
        for (const scopedEntry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
          if (!scopedEntry.isDirectory()) continue;
          queue.push(path.join(scopeDir, scopedEntry.name));
        }
        continue;
      }

      queue.push(path.join(nestedNodeModulesDir, entry.name));
    }
  }

  return [...depNames].sort();
}

function collectBundledExtensionDeclaredPackages(extensionsDir, dirNames = null) {
  if (!extensionsDir || !fs.existsSync(extensionsDir)) return [];

  const packageNames = new Set();
  const selectedDirNames = dirNames ? new Set(dirNames) : null;

  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (selectedDirNames && !selectedDirNames.has(entry.name)) continue;

    const packageJson = readJsonFile(path.join(extensionsDir, entry.name, 'package.json'));
    if (!packageJson || typeof packageJson !== 'object') continue;

    for (const deps of [packageJson.dependencies, packageJson.optionalDependencies]) {
      if (!deps || typeof deps !== 'object') continue;
      for (const packageName of Object.keys(deps)) {
        if (!isLikelyPackageName(packageName)) continue;
        packageNames.add(packageName);
      }
    }
  }

  return [...packageNames].sort();
}

/** Find native addon packages by scanning for .node files in node_modules */
function discoverNativeExternals(pkgDir) {
  const nmDir = path.join(pkgDir, 'node_modules');
  if (!fs.existsSync(nmDir)) return [];

  const nativePackages = new Set();

  const walk = (dir, depth) => {
    if (depth > 4) return; // Don't recurse too deep
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('@')) {
          // Scoped package - go one level deeper
          walk(full, depth);
        } else if (entry.name !== '.package-lock.json') {
          walk(full, depth + 1);
        }
      } else if (entry.name.endsWith('.node')) {
        // Determine the package name from the path
        const rel = path.relative(nmDir, full);
        const parts = rel.split(path.sep);
        const pkgName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
        nativePackages.add(pkgName);
      }
    }
  };

  walk(nmDir, 0);
  return [...nativePackages];
}

/** Get directories that should be kept in node_modules */
function getNativeModuleDirs(pkgDir, packageNames) {
  const nmDir = path.join(pkgDir, 'node_modules');
  const keepDirs = new Set();

  for (const packageName of packageNames) {
    const extPath = path.join(nmDir, packageName);
    if (fs.existsSync(extPath)) {
      keepDirs.add(packageName);
      // For scoped packages, also keep the scope directory
      if (packageName.startsWith('@')) {
        keepDirs.add(packageName.split('/')[0]);
      }
    }
  }

  return keepDirs;
}

function getCurrentKoffiBinaryDirName() {
  const platformMap = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'win32',
    freebsd: 'freebsd',
    openbsd: 'openbsd',
  };
  const archMap = {
    arm64: 'arm64',
    x64: 'x64',
    ia32: 'ia32',
    arm: 'armhf',
    loong64: 'loong64',
    riscv64: 'riscv64d',
  };

  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) return null;

  return `${platform}_${arch}`;
}

function pruneKoffiNativeBinaries(pkgDir) {
  const koffiDir = path.join(pkgDir, 'node_modules', 'koffi', 'build', 'koffi');
  if (!fs.existsSync(koffiDir)) return;

  const keepDirName = getCurrentKoffiBinaryDirName();
  if (!keepDirName) {
    console.warn(`[bundle-openclaw] Unknown koffi target for ${process.platform}/${process.arch}; skipping koffi binary pruning.`);
    return;
  }

  const entries = fs.readdirSync(koffiDir, { withFileTypes: true });
  let removedCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === keepDirName) continue;
    fs.rmSync(path.join(koffiDir, entry.name), { recursive: true, force: true });
    removedCount++;
  }

  console.log(`[bundle-openclaw] Pruned koffi binaries to ${keepDirName} (removed ${removedCount} platform directories)`);
}

function pruneDocsToRuntimeSubset(pkgDir) {
  const docsDir = path.join(pkgDir, 'docs');
  const templatesDir = path.join(docsDir, 'reference', 'templates');
  if (!fs.existsSync(docsDir)) return;

  if (!fs.existsSync(templatesDir)) {
    console.warn('[bundle-openclaw] docs/reference/templates missing; leaving docs/ untouched.');
    return;
  }

  const tempDir = path.join(pkgDir, '.openclaw-docs-templates');
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(tempDir), { recursive: true });
  fs.cpSync(templatesDir, tempDir, { recursive: true });

  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(docsDir, 'reference'), { recursive: true });
  fs.cpSync(tempDir, path.join(docsDir, 'reference', 'templates'), { recursive: true });
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('[bundle-openclaw] Pruned docs/ to docs/reference/templates only');
}

function pruneNonRuntimeFiles(pkgDir) {
  const removableDirNames = new Set([
    '.bin',
  ]);

  const removableDirPrefixes = [
    '.ignored',
    '.cache',
  ];

  const removableFilePatterns = [
    /\.d\.(?:ts|mts|cts)$/i,
    /\.map$/i,
    /\.test\.(?:[cm]?js|[cm]?ts|tsx|mts)$/i,
    /\.spec\.(?:[cm]?js|[cm]?ts|tsx|mts)$/i,
  ];

  let removedFiles = 0;
  let removedDirs = 0;

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (removableDirNames.has(entry.name) || removableDirPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedDirs++;
          continue;
        }

        walk(fullPath);
        continue;
      }

      if (removableFilePatterns.some((pattern) => pattern.test(entry.name))) {
        fs.rmSync(fullPath, { force: true });
        removedFiles++;
      }
    }
  };

  walk(pkgDir);

  const packageLockPath = path.join(pkgDir, 'package-lock.json');
  if (fs.existsSync(packageLockPath)) {
    fs.rmSync(packageLockPath, { force: true });
    removedFiles++;
  }

  const scriptsDir = path.join(pkgDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    fs.rmSync(scriptsDir, { recursive: true, force: true });
    removedDirs++;
  }

  console.log(`[bundle-openclaw] Pruned non-runtime files: removed ${removedFiles} files and ${removedDirs} directories`);
}

function pruneExcludedBundledExtensions(pkgDir) {
  const extensionsDir = path.join(pkgDir, 'dist', 'extensions');
  if (!fs.existsSync(extensionsDir)) return [];

  const removed = [];
  for (const dirName of EXCLUDED_BUNDLED_EXTENSION_DIRS) {
    const fullPath = path.join(extensionsDir, dirName);
    if (!fs.existsSync(fullPath)) continue;
    fs.rmSync(fullPath, { recursive: true, force: true });
    removed.push(dirName);
  }

  if (removed.length > 0) {
    console.log(`[bundle-openclaw] Removed bundled extensions: ${removed.join(', ')}`);
  }

  return removed.sort();
}

function rewriteBundledRuntimeCandidatePaths(bundleFile) {
  if (!fs.existsSync(bundleFile)) return;

  const replacements = [
    [
      'RUNTIME_MODULE_CANDIDATES = ["./runtime.js", "./runtime.ts"];',
      'RUNTIME_MODULE_CANDIDATES = ["./dist/runtime.js", "./dist/runtime.ts"];',
    ],
    [
      'SETUP_REGISTRY_RUNTIME_CANDIDATES = ["./setup-registry.js", "./setup-registry.ts"];',
      'SETUP_REGISTRY_RUNTIME_CANDIDATES = ["./dist/setup-registry.js", "./dist/setup-registry.ts"];',
    ],
    [
      'PROVIDER_RUNTIME_CANDIDATES = ["../plugins/provider-runtime.js", "../plugins/provider-runtime.ts"];',
      'PROVIDER_RUNTIME_CANDIDATES = ["./dist/plugins/provider-runtime.js", "./dist/plugins/provider-runtime.ts"];',
    ],
    [
      'FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = ["./facade-activation-check.runtime.js", "./facade-activation-check.runtime.ts"];',
      'FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = ["./dist/facade-activation-check.runtime.js", "./dist/facade-activation-check.runtime.ts"];',
    ],
  ];

  let content = fs.readFileSync(bundleFile, 'utf-8');
  let changed = 0;

  for (const [from, to] of replacements) {
    if (!content.includes(from)) continue;
    content = content.replaceAll(from, to);
    changed++;
  }

  if (changed > 0) {
    fs.writeFileSync(bundleFile, content, 'utf-8');
    console.log(`[bundle-openclaw] Rewrote ${changed} bundled runtime candidate path groups`);
  }
}

function rewriteGatewayStartupForEarlyHealth(bundleFile) {
  if (!fs.existsSync(bundleFile)) return;

  const sessionMigrationNeedle = [
    '  if (!minimalTestGateway) {',
    '    await runChannelPluginStartupMaintenance({',
    '      cfg: startupMaintenanceConfig,',
    '      env: process.env,',
    '      log: log46',
    '    });',
    '    await runStartupSessionMigration({',
    '      cfg: cfgAtStart,',
    '      env: process.env,',
    '      log: log46',
    '    });',
    '  }',
  ].join('\n');

  const sessionMigrationReplacement = [
    '  if (!minimalTestGateway) {',
    '    await runChannelPluginStartupMaintenance({',
    '      cfg: startupMaintenanceConfig,',
    '      env: process.env,',
    '      log: log46',
    '    });',
    '    void runStartupSessionMigration({',
    '      cfg: cfgAtStart,',
    '      env: process.env,',
    '      log: log46',
    '    });',
    '  }',
  ].join('\n');

  const startupBlockNeedle = [
    '    if (!minimalTestGateway) {',
    '      if (deferredConfiguredChannelPluginIds.length > 0) ({ pluginRegistry } = reloadDeferredGatewayPlugins({',
    '        cfg: gatewayPluginConfigAtStart,',
    '        workspaceDir: defaultWorkspaceDir,',
    '        log: log46,',
    '        coreGatewayHandlers,',
    '        baseMethods,',
    '        pluginIds: startupPluginIds,',
    '        logDiagnostics: false',
    '      }));',
    '      log46.info("starting channels and sidecars...");',
    '      ({ pluginServices } = await startGatewaySidecars({',
    '        cfg: gatewayPluginConfigAtStart,',
    '        pluginRegistry,',
    '        defaultWorkspaceDir,',
    '        deps,',
    '        startChannels,',
    '        log: log46,',
    '        logHooks,',
    '        logChannels',
    '      }));',
    '    }',
  ].join('\n');

  const startupBlockReplacement = [
    '    if (!minimalTestGateway) {',
    '      if (deferredConfiguredChannelPluginIds.length > 0) ({ pluginRegistry } = reloadDeferredGatewayPlugins({',
    '        cfg: gatewayPluginConfigAtStart,',
    '        workspaceDir: defaultWorkspaceDir,',
    '        log: log46,',
    '        coreGatewayHandlers,',
    '        baseMethods,',
    '        pluginIds: startupPluginIds,',
    '        logDiagnostics: false',
    '      }));',
    '      const deferredGatewaySidecarsDelayMs = Math.max(0, Number.parseInt(process.env.OPENCLAW_GATEWAY_SIDECARS_DEFER_MS ?? "1000", 10) || 0);',
    '      if (deferredGatewaySidecarsDelayMs > 0) {',
    '        log46.info(`deferring channels and sidecars by ${deferredGatewaySidecarsDelayMs}ms to prioritize gateway health probes`);',
    '        await new Promise((resolve17) => setTimeout(resolve17, deferredGatewaySidecarsDelayMs));',
    '      }',
    '      log46.info("starting channels and sidecars...");',
    '      ({ pluginServices } = await startGatewaySidecars({',
    '        cfg: gatewayPluginConfigAtStart,',
    '        pluginRegistry,',
    '        defaultWorkspaceDir,',
    '        deps,',
    '        startChannels,',
    '        log: log46,',
    '        logHooks,',
    '        logChannels',
    '      }));',
    '    }',
  ].join('\n');

  let content = fs.readFileSync(bundleFile, 'utf-8');
  let changed = 0;

  if (content.includes(sessionMigrationNeedle)) {
    content = content.replace(sessionMigrationNeedle, sessionMigrationReplacement);
    changed++;
  }

  if (content.includes(startupBlockNeedle)) {
    content = content.replace(startupBlockNeedle, startupBlockReplacement);
    changed++;
  }

  if (changed > 0) {
    fs.writeFileSync(bundleFile, content, 'utf-8');
    console.log(`[bundle-openclaw] Rewrote ${changed} gateway startup block(s) to prioritize early health checks`);
  }
}

/** Fix deprecated file-type/core.js imports (removed in v17+).
 *  In old versions: import fileType from "file-type/core.js"
 *  In v17+: no default export; use named export fileTypeFromBuffer */
function rewriteDeprecatedFileTypeImports(pkgDir, bundleFile) {
  const fixContent = (content) => {
    let changed = false;
    // Replace deprecated subpath import with named export alias
    if (content.includes('file-type/core.js')) {
      content = content.replaceAll('import fileType from "file-type/core.js"', 'import { fileTypeFromBuffer as fileType } from "file-type"');
      changed = true;
    }
    // Also fix any already-rewritten-but-still-broken default imports (edge case)
    if (content.includes('import fileType from "file-type"')) {
      content = content.replaceAll('import fileType from "file-type"', 'import { fileTypeFromBuffer as fileType } from "file-type"');
      changed = true;
    }
    return { content, changed };
  };

  // Fix the main bundle output
  if (fs.existsSync(bundleFile)) {
    let content = fs.readFileSync(bundleFile, 'utf-8');
    const { content: fixed, changed } = fixContent(content);
    if (changed) {
      fs.writeFileSync(bundleFile, fixed, 'utf-8');
      console.log('[bundle-openclaw] Rewrote file-type/core.js -> fileTypeFromBuffer in bundle');
    }
  }

  // Also fix any esm chunk files in dist/ that may contain the deprecated import
  const distDir = path.join(pkgDir, 'dist');
  if (!fs.existsSync(distDir)) return;
  let fixed = 0;
  for (const entry of fs.readdirSync(distDir)) {
    if (!/\.js$/i.test(entry)) continue;
    const filePath = path.join(distDir, entry);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const { content: fixedContent, changed } = fixContent(content);
    if (changed) {
      fs.writeFileSync(filePath, fixedContent, 'utf-8');
      fixed++;
    }
  }
  if (fixed > 0) {
    console.log(`[bundle-openclaw] Rewrote file-type imports in ${fixed} dist chunk(s)`);
  }
}

// Main
// ---------------------------------------------------------------------------

async function main() {
  const pkgDir = process.argv[2];
  if (!pkgDir || !fs.existsSync(pkgDir)) {
    console.error('Usage: node scripts/bundle-openclaw.js <package-dir>');
    process.exit(1);
  }

  const resolvedPkgDir = path.resolve(pkgDir);
  const nmDir = path.join(resolvedPkgDir, 'node_modules');

  // Find entry point
  const entryJs = path.join(resolvedPkgDir, 'dist', 'entry.js');
  const entryMjs = path.join(resolvedPkgDir, 'dist', 'entry.mjs');
  const entryPoint = fs.existsSync(entryJs) ? entryJs : fs.existsSync(entryMjs) ? entryMjs : null;

  if (!entryPoint) {
    console.error('[bundle-openclaw] No dist/entry.js or dist/entry.mjs found');
    process.exit(1);
  }

  const outputFile = path.join(resolvedPkgDir, 'openclaw.mjs');
  const extensionsDir = path.join(resolvedPkgDir, 'dist', 'extensions');
  const filesBefore = countFiles(resolvedPkgDir);
  console.log(`[bundle-openclaw] Files before bundling: ${filesBefore}`);

  // Discover native externals
  const nativeExternals = discoverNativeExternals(resolvedPkgDir);
  console.log(`[bundle-openclaw] Native externals: ${nativeExternals.join(', ') || '(none)'}`);

  // Build complete externals list
  const allExternals = [
    ...getNodeBuiltins(),
    ...KNOWN_OPTIONAL_EXTERNALS,
    ...nativeExternals,
  ];
  // Deduplicate
  const externalSet = new Set(allExternals);
  const externals = [...externalSet];

  console.log('[bundle-openclaw] Running esbuild...');
  console.log(`[bundle-openclaw]   Entry: ${entryPoint}`);
  console.log(`[bundle-openclaw]   Output: ${outputFile}`);
  console.log(`[bundle-openclaw]   Externals: ${externals.length} patterns`);

  // Load esbuild - try local project first, then require
  let esbuild;
  const localEsbuild = path.join(__dirname, '..', 'node_modules', 'esbuild');
  try {
    if (fs.existsSync(localEsbuild)) {
      console.log(`[bundle-openclaw] Using esbuild from: ${localEsbuild}`);
      esbuild = require(localEsbuild);
    } else {
      esbuild = require('esbuild');
    }
  } catch (err) {
    console.error(`[bundle-openclaw] Failed to load esbuild: ${err.message}`);
    process.exit(1);
  }

  const catchMissingPlugin = {
  name: 'catch-missing',
  setup(build) {
    build.onEnd((result) => {
      const missing = new Set();

      for (const err of result.errors) {
        // 只关心无法解析的模块
        if (err.text.includes('Could not resolve')) {
          const match = err.text.match(/Could not resolve "(.+?)"/);
          if (match) {
            missing.add(match[1]);
          }
        }
      }

      if (missing.size > 0) {
        console.log('\n[bundle-openclaw] Missing modules (建议加入 external):');
        for (const m of missing) {
          console.log(`  - ${m}`);
        }
      }
    });
  },
};
  // Catch-all plugin: externalize any bare specifier that esbuild can't resolve.
  // This prevents future breakage from new optional dependencies.
  const catchAllExternalPlugin = {
    name: 'catch-all-external',
    setup(build) {
      // Track what we auto-externalize for logging
      const autoExternalized = new Set();

      build.onResolve({ filter: /.*/ }, (args) => {
        // Only intercept unresolvable bare specifiers (not relative/absolute paths)
        if (args.path.startsWith('.') || args.path.startsWith('/') || /^[A-Za-z]:/.test(args.path)) {
          return null; // Let esbuild handle relative/absolute paths
        }
        // Let esbuild try to resolve it first - we only catch failures
        return null;
      });

      // Use onResolve with a lower priority (higher filter specificity) as fallback
      // Actually, esbuild doesn't have priority - use the onEnd to log warnings
      // Instead, we use a resolve callback that returns external for known-problematic patterns
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        // Skip if already in our external list (esbuild handles those)
        if (externalSet.has(args.path)) return null;

        // Try to let esbuild resolve it normally first
        try {
          const result = await build.resolve(args.path, {
            kind: args.kind,
            resolveDir: args.resolveDir,
            importer: args.importer,
          });
          if (result.errors.length === 0) {
            return null; // Resolution succeeded, let esbuild bundle it
          }
        } catch {
          // Resolution failed
        }

        // Auto-externalize unresolvable bare specifiers
        if (!autoExternalized.has(args.path)) {
          autoExternalized.add(args.path);
          console.log(`[bundle-openclaw] Auto-externalizing unresolvable: ${args.path}`);
        }
        return { path: args.path, external: true };
      });
    },
  };

  // Banner to provide __dirname/__filename/require for ESM
  const banner = [
    "import { fileURLToPath as __bundled_fileURLToPath } from 'node:url';",
    "import { dirname as __bundled_dirname_fn } from 'node:path';",
    "import { createRequire as __bundled_createRequire } from 'node:module';",
    'const __bundled_dirname = __bundled_dirname_fn(__bundled_fileURLToPath(import.meta.url));',
    'const __bundled_filename = __bundled_fileURLToPath(import.meta.url);',
    'const require = __bundled_createRequire(import.meta.url);',
  ].join('\n');

  let buildResult;
  try {
    buildResult = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: outputFile,
      //outdir: 'dist',  
      //outfile: 'dist/entry.js', 
      target: 'node22',
      // splitting: true, 
      // chunkNames: 'chunks/chunk-[hash]',
      // sourcemap: 'external',
      sourcemap: false,         // 先关掉（避免内存炸）
      minify: false,
      treeShaking: true,
      external: externals,
      metafile: true,
      banner: { js: banner },
      define: {
        '__dirname': '__bundled_dirname',
        '__filename': '__bundled_filename',
      },
      // plugins: [catchAllExternalPlugin],
      plugins: [catchMissingPlugin],
      logLevel: 'warning',
      // Allow esbuild to handle errors gracefully
      logOverride: {
        'import-is-undefined': 'silent',
      },
    });

    if (buildResult.errors.length > 0) {
      console.error('[bundle-openclaw] esbuild reported errors:');
      for (const err of buildResult.errors) {
        console.error(`  ${err.text}`);
      }
      throw new Error('esbuild build failed with errors');
    }

    if (buildResult.warnings.length > 0) {
      console.log(`[bundle-openclaw] esbuild warnings: ${buildResult.warnings.length}`);
      for (const w of buildResult.warnings.slice(0, 10)) {
        console.log(`  ${w.text}`);
      }
      if (buildResult.warnings.length > 10) {
        console.log(`  ... and ${buildResult.warnings.length - 10} more`);
      }
    }
  } catch (err) {
    console.error(`[bundle-openclaw] esbuild build failed: ${err.message}`);
    throw err;
  }

  // Verify output was created
  if (!fs.existsSync(outputFile)) {
    throw new Error('esbuild did not produce output file');
  }

  const excludedBundledExtensionRootPackages = collectBundledExtensionDeclaredPackages(
    extensionsDir,
    EXCLUDED_BUNDLED_EXTENSION_DIRS,
  );
  rewriteBundledRuntimeCandidatePaths(outputFile);
  rewriteGatewayStartupForEarlyHealth(outputFile);
  rewriteDeprecatedFileTypeImports(resolvedPkgDir, outputFile);
  const removedBundledExtensions = pruneExcludedBundledExtensions(resolvedPkgDir);
  const keptBundledExtensionRootPackages = collectBundledExtensionDeclaredPackages(extensionsDir);
  const excludedBundledExtensionDependencyPackages = collectTransitivePackageDeps(
    resolvedPkgDir,
    excludedBundledExtensionRootPackages,
  );
  const keptBundledExtensionDependencyPackages = collectTransitivePackageDeps(
    resolvedPkgDir,
    keptBundledExtensionRootPackages,
  );
  const excludedOnlyPackages = new Set(
    excludedBundledExtensionDependencyPackages.filter((packageName) => !keptBundledExtensionDependencyPackages.includes(packageName)),
  );
  const forceKeptRuntimePackages = new Set(REQUIRED_RUNTIME_PACKAGES);

  const builtinSet = new Set(getNodeBuiltins());
  const runtimeRequirePackages = [
    ...new Set([
      ...REQUIRED_RUNTIME_PACKAGES,
      ...collectBundleExternalPackages(buildResult?.metafile, outputFile, builtinSet),
      ...collectRuntimeRequirePackages([
        outputFile,
        path.join(resolvedPkgDir, 'dist'),
      ], builtinSet),
    ]),
  ].sort().filter((packageName) => forceKeptRuntimePackages.has(packageName) || !excludedOnlyPackages.has(packageName));
  const filteredKnownOptionalExternals = KNOWN_OPTIONAL_EXTERNALS.filter((packageName) => !excludedOnlyPackages.has(packageName));
  const filteredNativeExternals = nativeExternals.filter((packageName) => !excludedOnlyPackages.has(packageName));
  const runtimeDependencyPackages = collectTransitivePackageDeps(resolvedPkgDir, runtimeRequirePackages);
  const externalDependencyPackages = collectTransitivePackageDeps(resolvedPkgDir, [
    ...filteredKnownOptionalExternals,
    ...filteredNativeExternals,
  ]);
  const nestedDependencyPackages = collectTransitivePackageDeps(resolvedPkgDir, collectNestedPackageTreeDeps(resolvedPkgDir, [
    ...runtimeDependencyPackages,
    ...externalDependencyPackages,
    ...filteredKnownOptionalExternals,
    ...filteredNativeExternals,
    ...keptBundledExtensionDependencyPackages,
  ]));

  const outputSize = fs.statSync(outputFile).size;
  console.log(`[bundle-openclaw] Bundle created: ${outputFile} (${(outputSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`[bundle-openclaw] Runtime JS packages kept: ${runtimeDependencyPackages.join(', ') || '(none)'}`);
  console.log(`[bundle-openclaw] External package deps kept: ${externalDependencyPackages.join(', ') || '(none)'}`);
  console.log(`[bundle-openclaw] Nested package deps kept: ${nestedDependencyPackages.join(', ') || '(none)'}`);
  console.log(`[bundle-openclaw] Excluded-only dependency packages removed from retention: ${[...excludedOnlyPackages].sort().join(', ') || '(none)'}`);

  // Clean up node_modules - keep only native binding directories
  console.log('[bundle-openclaw] Cleaning node_modules (keeping native addons + runtime JS deps)...');
  const keepDirs = getNativeModuleDirs(resolvedPkgDir, [
    ...filteredNativeExternals,
    ...filteredKnownOptionalExternals,
    ...runtimeDependencyPackages,
    ...externalDependencyPackages,
    ...nestedDependencyPackages,
    ...keptBundledExtensionDependencyPackages,
  ]);

  if (fs.existsSync(nmDir)) {
    const topEntries = fs.readdirSync(nmDir, { withFileTypes: true });
    let removedCount = 0;

    for (const entry of topEntries) {
      const entryName = entry.name;
      const fullPath = path.join(nmDir, entryName);

      if (entryName === '.package-lock.json') {
        fs.unlinkSync(fullPath);
        removedCount++;
        continue;
      }

      if (entryName.startsWith('@')) {
        // Scoped package directory
        if (!keepDirs.has(entryName)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedCount++;
        } else {
          // Keep only the specific packages we need within the scope
          const scopedEntries = fs.readdirSync(fullPath, { withFileTypes: true });
          for (const scopedEntry of scopedEntries) {
            const scopedName = `${entryName}/${scopedEntry.name}`;
            if (!keepDirs.has(scopedName) && !filteredNativeExternals.includes(scopedName) && !filteredKnownOptionalExternals.includes(scopedName)) {
              fs.rmSync(path.join(fullPath, scopedEntry.name), { recursive: true, force: true });
              removedCount++;
            }
          }
        }
      } else if (!keepDirs.has(entryName)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removedCount++;
      }
    }

    console.log(`[bundle-openclaw] Removed ${removedCount} directories from node_modules`);
  }

  pruneKoffiNativeBinaries(resolvedPkgDir);
  pruneDocsToRuntimeSubset(resolvedPkgDir);
  pruneNonRuntimeFiles(resolvedPkgDir);

  // Write bundle manifest
  const filesAfter = countFiles(resolvedPkgDir);
  const manifest = {
    bundled: true,
    entry: 'openclaw.mjs',
    originalEntry: path.relative(resolvedPkgDir, entryPoint),
    outputSize,
    nativeExternals,
    removedBundledExtensions,
    excludedBundledExtensionRootPackages,
    excludedBundledExtensionDependencyPackages,
    keptBundledExtensionRootPackages,
    keptBundledExtensionDependencyPackages,
    runtimeRequirePackages,
    runtimeDependencyPackages,
    externalDependencyPackages,
    nestedDependencyPackages,
    filesBefore,
    filesAfter,
    reduction: `${((1 - filesAfter / filesBefore) * 100).toFixed(1)}%`,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(resolvedPkgDir, 'bundle-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8'
  );

  console.log(`[bundle-openclaw] Files after bundling: ${filesAfter}`);
  console.log(`[bundle-openclaw] Reduction: ${filesBefore} -> ${filesAfter} (${manifest.reduction})`);

  console.log('[bundle-openclaw] Done.');
}

main().catch((err) => {
  console.error(`[bundle-openclaw] FATAL: ${err.message}`);
  process.exit(1);
});
