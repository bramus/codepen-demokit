#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONFIG_FILENAME = ".cdpn.json";
const IGNORE_FILENAME = ".cdpnignore";
const REPO_CONFIG_FILENAME = "config.json";
const MAX_SCAN_DEPTH = 4;
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const VALID_VISIBILITIES = new Set([
  "Public",
  "Private",
  "Protected",
  "Collaborators",
]);
const BUILTIN_IGNORED_SEGMENTS = new Set([
  CONFIG_FILENAME,
  IGNORE_FILENAME,
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_CONFIG_PATH = path.resolve(ROOT_DIR, REPO_CONFIG_FILENAME);
const DEMOS_DIR = path.resolve(ROOT_DIR, "src");

function usage() {
  console.error(
    "Usage: node ./scripts/sync-codepen.mjs <push|pull|sync> [--dry-run] [--force]"
  );
}

function loadSyncConfig(configPath = REPO_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    console.warn(`Warning: ${REPO_CONFIG_FILENAME} not found at ${configPath}.`);
    console.warn(
      `  Copy config.json.example to ${REPO_CONFIG_FILENAME} and set "codepen_user" and "codepen_default_visibility".`
    );
    process.exit(1);
  }

  let parsed;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`Warning: Failed to read or parse ${REPO_CONFIG_FILENAME}: ${err.message}`);
    console.warn(
      `  Ensure ${REPO_CONFIG_FILENAME} contains valid JSON (see config.json.example).`
    );
    process.exit(1);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`Warning: ${REPO_CONFIG_FILENAME} must contain a JSON object.`);
    console.warn("  See config.json.example for the expected format.");
    process.exit(1);
  }

  const issues = [];

  const rawUser =
    typeof parsed.codepen_user === "string" ? parsed.codepen_user.trim() : "";
  if (!rawUser) {
    issues.push('"codepen_user" is missing or empty.');
  } else if (!PROFILE_NAME_PATTERN.test(rawUser)) {
    issues.push(
      `"codepen_user" contains invalid characters (got "${rawUser}").`
    );
  }

  const rawVisibility =
    typeof parsed.codepen_default_visibility === "string"
      ? parsed.codepen_default_visibility.trim()
      : "";
  if (!rawVisibility) {
    issues.push('"codepen_default_visibility" is missing or empty.');
  } else if (!VALID_VISIBILITIES.has(rawVisibility)) {
    issues.push(
      `"codepen_default_visibility" must be one of: ${[...VALID_VISIBILITIES].join(", ")} (got "${rawVisibility}").`
    );
  }

  if (issues.length > 0) {
    console.warn(
      `Warning: ${REPO_CONFIG_FILENAME} is missing required configuration or contains invalid values:`
    );
    for (const issue of issues) {
      console.warn(`  - ${issue}`);
    }
    console.warn("  See config.json.example for the expected format.");
    process.exit(1);
  }

  return {
    requiredProfile: rawUser,
    defaultNewAccess: rawVisibility,
  };
}

function parseArgs(argv) {
  let mode = null;
  let dryRun = false;
  let force = false;

  for (const arg of argv) {
    if (arg === "push" || arg === "pull" || arg === "sync") {
      if (mode) {
        console.error(`Error: Multiple modes specified ('${mode}' and '${arg}').`);
        usage();
        process.exit(1);
      }
      mode = arg;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      console.error(`Error: Unknown argument '${arg}'.`);
      usage();
      process.exit(1);
    }
  }

  if (!mode) {
    console.error("Error: Missing sync mode (expected 'push', 'pull', or 'sync').");
    usage();
    process.exit(1);
  }

  if (force && mode !== "pull") {
    console.error("Error: --force is only supported with 'pull'.");
    usage();
    process.exit(1);
  }

  return { mode, dryRun, force };
}

function spawnCdpn(cdpn, args, cwd) {
  return spawnSync(cdpn.command, [...cdpn.prefixArgs, ...args], {
    cwd,
    encoding: "utf8",
    shell: cdpn.shell,
  });
}

