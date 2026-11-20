import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  PROFILE_NAME_PATTERN,
  loadCodePenConfig,
  loadCodePenProfile,
} from './config.mjs';

const CONFIG_FILENAME = '.cdpn.json';
const IGNORE_FILENAME = '.cdpnignore';
const MAX_SCAN_DEPTH = 4;
const BUILTIN_IGNORED_SEGMENTS = new Set([
  CONFIG_FILENAME,
  IGNORE_FILENAME,
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

const require = createRequire(import.meta.url);

function usage() {
  console.error(
    'Usage:\n' +
      '  codepen-demokit cdpn <push|pull|sync|delete> [folder-in-src] [--dry-run] [--force]\n' +
      '  codepen-demokit cdpn clone [options] <url> [folder]'
  );
}

function isSemverAtLeast(version, minVersion) {
  const parse = (raw) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const current = parse(version);
  const minimum = parse(minVersion);
  if (!current || !minimum) return true;
  for (let i = 0; i < 3; i++) {
    if (current[i] !== minimum[i]) return current[i] > minimum[i];
  }
  return true;
}

function parseArgs(argv) {
  let mode = null;
  let targetFolder = null;
  let dryRun = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error(`Error: Unknown option '${arg}'.`);
      usage();
      process.exit(1);
    } else if (!mode) {
      if (arg === 'push' || arg === 'pull' || arg === 'sync' || arg === 'delete') {
        mode = arg;
      } else {
        console.error(
          `Error: Unknown mode '${arg}' (expected 'push', 'pull', 'sync', 'delete', or 'clone').`
        );
        usage();
        process.exit(1);
      }
    } else {
      if (targetFolder !== null) {
        console.error(
          `Error: Multiple target folders specified ('${targetFolder}' and '${arg}').`
        );
        usage();
        process.exit(1);
      }
      targetFolder = arg;
    }
  }

  if (!mode) {
    console.error(
      "Error: Missing mode (expected 'push', 'pull', 'sync', 'delete', or 'clone')."
    );
    usage();
    process.exit(1);
  }

  if (force && mode !== 'pull') {
    console.error("Error: --force is only supported with 'pull'.");
    usage();
    process.exit(1);
  }

  return { mode, targetFolder, dryRun, force };
}

function spawnCdpn(cdpn, args, cwd) {
  return spawnSync(cdpn.command, [...cdpn.prefixArgs, ...args], {
    cwd,
    encoding: 'utf8',
    shell: cdpn.shell,
  });
}

function findCodePenCommanderCli(projectDir) {
  // 1. Prefer consumer project's own installed codepen-commander (supports npm/pnpm/yarn upgrades)
  const projectPkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(projectPkgPath)) {
    try {
      const projectRequire = createRequire(projectPkgPath);
      const pkgPath = projectRequire.resolve('codepen-commander/package.json');
      const cliPath = path.join(path.dirname(pkgPath), 'cli.js');
      if (fs.existsSync(cliPath)) {
        return { cliPath, source: 'project node_modules' };
      }
    } catch {
      // Fall through to bundled dependency
    }
  }

  // 2. Fallback: bundled dependency of codepen-demokit (e.g. during `npx codepen-demokit init` before `npm install`)
  try {
    const pkgPath = require.resolve('codepen-commander/package.json');
    const cliPath = path.join(path.dirname(pkgPath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return { cliPath, source: 'codepen-commander' };
    }
  } catch {
    // Fall through to PATH
  }

  return null;
}

export function locateCdpnBinary(projectDir = process.cwd()) {
  const resolved = findCodePenCommanderCli(projectDir);
  const cdpn = resolved
    ? {
        command: process.execPath,
        prefixArgs: [resolved.cliPath],
        shell: false,
      }
    : {
        command: 'cdpn',
        prefixArgs: [],
        // On Windows, a globally installed `cdpn` is a `.cmd` shim on PATH, which
        // throws EINVAL on Node >= 20.12.2 when spawned with `shell: false`.
        // All arguments passed to `cdpn` are hardcoded literals or strictly allow-listed.
        shell: process.platform === 'win32',
      };

  const check = spawnCdpn(cdpn, ['--version'], projectDir);
  if (check.error || check.status !== 0) {
    return null;
  }

  return {
    bin: cdpn,
    source: resolved ? resolved.source : 'PATH',
    version: (check.stdout || '').trim() || 'unknown',
  };
}

function resolveCdpnBinary(projectDir) {
  const located = locateCdpnBinary(projectDir);
  if (!located) {
    console.error(
      "Error: 'cdpn' (CodePen Commander) is required but was not found or failed to run."
    );
    console.error('Run `npm install` to install project dependencies.');
    process.exit(1);
  }
  return located;
}

