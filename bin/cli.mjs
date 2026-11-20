#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_DIR, buildSite, watchSite } from '../lib/build-site.mjs';
import { initProject } from '../lib/init.mjs';
import { startServer } from '../lib/serve.mjs';
import { runCodePenSync } from '../lib/sync-codepen.mjs';

async function getVersion() {
  const pkgPath = path.join(PACKAGE_DIR, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  return pkg.version || '0.0.0';
}

function printHelp() {
  console.log(`Usage: codepen-demokit <command> [options]

Commands:
  init [dir]                                      Scaffold a new demos repository
  start [folder-in-src] [--port <port>]           Build demos.json, watch src/, and start local dev server
  dev [folder-in-src] [--port <port>]             Alias for start
  build [--watch]                                 Build static deployable site into dist/
  cdpn <sync|pull|push|delete> [folder] [flags]   Bulk sync demos with CodePen via CodePen Commander

Options:
  -h, --help      Show this help message
  -v, --version   Show version number`);
}

function parseStartArgs(argv) {
  let targetFolder = null;
  let port = process.env.PORT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log('Usage: codepen-demokit start [folder-in-src] [--port <port>]');
      process.exit(0);
    } else if (arg === '--port' || arg === '-p') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --port.');
      }
      port = next;
      i++;
    } else if (arg.startsWith('--port=')) {
      port = arg.slice('--port='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option '${arg}'.`);
    } else {
      if (targetFolder !== null) {
        throw new Error(`Multiple target folders specified ('${targetFolder}' and '${arg}').`);
      }
      targetFolder = arg;
    }
  }

  return { targetFolder, port };
}

function parseBuildArgs(argv) {
  let watchMode = false;

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log('Usage: codepen-demokit build [--watch]');
      process.exit(0);
    } else if (arg === '--watch' || arg === '-w') {
      watchMode = true;
    } else {
      throw new Error(`Unknown option '${arg}'.`);
    }
  }

  return { watchMode };
}

function parseInitArgs(argv) {
  let targetDir = process.cwd();
  let gotDir = false;

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log('Usage: codepen-demokit init [dir]');
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option '${arg}'.`);
    } else {
      if (gotDir) {
        throw new Error(`Unexpected argument '${arg}'.`);
      }
      targetDir = path.resolve(process.cwd(), arg);
      gotDir = true;
    }
  }

  return { targetDir };
}

const [command, ...rest] = process.argv.slice(2);

if (!command || command === '-h' || command === '--help') {
  printHelp();
  process.exit(0);
}

if (command === '-v' || command === '--version') {
  console.log(await getVersion());
  process.exit(0);
}

try {
  if (command === 'init') {
    const { targetDir } = parseInitArgs(rest);
    await initProject({ targetDir });
  } else if (command === 'start' || command === 'dev') {
    const { targetFolder, port } = parseStartArgs(rest);
    await startServer({ projectDir: process.cwd(), targetFolder, port });
  } else if (command === 'build') {
    const { watchMode } = parseBuildArgs(rest);
    const { demoCount } = await buildSite({ projectDir: process.cwd() });
    console.log(`Built dist/ (${demoCount} ${demoCount === 1 ? 'demo' : 'demos'})`);

    if (watchMode) {
      console.log('Watching src/ and config.json for changes…');
      const handle = watchSite({
        projectDir: process.cwd(),
        onRebuild({ demoCount: updatedCount }) {
          console.log(`Rebuilt dist/ (${updatedCount} ${updatedCount === 1 ? 'demo' : 'demos'})`);
        },
        onError(error) {
          console.error(`Error rebuilding dist/: ${error.message}`);
        },
      });

      const shutdown = () => {
        handle.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }
  } else if (command === 'cdpn') {
    runCodePenSync(rest, { projectDir: process.cwd() });
  } else {
    console.error(`Error: Unknown command '${command}'.\n`);
    printHelp();
    process.exit(1);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
