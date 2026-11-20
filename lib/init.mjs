import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
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

const VISIBILITY_DESCRIPTIONS = Object.freeze({
  Private: 'unlisted; anyone with the link can view it',
  Public: 'visible to everyone',
  Protected: 'private and password-protected',
  Collaborators: 'private; visible only to you and collaborators',
});

const VISIBILITY_CHOICES = Object.freeze(
  VISIBILITY_OPTIONS.map((option) => ({
    value: option,
    label: option,
    description: VISIBILITY_DESCRIPTIONS[option] || '',
  })),
);

function createFormatter(output = process.stdout) {
  const colorsEnabled = () => {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
      return false;
    }
    if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') {
      return true;
    }
    return Boolean(output.isTTY);
  };

  const wrap = (code, text) => {
    if (!colorsEnabled()) return text;
    return `\x1b[${code}m${text}\x1b[0m`;
  };

  return {
    bold: (s) => wrap('1', s),
    dim: (s) => wrap('2', s),
    red: (s) => wrap('31', s),
    green: (s) => wrap('32', s),
    yellow: (s) => wrap('33', s),
    blue: (s) => wrap('34', s),
    magenta: (s) => wrap('35', s),
    cyan: (s) => wrap('36', s),
    gray: (s) => wrap('90', s),
    boldGreen: (s) => wrap('1;32', s),
    boldYellow: (s) => wrap('1;33', s),
    boldCyan: (s) => wrap('1;36', s),
    boldMagenta: (s) => wrap('1;35', s),
    boldRed: (s) => wrap('1;31', s),
  };
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function countTerminalRows(lines, columns) {
  const safeCols = Math.max(1, columns);
  let total = 0;
  for (const rawLine of lines) {
    for (const subLine of rawLine.split('\n')) {
      const visibleLength = stripAnsi(subLine).length;
      total += visibleLength === 0 ? 1 : Math.ceil(visibleLength / safeCols);
    }
  }
  return total;
}

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