function resolveCdpnBinary() {
  const localCli = path.join(
    ROOT_DIR,
    "node_modules",
    "codepen-commander",
    "cli.js"
  );
  const usingLocal = fs.existsSync(localCli);
  const cdpn = usingLocal
    ? {
        command: process.execPath,
        prefixArgs: [localCli],
        shell: false,
      }
    : {
        command: "cdpn",
        prefixArgs: [],
        // On Windows, a globally installed `cdpn` is a `.cmd` shim on PATH, which
        // throws EINVAL on Node >= 20.12.2 when spawned with `shell: false`.
        // All arguments passed to `cdpn` are hardcoded literals.
        shell: process.platform === "win32",
      };

  const check = spawnCdpn(cdpn, ["--version"], ROOT_DIR);

  if (check.error || check.status !== 0) {
    console.error(
      "Error: 'cdpn' (codepen-commander) is required but was not found or failed to run."
    );
    console.error(
      "Run `npm install` (to install devDependencies) or `npm install -g codepen-commander`."
    );
    process.exit(1);
  }

  return {
    bin: cdpn,
    source: usingLocal ? "./node_modules/codepen-commander/cli.js" : "PATH",
    version: (check.stdout || "").trim() || "unknown",
  };
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

  const rawStdout = (result.stdout || "").trim();
  const rawStderr = (result.stderr || "").trim();
  let parsed = null;

  if (rawStdout) {
    try {
      parsed = JSON.parse(rawStdout);
    } catch {
      // Fallback: find the last JSON object if any preamble leaked to stdout
      const firstBrace = rawStdout.indexOf("{");
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
    typeof statusCode === "number" &&
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

function verifyProfileAuth(cdpnBin, requiredProfile) {
  const res = runCdpnJson(cdpnBin, ["auth", "status", "--json"], ROOT_DIR);
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
      const names = profiles.map((p) => p.name).filter(Boolean).join(", ");
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
    keyType: targetProfile.key_type || "unknown",
  };
}

/**
 * Recursively discovers demo folders under `./src/` (standalone, grouped, or nested groups).
 * Explicitly excludes `./src/` root (including `./src/index.html`) and stops descending once
 * a folder contains `index.html` or `.cdpn.json`.
 */
function discoverDemoDirs(demosDir) {
  if (!fs.existsSync(demosDir)) {
    console.error(`Error: src directory not found at ${demosDir}.`);
    process.exit(1);
  }

  const resolvedDemosDir = fs.realpathSync(path.resolve(demosDir));
  const demos = [];

  function walk(currentDir, segments, depth) {
    if (depth > MAX_SCAN_DEPTH) return;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const childPath = path.resolve(currentDir, entry.name);
      if (!childPath.startsWith(resolvedDemosDir + path.sep)) continue;
      if (fs.lstatSync(childPath).isSymbolicLink()) continue;

      const childSegments = [...segments, entry.name];
      const indexPath = path.join(childPath, "index.html");
      const configPath = path.join(childPath, CONFIG_FILENAME);
      const hasIndex =
        fs.existsSync(indexPath) && fs.lstatSync(indexPath).isFile();
      const hasConfig =
        fs.existsSync(configPath) && fs.lstatSync(configPath).isFile();

      if (hasIndex || hasConfig) {
        demos.push({
          relPath: childSegments.join("/"),
          absPath: childPath,
          hasIndex,
          hasConfig,
        });
        continue;
      }

      walk(childPath, childSegments, depth + 1);
    }
  }

  walk(resolvedDemosDir, [], 1);
  demos.sort((a, b) => a.relPath.localeCompare(b.relPath, "en", { numeric: true, sensitivity: "base" }));
  return demos;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadIgnoreMatchers(rootDir) {
  const ignorePath = path.join(rootDir, IGNORE_FILENAME);
  if (!fs.existsSync(ignorePath)) return [];
  const raw = fs.readFileSync(ignorePath, "utf8");
  const matchers = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalized) continue;
    const hasSlash = normalized.includes("/");
    const regexBody = normalized
      .split("**")
      .map((part) => part.split("*").map(escapeRegex).join("[^/]*"))
      .join(".*");
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
        const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
        hashes.set(penPath, sha256);
      }
    }
  }

  walk(resolvedRoot, "");
  return hashes;
}