function runCdpnJson(cdpnBin, args, cwd) {
  const result = spawnCdpn(cdpnBin, args, cwd);

  if (result.error) {
    return {
      ok: false,
      exitCode: 1,
      json: null,
      errorMessage: result.error.message,
    };
  }

  const rawStdout = (result.stdout || '').trim();
  const rawStderr = (result.stderr || '').trim();
  let parsed = null;

  if (rawStdout) {
    try {
      parsed = JSON.parse(rawStdout);
    } catch {
      const firstBrace = rawStdout.indexOf('{');
      if (firstBrace !== -1) {
        try {
          parsed = JSON.parse(rawStdout.slice(firstBrace));
        } catch {
          parsed = null;
        }
      }
    }
  }

  const statusCode = parsed?.status?.code ?? null;
  const ok =
    result.status === 0 &&
    parsed !== null &&
    typeof statusCode === 'number' &&
    statusCode >= 200 &&
    statusCode < 300;

  return {
    ok,
    exitCode: result.status ?? 1,
    json: parsed,
    errorMessage:
      parsed?.status?.message ||
      rawStderr ||
      rawStdout ||
      `cdpn exited with code ${result.status ?? 1}`,
  };
}

function verifyProfileAuth(cdpnBin, requiredProfile, projectDir) {
  const res = runCdpnJson(cdpnBin, ['auth', 'status', '--json'], projectDir);
  if (!res.json) {
    console.error(`Error: Failed to check cdpn auth status: ${res.errorMessage}`);
    process.exit(1);
  }
  const profiles = Array.isArray(res.json.contents?.profiles)
    ? res.json.contents.profiles
    : [];
  const targetProfile = profiles.find((p) => p?.name === requiredProfile);

  if (!targetProfile) {
    console.error(
      `Error: CodePen profile "${requiredProfile}" is not configured in cdpn.`
    );
    if (profiles.length > 0) {
      const names = profiles.map((p) => p.name).filter(Boolean).join(', ');
      console.error(`  Configured profiles: ${names}`);
    }
    console.error(`  Run: npx cdpn auth login ${requiredProfile}`);
    process.exit(1);
  }

  if (targetProfile.verified !== true) {
    console.error(
      `Error: CodePen profile "${requiredProfile}" failed authentication verification.`
    );
    if (targetProfile.verification_error) {
      console.error(`  Detail: ${targetProfile.verification_error}`);
    }
    console.error(`  Re-authenticate with: npx cdpn auth login ${requiredProfile}`);
    process.exit(1);
  }

  return {
    name: targetProfile.name,
    keyType: targetProfile.key_type || 'unknown',
  };
}

function resolveTargetDir(resolvedDemosDir, targetFolder) {
  if (!targetFolder) {
    return { absDir: resolvedDemosDir, segments: [], relPrefix: null };
  }

  if (
    targetFolder.includes('\0') ||
    targetFolder.includes('\\') ||
    path.isAbsolute(targetFolder)
  ) {
    console.error(
      `Error: Invalid folder "${targetFolder}": pass a relative folder path inside src/.`
    );
    process.exit(1);
  }

  const trimmed = targetFolder.replace(/\/+$/, '');
  if (!trimmed) {
    return { absDir: resolvedDemosDir, segments: [], relPrefix: null };
  }

  const segments = trimmed.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      console.error(
        `Error: Invalid folder "${targetFolder}": path traversal and hidden folders are not allowed.`
      );
      process.exit(1);
    }
  }

  const candidateDir = path.resolve(resolvedDemosDir, ...segments);
  if (!candidateDir.startsWith(resolvedDemosDir + path.sep)) {
    console.error(
      `Error: Invalid folder "${targetFolder}": must resolve within src/.`
    );
    process.exit(1);
  }

  let stat;
  try {
    stat = fs.lstatSync(candidateDir);
  } catch {
    console.error(`Error: Folder "src/${segments.join('/')}" does not exist.`);
    process.exit(1);
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    console.error(
      `Error: "src/${segments.join('/')}" is not a regular directory.`
    );
    process.exit(1);
  }

  const realTargetDir = fs.realpathSync(candidateDir);
  if (!realTargetDir.startsWith(resolvedDemosDir + path.sep)) {
    console.error(
      `Error: Invalid folder "${targetFolder}": resolves outside src/.`
    );
    process.exit(1);
  }

  return {
    absDir: realTargetDir,
    segments,
    relPrefix: segments.join('/'),
  };
}