function promptSelectInteractive({ question, options, defaultIndex, input, output, fmt }) {
  readline.emitKeypressEvents(input);

  let selectedIndex = defaultIndex;
  let windowStart = 0;
  let lastRenderedRows = 0;
  let settled = false;

  const getColumns = () => Math.max(20, output.columns || 80);
  const getMaxVisible = () => {
    const termRows = output.rows || 24;
    const available = Math.max(3, termRows - 5);
    return Math.min(options.length, available, 12);
  };

  const syncWindow = (maxVisible) => {
    if (options.length <= maxVisible) {
      windowStart = 0;
      return;
    }
    if (selectedIndex < windowStart) {
      windowStart = selectedIndex;
    } else if (selectedIndex >= windowStart + maxVisible) {
      windowStart = selectedIndex - maxVisible + 1;
    }
    const maxStart = Math.max(0, options.length - maxVisible);
    if (windowStart > maxStart) {
      windowStart = maxStart;
    }
  };

  const erasePrevious = () => {
    if (lastRenderedRows <= 0) return '';
    return `\x1b[${lastRenderedRows}A\r\x1b[J`;
  };

  const renderActive = (hideCursor) => {
    const columns = getColumns();
    const maxVisible = getMaxVisible();
    syncWindow(maxVisible);

    const lines = [
      `${fmt.cyan('◆')} ${fmt.bold(question)} ${fmt.dim('(↑/↓, Enter)')}`,
    ];

    if (windowStart > 0) {
      lines.push(`    ${fmt.dim(`↑ ${windowStart} more`)}`);
    }

    const windowEnd = Math.min(options.length, windowStart + maxVisible);
    for (let i = windowStart; i < windowEnd; i++) {
      const opt = options[i];
      const isSelected = i === selectedIndex;
      if (isSelected) {
        const desc = opt.description ? ` ${fmt.cyan(`— ${opt.description}`)}` : '';
        lines.push(`  ${fmt.boldCyan('→')} ${fmt.boldCyan(opt.label)}${desc}`);
      } else {
        const desc = opt.description ? ` ${fmt.dim(`— ${opt.description}`)}` : '';
        lines.push(`    ${opt.label}${desc}`);
      }
    }

    const hiddenBelow = options.length - windowEnd;
    if (hiddenBelow > 0) {
      lines.push(`    ${fmt.dim(`↓ ${hiddenBelow} more`)}`);
    }

    const prefix = `${hideCursor ? '\x1b[?25l' : ''}${erasePrevious()}`;
    output.write(`${prefix}${lines.join('\n')}\n`);
    lastRenderedRows = countTerminalRows(lines, columns);
  };

  const renderFinal = (lines) => {
    const prefix = erasePrevious();
    output.write(`${prefix}${lines.join('\n')}\n\x1b[?25h`);
    lastRenderedRows = 0;
  };

  const wasRaw = Boolean(input.isRaw);
  input.setRawMode?.(true);
  input.resume();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      input.removeListener('end', onEnd);
      output.removeListener('resize', onResize);
      process.removeListener('SIGINT', onSigint);
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // Ignore if stream already closed
      }
      input.pause();
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      renderFinal([
        `${fmt.cyan('◆')} ${fmt.bold(question)}`,
        `  ${fmt.red('×')} ${fmt.dim('Cancelled')}`,
      ]);
      reject(new InitCancelledError());
    };

    const confirm = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const chosen = options[selectedIndex];
      const desc = chosen.description ? ` ${fmt.dim(`— ${chosen.description}`)}` : '';
      renderFinal([
        `${fmt.cyan('◆')} ${fmt.bold(question)}`,
        `  ${fmt.boldGreen('→')} ${fmt.boldGreen(chosen.label)}${desc}`,
      ]);
      resolve(chosen.value);
    };

    const onResize = () => {
      if (settled) return;
      renderActive(false);
    };

    const onSigint = () => {
      cancel();
    };

    const onEnd = () => {
      cancel();
    };

    const onKeypress = (str, key) => {
      if (settled) return;

      if (str === '\u0003' || (key?.ctrl && key.name === 'c') || key?.name === 'escape') {
        cancel();
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        confirm();
        return;
      }

      if (key?.name === 'up' || (!key?.ctrl && !key?.meta && key?.name === 'k')) {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        renderActive(false);
        return;
      }

      if (key?.name === 'down' || (!key?.ctrl && !key?.meta && key?.name === 'j')) {
        selectedIndex = (selectedIndex + 1) % options.length;
        renderActive(false);
        return;
      }

      if (key?.name === 'home' || key?.name === 'pageup') {
        if (selectedIndex !== 0) {
          selectedIndex = 0;
          renderActive(false);
        }
        return;
      }

      if (key?.name === 'end' || key?.name === 'pagedown') {
        if (selectedIndex !== options.length - 1) {
          selectedIndex = options.length - 1;
          renderActive(false);
        }
        return;
      }

      if (str && !key?.ctrl && !key?.meta) {
        if (/^[1-9]$/.test(str)) {
          const idx = Number.parseInt(str, 10) - 1;
          if (idx >= 0 && idx < options.length && idx !== selectedIndex) {
            selectedIndex = idx;
            renderActive(false);
          }
          return;
        }

        const lower = str.toLowerCase();
        const shortcutIdx = options.findIndex(
          (opt) => opt.shortcut && opt.shortcut.toLowerCase() === lower,
        );
        if (shortcutIdx !== -1 && shortcutIdx !== selectedIndex) {
          selectedIndex = shortcutIdx;
          renderActive(false);
        }
      }
    };

    input.on('keypress', onKeypress);
    input.once('end', onEnd);
    output.on('resize', onResize);
    process.on('SIGINT', onSigint);
    renderActive(true);
  });
}