function detectLocalChanges(demoDir, baselineFiles) {
  if (!baselineFiles || typeof baselineFiles !== "object" || Array.isArray(baselineFiles)) {
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
  const indexPath = path.join(demoDir, "index.html");
  if (!fs.existsSync(indexPath)) return null;
  const html = fs.readFileSync(indexPath, "utf8");
  const match = html.match(/<title\b[^>]{0,200}>([\s\S]{0,500}?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

function shortId(id) {
  if (!id) return "none";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatChangesList(changes, indent = "    ") {
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
      fs.readFileSync(path.join(demo.absPath, CONFIG_FILENAME), "utf8")
    );
  } catch (err) {
    return {
      ok: false,
      message: `Failed to read ${CONFIG_FILENAME}: ${err.message}`,
    };
  }

  if (config.profile && config.profile !== requiredProfile) {
    return {
      ok: false,
      message: `${CONFIG_FILENAME} is linked to profile "${config.profile}" instead of "${requiredProfile}".`,
    };
  }

  return { ok: true, config };
}

function inspectDemo(cdpnBin, demo, requiredProfile) {
  if (!demo.hasConfig) {
    return {
      state: "unlinked",
      title: extractHtmlTitle(demo.absPath) || path.basename(demo.absPath),
    };
  }

  const configRes = readAndValidateConfig(demo, requiredProfile);
  if (!configRes.ok) {
    return {
      state: "error",
      message: configRes.message,
    };
  }
  const { config } = configRes;

  const statusRes = runCdpnJson(
    cdpnBin,
    ["--profile", requiredProfile, "status", "--json"],
    demo.absPath
  );

  if (!statusRes.ok) {
    return {
      state: "error",
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
    state = "up-to-date";
  } else if (localChanged && !remoteChanged) {
    state = "local-ahead";
  } else if (!localChanged && remoteChanged) {
    state =
      diffCount === 0 && !remoteInfoChanged
        ? "remote-metadata-ahead"
        : "remote-ahead";
  } else {
    state = "conflict";
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

function main() {
  const { mode, dryRun, force } = parseArgs(process.argv.slice(2));
  const { requiredProfile, defaultNewAccess } = loadSyncConfig();
  const prefix = dryRun ? "[DRY RUN] " : "";
  const forceNote = force ? ", force: true" : "";

  console.log(
    `${prefix}CodePen Demo Sync (mode: ${mode}, profile: ${requiredProfile}, default visibility: ${defaultNewAccess}${forceNote})`
  );

  // 1. Check cdpn is installed
  const { bin: cdpnBin, source: cdpnSource, version: cdpnVersion } =
    resolveCdpnBinary();
  console.log(`  ✓ cdpn ${cdpnVersion} available (${cdpnSource})`);

  // 2. Check profile authentication via `cdpn auth status --json`
  const auth = verifyProfileAuth(cdpnBin, requiredProfile);
  console.log(`  ✓ Authenticated profile "${auth.name}" (${auth.keyType} key)`);

  // 3. Discover demos under ./src/ (explicitly excluding ./src/index.html)
  const demos = discoverDemoDirs(DEMOS_DIR);
  console.log(
    `  ✓ Found ${demos.length} demo folder(s) (excluding ./src/index.html)\n`
  );

  const summary = {
    created: [],
    pushed: [],
    pulled: [],
    upToDate: [],
    skipped: [],
    conflicts: [],
    errors: [],
  };

  for (const demo of demos) {
    // --- FORCE PULL (pull every linked demo unconditionally to refresh files & .cdpn.json) ---
    if (mode === "pull" && force) {
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

      const { config } = configRes;
      const pullArgs = ["--profile", requiredProfile, "pull", "--force", "--json"];

      if (dryRun) {
        console.log(
          `↓ [WOULD FORCE PULL] ${demo.relPath} (${config.url || config.pen_id})`
        );
        console.log(`    Would run: cdpn ${pullArgs.join(" ")}`);
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

    if (info.state === "error") {
      console.log(`✗ [ERROR] ${demo.relPath}`);
      console.log(`    ${info.message}`);
      summary.errors.push({ demo: demo.relPath, message: info.message });
      continue;
    }

    // --- UNLINKED (no .cdpn.json) ---
    if (info.state === "unlinked") {
      if (mode === "pull") {
        console.log(
          `- [SKIP] ${demo.relPath} — unlinked (no ${CONFIG_FILENAME}); nothing to pull`
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const pushArgs = [
        "--profile",
        requiredProfile,
        "push",
        "--access",
        defaultNewAccess,
        "--json",
      ];

      if (dryRun) {
        console.log(
          `+ [WOULD CREATE] ${demo.relPath} — new ${defaultNewAccess} Pen "${info.title}" under "${requiredProfile}"`
        );
        console.log(`    Would run: cdpn ${pushArgs.join(" ")}`);
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
        `  ✓ Created ${pen?.access || defaultNewAccess} Pen: ${pen?.urls?.editor || pen?.id || "ok"}`
      );
      summary.created.push(demo.relPath);
      continue;
    }

    // --- UP TO DATE ---
    if (info.state === "up-to-date") {
      console.log(`✓ [UP TO DATE] ${demo.relPath}`);
      summary.upToDate.push(demo.relPath);
      continue;
    }

    // --- CONFLICT (both local changes and remote changes) ---
    if (info.state === "conflict") {
      const { status, localBaseline, diffChanges, infoChanges } = info;
      console.log(`! [CONFLICT] ${demo.relPath}`);
      console.log(`    Pen:            ${status.url || status.pen_id}`);
      console.log(
        `    Synced version: ${shortId(status.local_version_id)} -> Remote head: ${shortId(status.remote_version_id)}`
      );
      if (localBaseline.knownBaseline && localBaseline.hasChanges) {
        console.log("    Local file changes since last sync:");
        for (const line of formatChangesList(localBaseline, "      ")) {
          console.log(line);
        }
      } else if (!localBaseline.knownBaseline) {
        console.log(
          `    Local baseline missing in ${CONFIG_FILENAME}; cannot rule out local edits.`
        );
      }
      if (info.diffCount > 0) {
        console.log("    File differences vs remote head:");
        for (const line of formatChangesList(diffChanges, "      ")) {
          console.log(line);
        }
      }
      if (infoChanges.length > 0) {
        const fields = infoChanges.map((c) => c.field).join(", ");
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
    if (info.state === "local-ahead") {
      const changeSummary = [
        info.diffCount > 0 ? `${info.diffCount} file(s)` : null,
        info.infoCount > 0
          ? `info: ${info.infoChanges.map((c) => c.field).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(", ");

      if (mode === "pull") {
        console.log(
          `- [SKIP] ${demo.relPath} — local has unpushed changes (${changeSummary}) and remote has no new changes; run \`npm run cdpn:push\` or \`npm run cdpn:sync\``
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      const pushArgs = ["--profile", requiredProfile, "push", "--json"];
      if (dryRun) {
        console.log(`↑ [WOULD PUSH] ${demo.relPath} (${changeSummary})`);
        for (const line of formatChangesList(info.diffChanges)) {
          console.log(line);
        }
        console.log(`    Would run: cdpn ${pushArgs.join(" ")}`);
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
    if (info.state === "remote-ahead" || info.state === "remote-metadata-ahead") {
      const remoteSummary = [
        info.diffCount > 0 ? `${info.diffCount} file diff(s)` : null,
        info.infoCount > 0
          ? `info: ${info.infoChanges.map((c) => c.field).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(", ") || "metadata behind";

      if (mode === "push") {
        console.log(
          `- [SKIP] ${demo.relPath} — remote is ahead (${remoteSummary}); run \`npm run cdpn:pull\` or \`npm run cdpn:sync\``
        );
        summary.skipped.push(demo.relPath);
        continue;
      }

      // If local content already matches remote (diffCount === 0), --force safely updates .cdpn.json metadata
      const pullArgs =
        info.state === "remote-metadata-ahead"
          ? ["--profile", requiredProfile, "pull", "--force", "--json"]
          : ["--profile", requiredProfile, "pull", "--json"];

      if (dryRun) {
        console.log(
          `↓ [WOULD PULL] ${demo.relPath} (${shortId(info.status.local_version_id)} -> ${shortId(info.status.remote_version_id)}, ${remoteSummary})`
        );
        for (const line of formatChangesList(info.diffChanges)) {
          console.log(line);
        }
        console.log(`    Would run: cdpn ${pullArgs.join(" ")}`);
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
  console.log(`  Up to date: ${summary.upToDate.length}`);
  console.log(`  Skipped:    ${summary.skipped.length}`);
  console.log(`  Conflicts:  ${summary.conflicts.length}`);
  console.log(`  Errors:     ${summary.errors.length}`);

  if (summary.conflicts.length > 0) {
    console.log("\nConflicts requiring manual resolution:");
    for (const c of summary.conflicts) {
      console.log(`  - src/${c.demo} (${c.url})`);
    }
  }

  if (summary.errors.length > 0) {
    console.log("\nErrors:");
    for (const e of summary.errors) {
      console.log(`  - src/${e.demo}: ${e.message}`);
    }
  }

  if (summary.errors.length > 0 || (!dryRun && summary.conflicts.length > 0)) {
    process.exit(1);
  }
}

main();