function discoverDemoDirs(demosDir, targetFolder = null) {
  if (!fs.existsSync(demosDir)) {
    console.error(`Error: src directory not found at ${demosDir}.`);
    process.exit(1);
  }

  const resolvedDemosDir = fs.realpathSync(path.resolve(demosDir));
  const target = resolveTargetDir(resolvedDemosDir, targetFolder);
  const demos = [];

  function inspectFolderForDemo(dirPath, segments) {
    const indexPath = path.join(dirPath, 'index.html');
    const configPath = path.join(dirPath, CONFIG_FILENAME);
    const hasIndex =
      fs.existsSync(indexPath) && fs.lstatSync(indexPath).isFile();
    const hasConfig =
      fs.existsSync(configPath) && fs.lstatSync(configPath).isFile();

    if (!hasIndex && !hasConfig) return null;

    return {
      relPath: segments.join('/'),
      absPath: dirPath,
      hasIndex,
      hasConfig,
    };
  }

  function walk(currentDir, segments, depth) {
    if (depth > MAX_SCAN_DEPTH) return;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const childPath = path.resolve(currentDir, entry.name);
      if (!childPath.startsWith(resolvedDemosDir + path.sep)) continue;
      if (fs.lstatSync(childPath).isSymbolicLink()) continue;

      const childSegments = [...segments, entry.name];
      const demo = inspectFolderForDemo(childPath, childSegments);
      if (demo) {
        demos.push(demo);
        continue;
      }

      walk(childPath, childSegments, depth + 1);
    }
  }

  if (target.segments.length > 0) {
    const directDemo = inspectFolderForDemo(target.absDir, target.segments);
    if (directDemo) {
      demos.push(directDemo);
    } else {
      walk(target.absDir, target.segments, target.segments.length + 1);
    }
  } else {
    walk(resolvedDemosDir, [], 1);
  }

  demos.sort((a, b) =>
    a.relPath.localeCompare(b.relPath, 'en', {
      numeric: true,
      sensitivity: 'base',
    })
  );
  return { demos, scope: target.relPrefix };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadIgnoreMatchers(rootDir) {
  const ignorePath = path.join(rootDir, IGNORE_FILENAME);
  if (!fs.existsSync(ignorePath)) return [];
  const raw = fs.readFileSync(ignorePath, 'utf8');
  const matchers = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized) continue;
    const hasSlash = normalized.includes('/');
    const regexBody = normalized
      .split('**')
      .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
      .join('.*');
    matchers.push(
      hasSlash
        ? new RegExp(`^/${regexBody}(?:/.*)?$`)
        : new RegExp(`(?:^|/)${regexBody}(?:/.*)?$`)
    );
  }
  return matchers;
}

function scanLocalFileHashes(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const customMatchers = loadIgnoreMatchers(resolvedRoot);
  const hashes = new Map();

  function walk(currentDir, relativePrefix) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (BUILTIN_IGNORED_SEGMENTS.has(entry.name)) continue;
      const penPath = relativePrefix
        ? `${relativePrefix}/${entry.name}`
        : `/${entry.name}`;
      if (customMatchers.some((re) => re.test(penPath))) continue;

      const fullPath = path.resolve(currentDir, entry.name);
      if (!fullPath.startsWith(resolvedRoot + path.sep)) continue;

      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        walk(fullPath, penPath);
      } else if (stat.isFile()) {
        const buf = fs.readFileSync(fullPath);
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        hashes.set(penPath, sha256);
      }
    }
  }

  walk(resolvedRoot, '');
  return hashes;
}

function detectLocalChanges(demoDir, baselineFiles) {
  if (!baselineFiles || typeof baselineFiles !== 'object' || Array.isArray(baselineFiles)) {
    return {
      knownBaseline: false,
      hasChanges: null,
      added: [],
      modified: [],
      deleted: [],
    };
  }

  const localHashes = scanLocalFileHashes(demoDir);
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [filePath, sha256] of localHashes) {
    const base = baselineFiles[filePath];
    if (!base) {
      added.push(filePath);
    } else if (base.local_sha256 !== sha256) {
      modified.push(filePath);
    }
  }

  for (const filePath of Object.keys(baselineFiles)) {
    if (!localHashes.has(filePath)) {
      deleted.push(filePath);
    }
  }

  added.sort();
  modified.sort();
  deleted.sort();

  return {
    knownBaseline: true,
    hasChanges: added.length + modified.length + deleted.length > 0,
    added,
    modified,
    deleted,
  };
}

