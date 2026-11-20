import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { PACKAGE_DIR } from './build-site.mjs';
import {
  DEFAULT_SITE_CONFIG,
  DEFAULT_VISIBILITY,
  PROFILE_NAME_PATTERN,
  VISIBILITY_OPTIONS,
} from './config.mjs';
import { locateCdpnBinary } from './sync-codepen.mjs';

const TEMPLATES_DIR = path.join(PACKAGE_DIR, 'templates');
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

const VISIBILITY_BY_LOWER = new Map(
  VISIBILITY_OPTIONS.map((option) => [option.toLowerCase(), option]),
);

export class InitCancelledError extends Error {
  constructor() {
    super('Init cancelled.');
    this.name = 'InitCancelledError';
  }
}

export function slugifyDirectoryName(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'my-codepen-demos';
}

function toValidPackageName(dirName) {
  const cleaned = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '');
  return cleaned || 'my-codepen-demos';
}

export function normalizeVisibility(rawInput) {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) return DEFAULT_VISIBILITY;
  return VISIBILITY_BY_LOWER.get(trimmed.toLowerCase()) ?? null;
}

function isWithinRoot(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

async function resolveTargetDirectory(rawInput, baseCwd) {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Directory cannot be empty.' };
  }

  if (CONTROL_CHAR_PATTERN.test(trimmed) || trimmed.includes('\\')) {
    return {
      ok: false,
      error: 'Directory contains invalid characters. Use a relative path with forward slashes.',
    };
  }

  if (path.isAbsolute(trimmed)) {
    return {
      ok: false,
      error: 'Please enter a relative directory path (e.g., "my-codepen-demos" or ".").',
    };
  }

  let resolvedDir;
  if (trimmed === '.' || trimmed === './') {
    resolvedDir = baseCwd;
  } else {
    let normalized = trimmed;
    while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/\/+$/, '');

    if (!normalized || normalized === '.') {
      resolvedDir = baseCwd;
    } else {
      const segments = normalized.split('/').filter(Boolean);
      for (const segment of segments) {
        if (segment === '.' || segment === '..' || segment.startsWith('.')) {
          return {
            ok: false,
            error: 'Directory cannot contain "..", ".", or hidden folder segments.',
          };
        }
      }
      resolvedDir = path.resolve(baseCwd, ...segments);
    }
  }

  if (!isWithinRoot(resolvedDir, baseCwd)) {
    return {
      ok: false,
      error: 'Directory must resolve inside the current working directory.',
    };
  }

  const baseRealpath = await fs.realpath(baseCwd);

  // Check nearest existing path to guard against symlinks or file collisions
  let probe = resolvedDir;
  while (true) {
    try {
      const stat = await fs.lstat(probe);
      if (probe === resolvedDir) {
        if (stat.isSymbolicLink()) {
          return {
            ok: false,
            error: `"${trimmed}" is a symbolic link. Please choose a regular directory.`,
          };
        }
        if (!stat.isDirectory()) {
          return {
            ok: false,
            error: `"${trimmed}" already exists and is not a directory.`,
          };
        }
      } else if (!stat.isDirectory()) {
        return {
          ok: false,
          error: `Cannot create "${trimmed}" because an ancestor path is a file.`,
        };
      }

      const realProbe = await fs.realpath(probe);
      if (!isWithinRoot(realProbe, baseRealpath)) {
        return {
          ok: false,
          error: `"${trimmed}" resolves outside the current working directory.`,
        };
      }
      break;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        if (probe === baseCwd) break;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      throw err;
    }
  }

  return {
    ok: true,
    resolvedDir,
    isCurrentDir: resolvedDir === baseCwd,
  };
}

