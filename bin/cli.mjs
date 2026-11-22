#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { InitCancelledError, PACKAGE_DIR, initProject } from '../lib/init.mjs';

const LEGACY_RUNTIME_COMMANDS = new Set(['start', 'dev', 'build', 'cdpn']);

async function getVersion() {
  const pkgPath = path.join(PACKAGE_DIR, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  return pkg.version || '0.0.0';
}

function printHelp() {
  console.log(`Usage: codepen-demokit [init] [options]

Interactive starter pack for creating a self-contained web demos repository
powered by CodePen Commander (cdpn).

Commands:
  init            Interactively scaffold a new demos repository (default)

Options:
  -h, --help      Show this help message
  -v, --version   Show version number`);
}

function parseInitArgs(argv) {
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option '${arg}'.`);
    } else {
      throw new Error(
        `Unexpected argument '${arg}'. Run 'codepen-demokit' without arguments; it will prompt for the project name and directory.`,
      );
    }
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === '-h' || command === '--help' || command === 'help') {
  printHelp();
  process.exit(0);
}

if (command === '-v' || command === '--version') {
  console.log(await getVersion());
  process.exit(0);
}

try {
  if (!command) {
    await initProject({ cwd: process.cwd() });
  } else if (command === 'init') {
    parseInitArgs(rest);
    await initProject({ cwd: process.cwd() });
  } else if (LEGACY_RUNTIME_COMMANDS.has(command)) {
    console.error(
      `Error: '${command}' is no longer provided by codepen-demokit.\n` +
        `codepen-demokit is now a starter pack; serving, static builds, shells, and batch CodePen sync are handled directly by codepen-commander (cdpn).\n` +
        `Use \`npx cdpn serve\`, \`npx cdpn build\`, \`npx cdpn sync all\`, etc. (run \`npx cdpn --help\` for details).`,
    );
    process.exit(1);
  } else {
    console.error(`Error: Unknown command '${command}'.\n`);
    printHelp();
    process.exit(1);
  }
} catch (error) {
  if (error instanceof InitCancelledError) {
    console.error('\nInit cancelled.');
    process.exit(130);
  }
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