function extractHtmlTitle(demoDir) {
  const indexPath = path.join(demoDir, 'index.html');
  if (!fs.existsSync(indexPath)) return null;
  const html = fs.readFileSync(indexPath, 'utf8');
  const match = html.match(/<title\b[^>]{0,200}>([\s\S]{0,500}?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

function shortId(id) {
  if (!id) return 'none';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatChangesList(changes, indent = '    ') {
  const lines = [];
  for (const p of changes.added || []) lines.push(`${indent}+ ${p}`);
  for (const p of changes.modified || []) lines.push(`${indent}~ ${p}`);
  for (const p of changes.deleted || []) lines.push(`${indent}- ${p}`);
  return lines;
}

function readAndValidateConfig(demo, requiredProfile) {
  let config;
  try {
    config = JSON.parse(
      fs.readFileSync(path.join(demo.absPath, CONFIG_FILENAME), 'utf8')
    );
  } catch (err) {
    return {
      ok: false,
      message: `Failed to read ${CONFIG_FILENAME}: ${err.message}`,
    };
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      ok: false,
      message: `Invalid ${CONFIG_FILENAME}: expected a JSON object.`,
    };
  }

  // Unlinked info-only `.cdpn.json` (e.g. retained after `cdpn delete --keep-info`)
  if (
    config.pen_id === undefined &&
    config.url === undefined &&
    config.info !== undefined
  ) {
    return { ok: true, linked: false, config };
  }

  if (config.profile && config.profile !== requiredProfile) {
    return {
      ok: false,
      message: `${CONFIG_FILENAME} is linked to profile "${config.profile}" instead of "${requiredProfile}".`,
    };
  }

  return { ok: true, linked: true, config };
}

function inspectDemo(cdpnBin, demo, requiredProfile) {
  if (!demo.hasConfig) {
    return {
      state: 'unlinked',
      title: extractHtmlTitle(demo.absPath) || path.basename(demo.absPath),
      hasRetainedInfo: false,
    };
  }

  const configRes = readAndValidateConfig(demo, requiredProfile);
  if (!configRes.ok) {
    return {
      state: 'error',
      message: configRes.message,
    };
  }
  const { config, linked } = configRes;

  if (!linked) {
    return {
      state: 'unlinked',
      title:
        (typeof config.info?.title === 'string' && config.info.title.trim()) ||
        extractHtmlTitle(demo.absPath) ||
        path.basename(demo.absPath),
      hasRetainedInfo: true,
    };
  }

  const statusRes = runCdpnJson(
    cdpnBin,
    ['--profile', requiredProfile, 'status', '--json'],
    demo.absPath
  );

  if (!statusRes.ok) {
    return {
      state: 'error',
      message: `cdpn status failed: ${statusRes.errorMessage}`,
    };
  }

  const data = statusRes.json.contents;
  const remoteAhead = Boolean(data.remote_ahead);
  const diffChanges = data.changes || { added: [], modified: [], deleted: [] };
  const diffCount =
    (diffChanges.added?.length || 0) +
    (diffChanges.modified?.length || 0) +
    (diffChanges.deleted?.length || 0);
  const infoChanges = Array.isArray(data.info_changes) ? data.info_changes : [];
  const infoCount = infoChanges.length;
  const localInfoChanged = Boolean(data.info_local_changed) && infoCount > 0;
  const remoteInfoChanged = Boolean(data.info_remote_changed) && infoCount > 0;
  const localBaseline = detectLocalChanges(demo.absPath, config.files);
  const localFilesEdited = localBaseline.knownBaseline
    ? localBaseline.hasChanges
    : diffCount > 0;

  const localChanged =
    (!remoteAhead && diffCount > 0) ||
    (remoteAhead && localFilesEdited && diffCount > 0) ||
    localInfoChanged;
  const remoteChanged = remoteAhead || remoteInfoChanged;

  let state;
  if (!localChanged && !remoteChanged) {
    state = 'up-to-date';
  } else if (localChanged && !remoteChanged) {
    state = 'local-ahead';
  } else if (!localChanged && remoteChanged) {
    state =
      diffCount === 0 && !remoteInfoChanged
        ? 'remote-metadata-ahead'
        : 'remote-ahead';
  } else {
    state = 'conflict';
  }

  return {
    state,
    config,
    status: data,
    diffChanges,
    diffCount,
    infoChanges,
    infoCount,
    localBaseline,
  };
}

function hasHelpFlag(argv) {
  for (const arg of argv) {
    if (arg === '--') break;
    if (arg === '-h' || arg === '--help') return true;
  }
  return false;
}

function normalizeCloneFolderArg(rawFolder, demosRealpath) {
  if (
    rawFolder.includes('\0') ||
    rawFolder.includes('\\') ||
    path.isAbsolute(rawFolder)
  ) {
    console.error(
      `Error: Invalid folder "${rawFolder}": pass a relative folder path inside src/.`
    );
    process.exit(1);
  }

  let normalized = rawFolder;
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized === 'src' || normalized === 'src/') {
    console.error(
      `Error: Invalid folder "${rawFolder}": specify a demo subfolder inside src/ (e.g., "my-demo" or "group/my-demo").`
    );
    process.exit(1);
  }
  if (normalized.startsWith('src/')) {
    normalized = normalized.slice(4);
  }
  normalized = normalized.replace(/\/+$/, '');

  if (!normalized || normalized === '.') {
    console.error(
      `Error: Invalid folder "${rawFolder}": specify a demo subfolder inside src/ (e.g., "my-demo" or "group/my-demo").`
    );
    process.exit(1);
  }

  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      console.error(
        `Error: Invalid folder "${rawFolder}": path traversal and hidden folders are not allowed.`
      );
      process.exit(1);
    }
  }

  const candidateDir = path.resolve(demosRealpath, ...segments);
  if (!candidateDir.startsWith(demosRealpath + path.sep)) {
    console.error(
      `Error: Invalid folder "${rawFolder}": must resolve within src/.`
    );
    process.exit(1);
  }

  // Ensure no existing path component inside src/ is a symlink escaping src/
  let probe = candidateDir;
  while (probe !== demosRealpath) {
    if (fs.existsSync(probe)) {
      const stat = fs.lstatSync(probe);
      if (stat.isSymbolicLink()) {
        console.error(
          `Error: Invalid folder "${rawFolder}": symbolic links are not allowed.`
        );
        process.exit(1);
      }
      const realProbe = fs.realpathSync(probe);
      if (!realProbe.startsWith(demosRealpath + path.sep)) {
        console.error(
          `Error: Invalid folder "${rawFolder}": resolves outside src/.`
        );
        process.exit(1);
      }
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  return segments.join('/');
}

function parseCloneArgs(argv, demosRealpath) {
  let explicitProfile = null;
  let afterDoubleDash = false;
  let positionalCount = 0;
  const forwardedArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true;
      forwardedArgs.push(arg);
      continue;
    }

    if (!afterDoubleDash && arg === '--profile') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        console.error("Error: Missing value for '--profile'.");
        process.exit(1);
      }
      const trimmed = next.trim();
      if (!PROFILE_NAME_PATTERN.test(trimmed)) {
        console.error(`Error: Invalid '--profile' value "${next}".`);
        process.exit(1);
      }
      explicitProfile = trimmed;
      i++;
      continue;
    }

    if (!afterDoubleDash && arg.startsWith('--profile=')) {
      const trimmed = arg.slice('--profile='.length).trim();
      if (!trimmed || !PROFILE_NAME_PATTERN.test(trimmed)) {
        console.error(`Error: Invalid '--profile' value "${trimmed}".`);
        process.exit(1);
      }
      explicitProfile = trimmed;
      continue;
    }

    if (!afterDoubleDash && arg.startsWith('-')) {
      forwardedArgs.push(arg);
      continue;
    }

    // Positional args: 0 = <url>, 1 = [folder]
    if (positionalCount === 1) {
      forwardedArgs.push(normalizeCloneFolderArg(arg, demosRealpath));
    } else {
      forwardedArgs.push(arg);
    }
    positionalCount++;
  }

  return { explicitProfile, forwardedArgs };
}