function createPrompter({
  input = process.stdin,
  output = process.stdout,
  fmt = createFormatter(output),
  term = process.env.TERM,
} = {}) {
  const canUseInteractive =
    Boolean(input.isTTY) &&
    Boolean(output.isTTY) &&
    typeof input.setRawMode === 'function' &&
    term !== 'dumb';

  let closed = false;
  let activeRl = null;

  const formatQuestionHeader = (question, defaultValue) => {
    const hint = defaultValue ? ` ${fmt.dim(`(${defaultValue})`)}` : '';
    return `${fmt.cyan('◆')} ${fmt.bold(question)}${hint}`;
  };

  if (canUseInteractive) {
    const readLineInteractive = async (promptText) => {
      const rl = readlinePromises.createInterface({ input, output });
      activeRl = rl;
      const abortController = new AbortController();

      const onSigint = () => {
        abortController.abort();
        rl.close();
      };
      const onClose = () => {
        abortController.abort();
      };

      rl.on('SIGINT', onSigint);
      rl.once('close', onClose);

      try {
        return await rl.question(promptText, { signal: abortController.signal });
      } catch (err) {
        if (
          abortController.signal.aborted ||
          err?.name === 'AbortError' ||
          err?.code === 'ABORT_ERR' ||
          err?.code === 'ERR_USE_AFTER_CLOSE'
        ) {
          output.write(`\r\x1b[K  ${fmt.red('×')} ${fmt.dim('Cancelled')}\n`);
          throw new InitCancelledError();
        }
        throw err;
      } finally {
        rl.off('SIGINT', onSigint);
        rl.off('close', onClose);
        if (activeRl === rl) {
          activeRl = null;
        }
        rl.close();
      }
    };

    return {
      async askText({ question, defaultValue = '', validate }) {
        output.write(`${formatQuestionHeader(question, defaultValue)}\n`);
        const promptText = `  ${fmt.boldCyan('→')} `;
        const columns = () => Math.max(20, output.columns || 80);

        while (true) {
          const raw = await readLineInteractive(promptText);
          const result = await validate(raw);
          if (!result.ok) {
            output.write(`  ${fmt.yellow(result.error)}\n`);
            continue;
          }

          const displayText = result.displayValue ?? String(result.value);
          const enteredRows = countTerminalRows([`  → ${raw}`], columns());
          output.write(
            `\x1b[${enteredRows}A\r\x1b[J  ${fmt.boldGreen('→')} ${fmt.boldGreen(displayText)}\n`,
          );
          return result.value;
        }
      },

      async select({ question, options, defaultIndex = 0 }) {
        if (!Array.isArray(options) || options.length === 0) {
          throw new Error('select requires at least one option.');
        }
        const clampedDefault = Math.min(Math.max(0, Math.trunc(defaultIndex)), options.length - 1);
        return promptSelectInteractive({
          question,
          options,
          defaultIndex: clampedDefault,
          input,
          output,
          fmt,
        });
      },

      close() {
        if (closed) return;
        closed = true;
        if (activeRl) {
          activeRl.close();
          activeRl = null;
        }
      },
    };
  }

  // Non-interactive / piped / dumb terminal fallback: keep a single shared readline iterator
  // so buffered lines from piped stdin are never dropped between prompts.
  const rl = readlinePromises.createInterface({ input, crlfDelay: Infinity });
  const iterator = rl[Symbol.asyncIterator]();

  const readFallbackLine = async (promptText) => {
    output.write(promptText);
    const { value, done } = await iterator.next();
    if (done) {
      output.write('\n');
      throw new InitCancelledError();
    }
    return value;
  };

  return {
    async askText({ question, defaultValue = '', validate }) {
      output.write(`${formatQuestionHeader(question, defaultValue)}\n`);
      while (true) {
        const raw = await readFallbackLine(`  ${fmt.boldCyan('→')} `);
        const result = await validate(raw);
        if (!result.ok) {
          output.write(`${raw}\n  ${fmt.yellow(result.error)}\n`);
          continue;
        }
        const displayText = result.displayValue ?? String(result.value);
        output.write(`${fmt.boldGreen(displayText)}\n`);
        return result.value;
      }
    },

    async select({ question, options, defaultIndex = 0 }) {
      if (!Array.isArray(options) || options.length === 0) {
        throw new Error('select requires at least one option.');
      }
      const clampedDefault = Math.min(Math.max(0, Math.trunc(defaultIndex)), options.length - 1);
      output.write(`${formatQuestionHeader(question)}\n`);
      options.forEach((opt, idx) => {
        const num = fmt.cyan(`${idx + 1})`);
        const desc = opt.description ? ` ${fmt.dim(`— ${opt.description}`)}` : '';
        output.write(`  ${num} ${opt.label}${desc}\n`);
      });

      while (true) {
        const raw = await readFallbackLine(
          `  ${fmt.dim(`Choose [1-${options.length}] (default ${clampedDefault + 1}):`)} `,
        );
        const trimmed = raw.trim();
        output.write('\n');

        let matched = null;
        if (!trimmed) {
          matched = options[clampedDefault];
        } else {
          const num = Number.parseInt(trimmed, 10);
          if (!Number.isNaN(num) && num >= 1 && num <= options.length && String(num) === trimmed) {
            matched = options[num - 1];
          } else {
            const lower = trimmed.toLowerCase();
            matched =
              options.find(
                (opt) =>
                  opt.label.toLowerCase() === lower ||
                  String(opt.value).toLowerCase() === lower ||
                  (opt.shortcut && opt.shortcut.toLowerCase() === lower),
              ) ?? null;
          }
        }

        if (matched) {
          const desc = matched.description ? ` ${fmt.dim(`— ${matched.description}`)}` : '';
          output.write(`  ${fmt.boldGreen('→')} ${fmt.boldGreen(matched.label)}${desc}\n`);
          return matched.value;
        }

        output.write(
          `  ${fmt.yellow(`Please choose a number between 1 and ${options.length} (or an option name).`)}\n`,
        );
      }
    },

    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}

async function promptYesNo(prompter, question, defaultYes = true) {
  const options = defaultYes
    ? [
        { value: true, label: 'Yes', shortcut: 'y' },
        { value: false, label: 'No', shortcut: 'n' },
      ]
    : [
        { value: false, label: 'No', shortcut: 'n' },
        { value: true, label: 'Yes', shortcut: 'y' },
      ];
  return prompter.select({ question, options, defaultIndex: 0 });
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
  fmt = createFormatter(output),
}) {
  const baseCwd = path.resolve(cwd);

  output.write('\n');
  output.write(
    `${fmt.boldGreen('✦')} ${fmt.bold('Welcome to')} ${fmt.boldCyan('codepen-demokit')}${fmt.bold('!')}\n`,
  );
  output.write(
    `  ${fmt.dim("Let's get your new self-contained web demos repository set up.")}\n`,
  );

  output.write('\n');
  const projectName = await prompter.askText({
    question: 'Project name',
    defaultValue: DEFAULT_SITE_CONFIG.title,
    validate(raw) {
      const trimmed = raw.trim();
      if (CONTROL_CHAR_PATTERN.test(trimmed)) {
        return { ok: false, error: 'Project name contains invalid control characters.' };
      }
      const value = trimmed || DEFAULT_SITE_CONFIG.title;
      return { ok: true, value, displayValue: value };
    },
  });

  output.write('\n');
  const defaultDir = slugifyDirectoryName(projectName);
  const { resolvedDir: targetDir, isCurrentDir } = await prompter.askText({
    question: 'Directory',
    defaultValue: defaultDir,
    async validate(raw) {
      const candidate = raw.trim() || defaultDir;
      const result = await resolveTargetDirectory(candidate, baseCwd);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true, value: result, displayValue: candidate };
    },
  });

  output.write('\n');
  const setupCodePenNow = await promptYesNo(
    prompter,
    'Do you want to set up your CodePen details right now?',
    true,
  );

  let codepenUser = '';
  let defaultVisibility = DEFAULT_VISIBILITY;

  if (setupCodePenNow) {
    output.write('\n');
    codepenUser = await prompter.askText({
      question: 'CodePen username',
      validate(raw) {
        const trimmed = raw.trim();
        if (!trimmed) {
          return {
            ok: false,
            error: 'Please enter a CodePen username (letters, numbers, ".", "_", or "-").',
          };
        }
        if (!PROFILE_NAME_PATTERN.test(trimmed)) {
          return {
            ok: false,
            error: `Invalid CodePen username "${trimmed}". Use letters, numbers, ".", "_", or "-" (without "@").`,
          };
        }
        return { ok: true, value: trimmed, displayValue: trimmed };
      },
    });

    output.write('\n');
    const defaultVisIdx = Math.max(
      0,
      VISIBILITY_CHOICES.findIndex((choice) => choice.value === DEFAULT_VISIBILITY),
    );
    defaultVisibility = await prompter.select({
      question: 'Default visibility for new Pens',
      options: VISIBILITY_CHOICES,
      defaultIndex: defaultVisIdx,
    });
  }

  return {
    projectName,
    targetDir,
    isCurrentDir,
    codepenUser,
    defaultVisibility,
  };
}