function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  let closed = false;

  if (input.isTTY) {
    const rl = readline.createInterface({ input, output });
    const abortController = new AbortController();
    const onSigint = () => {
      abortController.abort();
      if (!closed) {
        closed = true;
        rl.close();
      }
    };
    rl.on('SIGINT', onSigint);

    return {
      async ask(promptText) {
        try {
          return await rl.question(promptText, { signal: abortController.signal });
        } catch (err) {
          if (
            abortController.signal.aborted ||
            err?.name === 'AbortError' ||
            err?.code === 'ABORT_ERR' ||
            err?.code === 'ERR_USE_AFTER_CLOSE'
          ) {
            output.write('\n');
            throw new InitCancelledError();
          }
          throw err;
        }
      },
      close() {
        if (closed) return;
        closed = true;
        rl.off('SIGINT', onSigint);
        rl.close();
      },
    };
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const iterator = rl[Symbol.asyncIterator]();

  return {
    async ask(promptText) {
      output.write(promptText);
      const { value, done } = await iterator.next();
      output.write('\n');
      if (done) {
        throw new InitCancelledError();
      }
      return value;
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}

async function promptYesNo(prompter, output, promptText, defaultValue = true) {
  while (true) {
    const raw = await prompter.ask(promptText);
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return defaultValue;
    if (trimmed === 'y' || trimmed === 'yes') return true;
    if (trimmed === 'n' || trimmed === 'no') return false;
    output.write('  Please answer "y" or "n".\n');
  }
}

export function checkCodePenProfileStatus(username, projectDir = process.cwd()) {
  const trimmed = String(username ?? '').trim();
  if (!trimmed || !PROFILE_NAME_PATTERN.test(trimmed)) {
    return { status: 'unknown', cdpnBin: null };
  }

  const located = locateCdpnBinary(projectDir);
  if (!located) {
    return { status: 'unknown', cdpnBin: null };
  }

  const res = spawnSync(
    located.bin.command,
    [...located.bin.prefixArgs, '--profile', trimmed, 'auth', 'status', '--offline', '--json'],
    {
      cwd: projectDir,
      encoding: 'utf8',
      shell: located.bin.shell,
    },
  );

  if (res.error) {
    return { status: 'unknown', cdpnBin: located.bin };
  }

  let parsed = null;
  const rawStdout = (res.stdout || '').trim();
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
  if (res.status === 0 && statusCode === 200) {
    return { status: 'configured', cdpnBin: located.bin };
  }
  if (statusCode === 404) {
    return { status: 'missing', cdpnBin: located.bin };
  }
  return { status: 'unknown', cdpnBin: located.bin };
}

async function promptInitOptions({
  cwd = process.cwd(),
  output = process.stdout,
  prompter,
}) {
  const baseCwd = path.resolve(cwd);

  output.write('Create a new codepen-demokit project\n\n');

  let projectName;
  while (true) {
    const raw = await prompter.ask(`Project name (${DEFAULT_SITE_CONFIG.title}): `);
    const trimmed = raw.trim();
    if (CONTROL_CHAR_PATTERN.test(trimmed)) {
      output.write('  Project name contains invalid control characters.\n');
      continue;
    }
    projectName = trimmed || DEFAULT_SITE_CONFIG.title;
    break;
  }

  const defaultDir = slugifyDirectoryName(projectName);
  let targetDir;
  let isCurrentDir;
  while (true) {
    const raw = await prompter.ask(`Directory (${defaultDir}): `);
    const candidate = raw.trim() || defaultDir;
    const result = await resolveTargetDirectory(candidate, baseCwd);
    if (!result.ok) {
      output.write(`  ${result.error}\n`);
      continue;
    }
    targetDir = result.resolvedDir;
    isCurrentDir = result.isCurrentDir;
    break;
  }

  output.write('\nCodePen details:\n');

  let codepenUser;
  while (true) {
    const raw = await prompter.ask('CodePen username (optional): ');
    const trimmed = raw.trim();
    if (!trimmed) {
      codepenUser = '';
      break;
    }
    if (!PROFILE_NAME_PATTERN.test(trimmed)) {
      output.write(
        `  Invalid CodePen username "${trimmed}". Use letters, numbers, ".", "_", or "-" (without "@").\n`,
      );
      continue;
    }
    codepenUser = trimmed;
    break;
  }

  let defaultVisibility;
  while (true) {
    const raw = await prompter.ask(
      `Default visibility [${VISIBILITY_OPTIONS.join(', ')}] (${DEFAULT_VISIBILITY}): `,
    );
    const normalized = normalizeVisibility(raw);
    if (!normalized) {
      output.write(
        `  Invalid visibility "${raw.trim()}". Choose one of: ${VISIBILITY_OPTIONS.join(', ')}.\n`,
      );
      continue;
    }
    defaultVisibility = normalized;
    break;
  }

  return {
    projectName,
    targetDir,
    isCurrentDir,
    codepenUser,
    defaultVisibility,
  };
}

async function readFrameworkVersion() {
  const pkgJsonPath = path.join(PACKAGE_DIR, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
  return pkg.version || '1.0.0';
}

async function writeIfMissing(destPath, content) {
  if (existsSync(destPath)) {
    return 'skipped';
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, content, 'utf8');
  return 'created';
}

async function copyIfMissing(srcPath, destPath) {
  if (existsSync(destPath)) {
    return 'skipped';
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.copyFile(srcPath, destPath);
  return 'created';
}

function printNextSteps({
  output = process.stdout,
  cwd = process.cwd(),
  targetDir,
  codepenUser = '',
  needsAuthLogin = true,
}) {
  const writeLine = (line = '') => output.write(`${line}\n`);
  const relDir = path.relative(path.resolve(cwd), path.resolve(targetDir));
  const steps = [];
  if (relDir && relDir !== '.') {
    steps.push(`cd ${relDir}`);
  }
  steps.push('npm install');
  if (codepenUser) {
    if (needsAuthLogin) {
      steps.push(`npx cdpn auth login ${codepenUser}`);
    }
  } else {
    steps.push('Edit config.json to set your CodePen profile ("codepen.user")');
    steps.push('npx cdpn auth login <your-codepen-username>');
  }
  steps.push('npm start');

  writeLine();
  writeLine('Next steps:');
  steps.forEach((step, idx) => {
    writeLine(`  ${idx + 1}. ${step}`);
  });
}

export async function scaffoldProject({
  targetDir,
  projectName = DEFAULT_SITE_CONFIG.title,
  isCurrentDir = false,
  codepenUser = '',
  defaultVisibility = DEFAULT_VISIBILITY,
  cwd = process.cwd(),
  output = process.stdout,
  showNextSteps = true,
  needsAuthLogin = Boolean(codepenUser),
}) {
  const resolvedDir = path.resolve(targetDir);
  await fs.mkdir(resolvedDir, { recursive: true });

  const version = await readFrameworkVersion();
  const packageName = isCurrentDir
    ? toValidPackageName(slugifyDirectoryName(projectName))
    : toValidPackageName(path.basename(resolvedDir));
  const results = [];

  const record = (relPath, status) => {
    results.push({ path: relPath, status });
  };

  const consumerPackageJson = {
    name: packageName,
    version: '1.0.0',
    private: true,
    description: 'Self-contained web demos synced with CodePen.',
    type: 'module',
    scripts: {
      start: 'codepen-demokit start',
      dev: 'codepen-demokit start',
      build: 'codepen-demokit build',
      'build:watch': 'codepen-demokit build --watch',
      'cdpn:sync': 'codepen-demokit cdpn sync',
      'cdpn:pull': 'codepen-demokit cdpn pull',
      'cdpn:push': 'codepen-demokit cdpn push',
      'cdpn:delete': 'codepen-demokit cdpn delete',
      'cdpn:clone': 'codepen-demokit cdpn clone',
      cdpn: 'cdpn',
    },
    engines: {
      node: '>=20',
    },
    devDependencies: {
      'codepen-demokit': `^${version}`,
    },
  };

  record(
    'package.json',
    await writeIfMissing(
      path.join(resolvedDir, 'package.json'),
      `${JSON.stringify(consumerPackageJson, null, 2)}\n`,
    ),
  );

  // Copy template files (note: gitignore is named `gitignore` inside templates/ so npm pack always includes it!)
  const templateCopies = [
    ['gitignore', '.gitignore'],
    ['config.json.example', 'config.json.example'],
  ];

  for (const [srcName, destName] of templateCopies) {
    const status = await copyIfMissing(
      path.join(TEMPLATES_DIR, srcName),
      path.join(resolvedDir, destName),
    );
    record(destName, status);
  }

  const consumerConfig = {
    site: {
      title: projectName,
      subtitle: DEFAULT_SITE_CONFIG.subtitle,
    },
    codepen: {
      user: codepenUser,
      defaultVisibility,
    },
  };

  record(
    'config.json',
    await writeIfMissing(
      path.join(resolvedDir, 'config.json'),
      `${JSON.stringify(consumerConfig, null, 2)}\n`,
    ),
  );

  record(
    'AGENTS.md',
    await copyIfMissing(
      path.join(TEMPLATES_DIR, 'AGENTS.md'),
      path.join(resolvedDir, 'AGENTS.md'),
    ),
  );

  const readmeTemplate = await fs.readFile(path.join(TEMPLATES_DIR, 'README.md'), 'utf8');
  const renderedReadme = readmeTemplate.replace(/^# .+/, () => `# ${projectName}`);
  record(
    'README.md',
    await writeIfMissing(path.join(resolvedDir, 'README.md'), renderedReadme),
  );

  record(
    'src/.gitkeep',
    await writeIfMissing(path.join(resolvedDir, 'src', '.gitkeep'), ''),
  );

  const writeLine = (line = '') => output.write(`${line}\n`);

  writeLine();
  writeLine(`Initialized codepen-demokit project in ${resolvedDir}`);
  writeLine();
  for (const item of results) {
    const icon = item.status === 'created' ? '+' : '-';
    const label = item.status === 'created' ? 'CREATED' : 'SKIPPED';
    writeLine(`  ${icon} [${label}] ${item.path}`);
  }

  if (showNextSteps) {
    printNextSteps({ output, cwd, targetDir: resolvedDir, codepenUser, needsAuthLogin });
  }

  return {
    targetDir: resolvedDir,
    projectName,
    codepenUser,
    defaultVisibility,
    results,
  };
}

export async function initProject({
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const prompter = createPrompter({ input, output });

  try {
    const options = await promptInitOptions({ cwd, output, prompter });
    const scaffoldResult = await scaffoldProject({
      ...options,
      cwd,
      output,
      showNextSteps: false,
    });

    let needsAuthLogin = Boolean(options.codepenUser);
    if (options.codepenUser) {
      const { status, cdpnBin } = checkCodePenProfileStatus(
        options.codepenUser,
        scaffoldResult.targetDir,
      );

      if (status === 'configured') {
        output.write(
          `\nCodePen Commander profile "${options.codepenUser}" is already configured.\n`,
        );
        needsAuthLogin = false;
      } else if (status === 'missing' && cdpnBin) {
        output.write(
          `\nNo CodePen Commander configuration found for "${options.codepenUser}".\n`,
        );
        let shouldLogin = false;
        try {
          shouldLogin = await promptYesNo(
            prompter,
            output,
            `Run \`cdpn auth login ${options.codepenUser}\` now? (Y/n): `,
            true,
          );
        } catch (err) {
          if (err instanceof InitCancelledError) {
            shouldLogin = false;
          } else {
            throw err;
          }
        }

        // Release stdin cleanly before handing terminal control to `cdpn auth login`
        prompter.close();

        if (shouldLogin) {
          output.write('\n');
          const loginRes = spawnSync(
            cdpnBin.command,
            [...cdpnBin.prefixArgs, 'auth', 'login', options.codepenUser],
            {
              cwd: scaffoldResult.targetDir,
              stdio: 'inherit',
              shell: cdpnBin.shell,
            },
          );
          if (!loginRes.error && loginRes.status === 0) {
            needsAuthLogin = false;
          }
        }
      }
    }

    prompter.close();
    printNextSteps({
      output,
      cwd,
      targetDir: scaffoldResult.targetDir,
      codepenUser: options.codepenUser,
      needsAuthLogin,
    });

    return {
      ...scaffoldResult,
      authConfigured: Boolean(options.codepenUser) && !needsAuthLogin,
    };
  } finally {
    prompter.close();
  }
}