export function runCodePenClone(argv, { projectDir = process.cwd() } = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const { bin: cdpnBin } = resolveCdpnBinary(resolvedProjectDir);

  if (hasHelpFlag(argv)) {
    const helpRes = spawnSync(
      cdpnBin.command,
      [...cdpnBin.prefixArgs, 'clone', '--help'],
      {
        cwd: resolvedProjectDir,
        stdio: 'inherit',
        shell: cdpnBin.shell,
      }
    );
    if (helpRes.error) {
      console.error(`Error: Failed to run cdpn clone: ${helpRes.error.message}`);
      process.exit(1);
    }
    if ((helpRes.status ?? 0) !== 0) {
      process.exit(helpRes.status ?? 1);
    }
    return;
  }

  const projectRealpath = fs.realpathSync(resolvedProjectDir);
  const demosDir = path.resolve(resolvedProjectDir, 'src');
  if (!fs.existsSync(demosDir)) {
    fs.mkdirSync(demosDir, { recursive: true });
  } else {
    const srcStat = fs.lstatSync(demosDir);
    if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
      console.error(`Error: "src" at ${demosDir} is not a regular directory.`);
      process.exit(1);
    }
  }

  const demosRealpath = fs.realpathSync(demosDir);
  if (!demosRealpath.startsWith(projectRealpath + path.sep)) {
    console.error(`Error: "src/" resolves outside ${resolvedProjectDir}.`);
    process.exit(1);
  }

  const { explicitProfile, forwardedArgs } = parseCloneArgs(argv, demosRealpath);

  let profileToUse = explicitProfile;
  if (!profileToUse) {
    const profileRes = loadCodePenProfile(resolvedProjectDir);
    if (!profileRes.ok) {
      for (const line of profileRes.warnings) {
        console.warn(line);
      }
      process.exit(1);
    }
    profileToUse = profileRes.profile;
  }

  const finalArgs = [
    ...(profileToUse ? ['--profile', profileToUse] : []),
    'clone',
    ...forwardedArgs,
  ];

  if (cdpnBin.shell && finalArgs.some((arg) => /[&|<>^%!"`\r\n]/.test(arg))) {
    console.error(
      'Error: Refusing to pass shell metacharacters to global cdpn wrapper on Windows. Run `npm install` to use the local codepen-commander package.'
    );
    process.exit(1);
  }

  const result = spawnSync(cdpnBin.command, [...cdpnBin.prefixArgs, ...finalArgs], {
    cwd: demosRealpath,
    stdio: 'inherit',
    shell: cdpnBin.shell,
  });

  if (result.error) {
    console.error(`Error: Failed to run cdpn clone: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    process.exit(result.signal === 'SIGINT' ? 130 : 1);
  }
  if ((result.status ?? 0) !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function runCodePenSync(argv, { projectDir = process.cwd() } = {}) {
  if (argv[0] === 'clone') {
    return runCodePenClone(argv.slice(1), { projectDir });
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const demosDir = path.resolve(resolvedProjectDir, 'src');

  const { mode, targetFolder, dryRun, force } = parseArgs(argv);

  const codepenConfig = loadCodePenConfig(resolvedProjectDir);
  if (!codepenConfig.ok) {
    for (const line of codepenConfig.warnings) {
      console.warn(line);
    }
    process.exit(1);
  }
  const { requiredProfile, defaultNewAccess } = codepenConfig;

  const { demos, scope } = discoverDemoDirs(demosDir, targetFolder);
  const prefix = dryRun ? '[DRY RUN] ' : '';
  const scopeNote = scope ? `, scope: src/${scope}` : '';
  const forceNote = force ? ', force: true' : '';

  console.log(
    `${prefix}CodePen Demo Sync (mode: ${mode}${scopeNote}, profile: ${requiredProfile}, default visibility: ${defaultNewAccess}${forceNote})`
  );

  // 1. Check cdpn is installed
  const { bin: cdpnBin, source: cdpnSource, version: cdpnVersion } =
    resolveCdpnBinary(resolvedProjectDir);
  console.log(`  ✓ cdpn ${cdpnVersion} available (${cdpnSource})`);

  if (mode === 'delete' && !isSemverAtLeast(cdpnVersion, '1.3.0')) {
    console.error(
      `Error: 'delete' requires codepen-commander >= 1.3.0 for --keep-info (found ${cdpnVersion}).`
    );
    console.error('Run `npm install` to update codepen-commander.');
    process.exit(1);
  }

  // 2. Check profile authentication via `cdpn auth status --json`
  const auth = verifyProfileAuth(cdpnBin, requiredProfile, resolvedProjectDir);
  console.log(`  ✓ Authenticated profile "${auth.name}" (${auth.keyType} key)`);

  // 3. Report discovered demos
  const scopeSummary = scope ? `under ./src/${scope}` : 'under ./src';
  console.log(`  ✓ Found ${demos.length} demo folder(s) ${scopeSummary}\n`);

  const summary = {
    created: [],
    pushed: [],
    pulled: [],
    deleted: [],
    upToDate: [],
    skipped: [],
    conflicts: [],
    errors: [],
  };

  for (const demo of demos) {
    // --- DELETE (delete every linked demo on CodePen while keeping info in .cdpn.json) ---
    if (mode === 'delete') {
      if (!demo.hasConfig) {
        console.log(
          `- [SKIP] ${demo.relPath} — unlinked (no ${CONFIG_FILENAME}); nothing to delete`
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const configRes = readAndValidateConfig(demo, requiredProfile);
      if (!configRes.ok) {
        console.log(`✗ [ERROR] ${demo.relPath}`);
        console.log(`    ${configRes.message}`);
        summary.errors.push({ demo: demo.relPath, message: configRes.message });
        continue;
      }

      if (!configRes.linked) {
        console.log(
          `- [SKIP] ${demo.relPath} — already unlinked (info-only ${CONFIG_FILENAME}); nothing to delete`
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const { config } = configRes;
      const deleteArgs = [
        '--profile',
        requiredProfile,
        'delete',
        '--keep-info',
        '--yes',
        '--json',
      ];

      if (dryRun) {
        console.log(
          `× [WOULD DELETE] ${demo.relPath} (${config.url || config.pen_id}) — retaining info in ${CONFIG_FILENAME}`
        );
        console.log(`    Would run: cdpn ${deleteArgs.join(' ')}`);
        summary.deleted.push(demo.relPath);
        continue;
      }

      console.log(
        `× [DELETING] ${demo.relPath} (${config.url || config.pen_id})…`
      );
      const res = runCdpnJson(cdpnBin, deleteArgs, demo.absPath);
      if (!res.ok) {
        console.log(`  ✗ Delete failed: ${res.errorMessage}`);
        summary.errors.push({ demo: demo.relPath, message: res.errorMessage });
        continue;
      }
      const penTitle = res.json?.contents?.title || path.basename(demo.absPath);
      const penId = res.json?.contents?.pen_id || config.pen_id;
      console.log(
        `  ✓ Deleted "${penTitle}" (${shortId(penId)}) on CodePen (retained info in ${CONFIG_FILENAME})`
      );
      summary.deleted.push(demo.relPath);
      continue;
    }

    // --- FORCE PULL (pull every linked demo unconditionally to refresh files & .cdpn.json) ---
    if (mode === 'pull' && force) {
      if (!demo.hasConfig) {
        console.log(
          `- [SKIP] ${demo.relPath} — unlinked (no ${CONFIG_FILENAME}); nothing to pull`
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const configRes = readAndValidateConfig(demo, requiredProfile);
      if (!configRes.ok) {
        console.log(`✗ [ERROR] ${demo.relPath}`);
        console.log(`    ${configRes.message}`);
        summary.errors.push({ demo: demo.relPath, message: configRes.message });
        continue;
      }

      if (!configRes.linked) {
        console.log(
          `- [SKIP] ${demo.relPath} — unlinked (info-only ${CONFIG_FILENAME}); nothing to pull`
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const { config } = configRes;
      const pullArgs = ['--profile', requiredProfile, 'pull', '--force', '--json'];

      if (dryRun) {
        console.log(
          `↓ [WOULD FORCE PULL] ${demo.relPath} (${config.url || config.pen_id})`
        );
        console.log(`    Would run: cdpn ${pullArgs.join(' ')}`);
        summary.pulled.push(demo.relPath);
        continue;
      }

      console.log(
        `↓ [FORCE PULLING] ${demo.relPath} (${shortId(config.last_synced_version_id)})…`
      );
      const res = runCdpnJson(cdpnBin, pullArgs, demo.absPath);
      if (!res.ok) {
        console.log(`  ✗ Pull failed: ${res.errorMessage}`);
        summary.errors.push({ demo: demo.relPath, message: res.errorMessage });
        continue;
      }
      const written = res.json?.contents?.written_paths?.length ?? 0;
      const deleted = res.json?.contents?.deleted_paths?.length ?? 0;
      console.log(
        `  ✓ Pulled (version ${shortId(res.json?.contents?.version_id)}, updated ${written}, removed ${deleted})`
      );
      summary.pulled.push(demo.relPath);
      continue;
    }

    const info = inspectDemo(cdpnBin, demo, requiredProfile);

    if (info.state === 'error') {
      console.log(`✗ [ERROR] ${demo.relPath}`);
      console.log(`    ${info.message}`);
      summary.errors.push({ demo: demo.relPath, message: info.message });
      continue;
    }

    // --- UNLINKED (no .cdpn.json or info-only .cdpn.json) ---
    if (info.state === 'unlinked') {
      if (mode === 'pull') {
        const reason = info.hasRetainedInfo
          ? `info-only ${CONFIG_FILENAME}`
          : `no ${CONFIG_FILENAME}`;
        console.log(
          `- [SKIP] ${demo.relPath} — unlinked (${reason}); nothing to pull`
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const pushArgs = [
        '--profile',
        requiredProfile,
        'push',
        '--access',
        defaultNewAccess,
        '--json',
      ];

      if (dryRun) {
        console.log(
          `+ [WOULD CREATE] ${demo.relPath} — new ${defaultNewAccess} Pen "${info.title}" under "${requiredProfile}"`
        );
        console.log(`    Would run: cdpn ${pushArgs.join(' ')}`);
        summary.created.push(demo.relPath);
        continue;
      }

      console.log(
        `+ [CREATING] ${demo.relPath} — creating new ${defaultNewAccess} Pen "${info.title}"…`
      );
      const res = runCdpnJson(cdpnBin, pushArgs, demo.absPath);
      if (!res.ok) {
        console.log(`  ✗ Failed: ${res.errorMessage}`);
        summary.errors.push({ demo: demo.relPath, message: res.errorMessage });
        continue;
      }
      const pen = res.json?.contents?.pen;
      console.log(
        `  ✓ Created ${pen?.access || defaultNewAccess} Pen: ${pen?.urls?.editor || pen?.id || 'ok'}`
      );
      summary.created.push(demo.relPath);
      continue;
    }

    // --- UP TO DATE ---
    if (info.state === 'up-to-date') {
      console.log(`✓ [UP TO DATE] ${demo.relPath}`);
      summary.upToDate.push(demo.relPath);
      continue;
    }

    // --- CONFLICT (both local changes and remote changes) ---
    if (info.state === 'conflict') {
      const { status, localBaseline, diffChanges, infoChanges } = info;
      console.log(`! [CONFLICT] ${demo.relPath}`);
      console.log(`    Pen:            ${status.url || status.pen_id}`);
      console.log(
        `    Synced version: ${shortId(status.local_version_id)} -> Remote head: ${shortId(status.remote_version_id)}`
      );
      if (localBaseline.knownBaseline && localBaseline.hasChanges) {
        console.log('    Local file changes since last sync:');
        for (const line of formatChangesList(localBaseline, '      ')) {
          console.log(line);
        }
      } else if (!localBaseline.knownBaseline) {
        console.log(
          `    Local baseline missing in ${CONFIG_FILENAME}; cannot rule out local edits.`
        );
      }
      if (info.diffCount > 0) {
        console.log('    File differences vs remote head:');
        for (const line of formatChangesList(diffChanges, '      ')) {
          console.log(line);
        }
      }
      if (infoChanges.length > 0) {
        const fields = infoChanges.map((c) => c.field).join(', ');
        console.log(`    Pen info differences: ${fields}`);
      }
      console.log(
        `    Resolve manually in src/${demo.relPath}: run \`npx cdpn --profile ${requiredProfile} status\`, then \`push --force\` or \`pull --force\`.`
      );
      summary.conflicts.push({
        demo: demo.relPath,
        url: status.url || status.pen_id,
      });
      continue;
    }

    // --- LOCAL AHEAD (only local changed) ---
    if (info.state === 'local-ahead') {
      const changeSummary = [
        info.diffCount > 0 ? `${info.diffCount} file(s)` : null,
        info.infoCount > 0
          ? `info: ${info.infoChanges.map((c) => c.field).join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join(', ');

      if (mode === 'pull') {
        console.log(
          `- [SKIP] ${demo.relPath} — local has unpushed changes (${changeSummary}) and remote has no new changes; run \`npm run cdpn:push\` or \`npm run cdpn:sync\``
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const pushArgs = ['--profile', requiredProfile, 'push', '--json'];
      if (dryRun) {
        console.log(`↑ [WOULD PUSH] ${demo.relPath} (${changeSummary})`);
        for (const line of formatChangesList(info.diffChanges)) {
          console.log(line);
        }
        console.log(`    Would run: cdpn ${pushArgs.join(' ')}`);
        summary.pushed.push(demo.relPath);
        continue;
      }

      console.log(`↑ [PUSHING] ${demo.relPath} (${changeSummary})…`);
      for (const line of formatChangesList(info.diffChanges)) {
        console.log(line);
      }
      const res = runCdpnJson(cdpnBin, pushArgs, demo.absPath);
      if (!res.ok) {
        console.log(`  ✗ Push failed: ${res.errorMessage}`);
        summary.errors.push({ demo: demo.relPath, message: res.errorMessage });
        continue;
      }
      console.log(
        `  ✓ Pushed (version ${shortId(res.json?.contents?.version_id)})`
      );
      summary.pushed.push(demo.relPath);
      continue;
    }

    // --- REMOTE AHEAD or REMOTE METADATA AHEAD (only remote changed) ---
    if (info.state === 'remote-ahead' || info.state === 'remote-metadata-ahead') {
      const remoteSummary =
        [
          info.diffCount > 0 ? `${info.diffCount} file diff(s)` : null,
          info.infoCount > 0
            ? `info: ${info.infoChanges.map((c) => c.field).join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join(', ') || 'metadata behind';

      if (mode === 'push') {
        console.log(
          `- [SKIP] ${demo.relPath} — remote is ahead (${remoteSummary}); run \`npm run cdpn:pull\` or \`npm run cdpn:sync\``
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const pullArgs =
        info.state === 'remote-metadata-ahead'
          ? ['--profile', requiredProfile, 'pull', '--force', '--json']
          : ['--profile', requiredProfile, 'pull', '--json'];

      if (dryRun) {
        console.log(
          `↓ [WOULD PULL] ${demo.relPath} (${shortId(info.status.local_version_id)} -> ${shortId(info.status.remote_version_id)}, ${remoteSummary})`
        );
        for (const line of formatChangesList(info.diffChanges)) {
          console.log(line);
        }
        console.log(`    Would run: cdpn ${pullArgs.join(' ')}`);
        summary.pulled.push(demo.relPath);
        continue;
      }

      console.log(
        `↓ [PULLING] ${demo.relPath} (${shortId(info.status.local_version_id)} -> ${shortId(info.status.remote_version_id)}, ${remoteSummary})…`
      );
      const res = runCdpnJson(cdpnBin, pullArgs, demo.absPath);
      if (!res.ok) {
        console.log(`  ✗ Pull failed: ${res.errorMessage}`);
        summary.errors.push({ demo: demo.relPath, message: res.errorMessage });
        continue;
      }
      const written = res.json?.contents?.written_paths?.length ?? 0;
      const deleted = res.json?.contents?.deleted_paths?.length ?? 0;
      console.log(
        `  ✓ Pulled (version ${shortId(res.json?.contents?.version_id)}, updated ${written}, removed ${deleted})`
      );
      summary.pulled.push(demo.relPath);
    }
  }

  // Final Summary
  console.log(`\n${prefix}Summary (${mode}):`);
  console.log(`  Created:    ${summary.created.length}`);
  console.log(`  Pushed:     ${summary.pushed.length}`);
  console.log(`  Pulled:     ${summary.pulled.length}`);
  console.log(`  Deleted:    ${summary.deleted.length}`);
  console.log(`  Up to date: ${summary.upToDate.length}`);
  console.log(`  Skipped:    ${summary.skipped.length}`);
  console.log(`  Conflicts:  ${summary.conflicts.length}`);
  console.log(`  Errors:     ${summary.errors.length}`);

  if (!dryRun && summary.deleted.length > 0) {
    console.log(
      '\nDeleted Pens move to CodePen Deleted Items (restorable for 3 days):'
    );
    console.log('  https://codepen.io/your-work?item_type=DELETED_ITEMS');
  }

  if (summary.conflicts.length > 0) {
    console.log('\nConflicts requiring manual resolution:');
    for (const c of summary.conflicts) {
      console.log(`  - src/${c.demo} (${c.url})`);
    }
  }

  if (summary.errors.length > 0) {
    console.log('\nErrors:');
    for (const e of summary.errors) {
      console.log(`  - src/${e.demo}: ${e.message}`);
    }
  }

  if (summary.errors.length > 0 || (!dryRun && summary.conflicts.length > 0)) {
    process.exit(1);
  }
}
