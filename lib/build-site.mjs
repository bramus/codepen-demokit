import fs from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PEN_HTML_SUFFIX,
  applyPackagesBlock,
  compileClassicPenHtml,
  readPenBlocks,
  renderUnsupportedBlocksPage,
} from './blocks.mjs';
import { buildDemosJson } from './build-json.mjs';
import { CONFIG_FILENAME, loadSiteConfig, renderShellIndexHtml } from './config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PACKAGE_DIR = path.resolve(__dirname, '..');
export const SHELL_DIR = path.join(PACKAGE_DIR, 'shell');

const SHELL_FILES = ['index.html', 'styles.css', 'scripts.js'];

function isWithinRoot(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

async function copySrcTree(
  currentSrcDir,
  currentDestDir,
  srcRealpath,
  isRootLevel,
  inheritedPenContext = null,
) {
  const localPenContext = await readPenBlocks(currentSrcDir, srcRealpath);
  const penContext = localPenContext ?? inheritedPenContext;

  if (localPenContext && localPenContext.unsupportedBlocks.length > 0) {
    const relFromSrc = path.relative(srcRealpath, currentSrcDir);
    const relSegments = relFromSrc ? relFromSrc.split(path.sep).filter(Boolean) : [];
    const homeHref = relSegments.length > 0 ? '../'.repeat(relSegments.length) : null;
    const demoRelPath =
      relSegments.length > 0 ? `${relSegments.join('/')}/` : `${path.basename(currentSrcDir)}/`;
    const { html } = await renderUnsupportedBlocksPage({
      penContext: localPenContext,
      rootRealpath: srcRealpath,
      demoRelPath,
      homeHref,
    });
    await fs.writeFile(path.join(currentDestDir, 'index.html'), html, 'utf8');
    return;
  }

  const entries = await fs.readdir(currentSrcDir, { withFileTypes: true });
  const existingNamesLower = new Set(entries.map((entry) => entry.name.toLowerCase()));

  for (const entry of entries) {
    // Skip dotfiles/dotdirs (.cdpn.json, .cdpnignore, .codepen, .DS_Store, .gitkeep, etc.) and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    // Skip any stale top-level src/demos.json — dist/demos.json is generated freshly
    if (isRootLevel && entry.name === 'demos.json') continue;

    const srcPath = path.join(currentSrcDir, entry.name);
    const destPath = path.join(currentDestDir, entry.name);

    let lstat;
    try {
      lstat = await fs.lstat(srcPath);
    } catch {
      continue;
    }

    if (lstat.isSymbolicLink()) continue;

    const realSrcPath = await fs.realpath(srcPath);
    if (!isWithinRoot(realSrcPath, srcRealpath)) continue;

    if (lstat.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copySrcTree(realSrcPath, destPath, srcRealpath, false, penContext);
    } else if (lstat.isFile()) {
      const lowerName = entry.name.toLowerCase();

      if (penContext?.hasClassic && lowerName.endsWith(PEN_HTML_SUFFIX)) {
        const outName = `${entry.name.slice(0, -PEN_HTML_SUFFIX.length)}.html`;
        if (!existingNamesLower.has(outName.toLowerCase())) {
          const compiledHtml = await compileClassicPenHtml({
            penHtmlPath: realSrcPath,
            penContext,
            rootRealpath: srcRealpath,
          });
          if (compiledHtml !== null) {
            await fs.writeFile(path.join(currentDestDir, outName), compiledHtml, 'utf8');
          }
        }
        continue;
      }

      if (
        penContext?.hasPackages &&
        lowerName.endsWith('.html') &&
        !lowerName.endsWith(PEN_HTML_SUFFIX)
      ) {
        const rawHtml = await fs.readFile(realSrcPath, 'utf8');
        const transformedHtml = await applyPackagesBlock({
          html: rawHtml,
          penContext,
          rootRealpath: srcRealpath,
        });
        await fs.writeFile(destPath, transformedHtml, 'utf8');
        continue;
      }

      await fs.copyFile(realSrcPath, destPath);
    }
  }
}

/**
 * Builds a complete, static deployable site into `<projectDir>/dist/`:
 * - Copies all non-hidden demos and assets from `<projectDir>/src/`
 * - Layers framework `shell/` files (`index.html`, `styles.css`, `scripts.js`) unless overridden in `src/`
 * - Injects `site` metadata from `config.json` into the default `shell/index.html`
 * - Generates `<projectDir>/dist/demos.json`
 */
export async function buildSite({
  projectDir = process.cwd(),
  outDir = path.resolve(projectDir, 'dist'),
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const srcDir = path.resolve(resolvedProjectDir, 'src');
  const distDir = path.resolve(outDir);

  if (!distDir.startsWith(resolvedProjectDir + path.sep)) {
    throw new Error(`Refusing to build outside project directory: ${distDir}`);
  }

  let srcRealpath;
  try {
    const stat = await fs.stat(srcDir);
    if (!stat.isDirectory()) {
      throw new Error(`"src" in ${resolvedProjectDir} is not a directory.`);
    }
    srcRealpath = await fs.realpath(srcDir);
  } catch (error) {
    throw new Error(`Directory "src/" not found in ${resolvedProjectDir}.`, { cause: error });
  }

  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  // 1. Copy user demos and any user-provided index overrides from src/
  await copySrcTree(srcRealpath, distDir, srcRealpath, true);

  // 2. Layer framework shell files wherever the user has not overridden them in src/
  const siteConfig = loadSiteConfig(resolvedProjectDir);
  for (const filename of SHELL_FILES) {
    const destPath = path.join(distDir, filename);
    if (existsSync(destPath)) continue;

    const shellPath = path.join(SHELL_DIR, filename);
    if (filename === 'index.html') {
      const templateHtml = await fs.readFile(shellPath, 'utf8');
      const renderedHtml = renderShellIndexHtml(templateHtml, siteConfig);
      await fs.writeFile(destPath, renderedHtml, 'utf8');
    } else {
      await fs.copyFile(shellPath, destPath);
    }
  }

  // 3. Generate static dist/demos.json
  const { demoCount, manifest } = await buildDemosJson({
    projectDir: resolvedProjectDir,
    outputFile: path.join(distDir, 'demos.json'),
  });

  return { distDir, demoCount, manifest };
}

export function watchSite({
  projectDir = process.cwd(),
  outDir = path.resolve(projectDir, 'dist'),
  debounceMs = 200,
  onRebuild,
  onError,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const srcDir = path.resolve(resolvedProjectDir, 'src');
  let timer = null;
  let isBuilding = false;
  let pendingRebuild = false;
  let closed = false;

  async function runBuild() {
    if (closed) return;
    if (isBuilding) {
      pendingRebuild = true;
      return;
    }

    isBuilding = true;
    try {
      const result = await buildSite({ projectDir: resolvedProjectDir, outDir });
      onRebuild?.(result);
    } catch (error) {
      onError?.(error);
    } finally {
      isBuilding = false;
      if (pendingRebuild && !closed) {
        pendingRebuild = false;
        scheduleBuild();
      }
    }
  }

  function scheduleBuild() {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runBuild();
    }, debounceMs);
  }

  const watchers = [];

  const srcWatcher = watch(srcDir, { recursive: true }, (_eventType, filename) => {
    if (typeof filename === 'string') {
      const normalized = filename.split(path.sep).join('/');
      const segments = normalized.split('/');
      if (segments.at(-1) === '.DS_Store') return;
      if (segments.includes('node_modules') || segments.includes('.git')) return;
    }
    scheduleBuild();
  });
  srcWatcher.on('error', (error) => onError?.(error));
  watchers.push(srcWatcher);

  // Also watch project root (non-recursively) for config.json updates
  const rootWatcher = watch(resolvedProjectDir, (_eventType, filename) => {
    if (filename === CONFIG_FILENAME) {
      scheduleBuild();
    }
  });
  rootWatcher.on('error', (error) => onError?.(error));
  watchers.push(rootWatcher);

  return {
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}