async function readFrameworkMeta() {
  const pkgJsonPath = path.join(PACKAGE_DIR, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
  return {
    version: pkg.version || '1.0.0',
    codepenCommanderRange: pkg.dependencies?.['codepen-commander'] || '^1.3.0',
  };
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
  fmt = createFormatter(output),
}) {
  const writeLine = (line = '') => output.write(`${line}\n`);
  const relDir = path.relative(path.resolve(cwd), path.resolve(targetDir));
  const steps = [];
  if (relDir && relDir !== '.') {
    steps.push(fmt.cyan(`cd ${relDir}`));
  }
  steps.push(fmt.cyan('npm install'));
  if (codepenUser) {
    if (needsAuthLogin) {
      steps.push(fmt.cyan(`npx cdpn auth login ${codepenUser}`));
    }
  } else {
    steps.push(
      `Edit ${fmt.magenta('config.json')} to set your CodePen profile ${fmt.dim('("codepen.user")')}`,
    );
    steps.push(fmt.cyan('npx cdpn auth login <your-codepen-username>'));
  }
  steps.push(fmt.cyan('npm start'));

  writeLine();
  writeLine(fmt.boldYellow('Next steps:'));
  steps.forEach((step, idx) => {
    writeLine(`  ${fmt.dim(`${idx + 1}.`)} ${step}`);
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
  const fmt = createFormatter(output);
  const resolvedDir = path.resolve(targetDir);
  await fs.mkdir(resolvedDir, { recursive: true });

  const { version, codepenCommanderRange } = await readFrameworkMeta();
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
      'cdpn:new': 'codepen-demokit cdpn new',
      cdpn: 'cdpn',
    },
    engines: {
      node: '>=20',
    },
    devDependencies: {
      'codepen-commander': codepenCommanderRange,
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
  writeLine(
    `${fmt.boldGreen('✓')} ${fmt.bold('Initialized')} ${fmt.boldCyan('codepen-demokit')} ${fmt.bold('project in')} ${fmt.magenta(resolvedDir)}`,
  );
  writeLine();
  for (const item of results) {
    if (item.status === 'created') {
      writeLine(`  ${fmt.boldGreen('+')} ${fmt.green('[CREATED]')} ${item.path}`);
    } else {
      writeLine(`  ${fmt.yellow('-')} ${fmt.dim('[SKIPPED]')} ${fmt.dim(item.path)}`);
    }
  }

  if (showNextSteps) {
    printNextSteps({ output, cwd, targetDir: resolvedDir, codepenUser, needsAuthLogin, fmt });
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
  const fmt = createFormatter(output);
  const prompter = createPrompter({ input, output, fmt });

  try {
    const options = await promptInitOptions({ cwd, output, prompter, fmt });
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
          `\n${fmt.boldGreen('✓')} CodePen authentication for ${fmt.boldCyan(options.codepenUser)} is already set up.\n`,
        );
        needsAuthLogin = false;
      } else if (status === 'missing' && cdpnBin) {
        output.write(
          `\n${fmt.boldYellow('!')} It looks like you haven't authenticated with CodePen as ${fmt.boldCyan(options.codepenUser)} yet.\n\n`,
        );
        let shouldLogin = false;
        try {
          shouldLogin = await promptYesNo(
            prompter,
            'Would you like to set up CodePen authentication now?',
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
      fmt,
    });

    return {
      ...scaffoldResult,
      authConfigured: Boolean(options.codepenUser) && !needsAuthLogin,
    };
  } finally {
    prompter.close();
  }
}
