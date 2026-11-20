import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';

const MAX_SCAN_DEPTH = 4;
const MAX_HTML_HEAD_BYTES = 16 * 1024;
const MAX_CDPN_JSON_BYTES = 64 * 1024;

const ACRONYMS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['apis', 'APIs'],
  ['aria', 'ARIA'],
  ['cls', 'CLS'],
  ['css', 'CSS'],
  ['cwv', 'CWV'],
  ['dom', 'DOM'],
  ['html', 'HTML'],
  ['http', 'HTTP'],
  ['inp', 'INP'],
  ['js', 'JS'],
  ['json', 'JSON'],
  ['lcp', 'LCP'],
  ['mcp', 'MCP'],
  ['pwa', 'PWA'],
  ['svg', 'SVG'],
  ['ui', 'UI'],
  ['url', 'URL'],
  ['ux', 'UX'],
  ['wasm', 'WASM'],
  ['webgl', 'WebGL'],
  ['webgpu', 'WebGPU'],
  ['webmcp', 'WebMCP'],
]);

const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

const NAMED_HTML_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['mdash', '—'],
  ['nbsp', ' '],
  ['ndash', '–'],
  ['quot', '"'],
]);

const utf8Decoder = new TextDecoder('utf-8');

function isWithinRoot(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

function compareNatural(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function formatFolderTitle(folderName) {
  const words = folderName.split(/[-_]+/).filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) {
        return ACRONYMS.get(lower);
      }
      if (index > 0 && index < words.length - 1 && MINOR_WORDS.has(lower)) {
        return lower;
      }
      return word[0].toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function decodeHtmlEntities(input) {
  return input.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z]{2,10}));/g, (match, dec, hex, named) => {
    if (dec || hex) {
      const codePoint = Number.parseInt(dec ?? hex, dec ? 10 : 16);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    return NAMED_HTML_ENTITIES.get(named.toLowerCase()) ?? match;
  });
}

function normalizeText(value, maxLength) {
  const cleaned = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function extractTitle(headHtml) {
  const match = /<title\b[^>]{0,200}>([\s\S]{0,500}?)<\/title>/i.exec(headHtml);
  return match ? normalizeText(match[1], 160) : null;
}

function extractMetaDescription(headHtml) {
  const metaTagPattern = /<meta\b[^>]{1,1000}>/gi;
  const attrPattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  for (const tagMatch of headHtml.matchAll(metaTagPattern)) {
    let metaName = null;
    let metaContent = null;

    for (const attrMatch of tagMatch[0].matchAll(attrPattern)) {
      const key = attrMatch[1].toLowerCase();
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      if (key === 'name') {
        metaName = value.trim().toLowerCase();
      } else if (key === 'content') {
        metaContent = value;
      }
    }

    if (metaName === 'description' && metaContent !== null) {
      return normalizeText(metaContent, 320);
    }
  }

  return null;
}

function sanitizeCodePenUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'codepen.io' && !parsed.hostname.endsWith('.codepen.io')) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

async function readPartialUtf8(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return utf8Decoder.decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function resolveSafeRealFile(candidatePath, srcDir, srcRealpath) {
  if (!isWithinRoot(candidatePath, srcDir)) return null;
  let stat;
  try {
    stat = await fs.stat(candidatePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinRoot(realPath, srcRealpath)) return null;
    return { realPath, size: stat.size };
  } catch {
    return null;
  }
}

async function resolveSafeRealDir(candidatePath, srcDir, srcRealpath) {
  if (!isWithinRoot(candidatePath, srcDir)) return null;
  let stat;
  try {
    stat = await fs.stat(candidatePath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinRoot(realPath, srcRealpath)) return null;
    return realPath;
  } catch {
    return null;
  }
}

async function readDemoEntry(segments, srcDir, srcRealpath) {
  const demoDir = path.resolve(srcDir, ...segments);
  const indexFile = await resolveSafeRealFile(path.join(demoDir, 'index.html'), srcDir, srcRealpath);
  if (!indexFile) return null;

  let title = null;
  let description = null;
  try {
    const headHtml = await readPartialUtf8(indexFile.realPath, MAX_HTML_HEAD_BYTES);
    title = extractTitle(headHtml);
    description = extractMetaDescription(headHtml);
  } catch {
    // Fall back to folder name when HTML metadata cannot be read
  }

  let codepenUrl = null;
  const cdpnFile = await resolveSafeRealFile(path.join(demoDir, '.cdpn.json'), srcDir, srcRealpath);
  if (cdpnFile && cdpnFile.size <= MAX_CDPN_JSON_BYTES) {
    try {
      const rawJson = await fs.readFile(cdpnFile.realPath, 'utf8');
      const parsed = JSON.parse(rawJson);
      codepenUrl = sanitizeCodePenUrl(parsed?.url);
    } catch {
      codepenUrl = null;
    }
  }

  return {
    title: title ?? formatFolderTitle(segments.at(-1)),
    description,
    path: `${segments.join('/')}/`,
    href: `./${segments.map(encodeURIComponent).join('/')}/`,
    codepenUrl,
  };
}

async function scanGroupNode(dirRealpath, segments, depth, visitedRealpaths, srcDir, srcRealpath) {
  if (depth > MAX_SCAN_DEPTH) return { demos: [], groups: [] };

  let entries;
  try {
    entries = await fs.readdir(dirRealpath, { withFileTypes: true });
  } catch {
    return { demos: [], groups: [] };
  }

  const demos = [];
  const groups = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const childSegments = [...segments, entry.name];
    const childCandidate = path.resolve(srcDir, ...childSegments);
    const childRealDir = await resolveSafeRealDir(childCandidate, srcDir, srcRealpath);
    if (!childRealDir || visitedRealpaths.has(childRealDir)) continue;

    visitedRealpaths.add(childRealDir);

    const demoEntry = await readDemoEntry(childSegments, srcDir, srcRealpath);
    if (demoEntry) {
      demos.push(demoEntry);
      continue;
    }

    const subNode = await scanGroupNode(childRealDir, childSegments, depth + 1, visitedRealpaths, srcDir, srcRealpath);
    if (subNode.demos.length > 0 || subNode.groups.length > 0) {
      groups.push({
        id: childSegments.join('/'),
        title: formatFolderTitle(entry.name),
        demos: subNode.demos,
        groups: subNode.groups,
      });
    }
  }

  return {
    demos: demos.toSorted((a, b) => compareNatural(a.path, b.path)),
    groups: groups.toSorted((a, b) => compareNatural(a.id, b.id)),
  };
}

export async function scanDemos(projectDir = process.cwd()) {
  const srcDir = path.resolve(projectDir, 'src');
  let srcRealpath;
  try {
    srcRealpath = await fs.realpath(srcDir);
  } catch {
    throw new Error(`Directory "src/" not found in ${path.resolve(projectDir)}.`);
  }

  const visitedRealpaths = new Set([srcRealpath]);
  const root = await scanGroupNode(srcRealpath, [], 0, visitedRealpaths, srcDir, srcRealpath);
  return {
    groups: root.groups,
    standalone: root.demos,
  };
}

function countGroupDemos(groups) {
  return groups.reduce(
    (total, group) => total + group.demos.length + countGroupDemos(group.groups ?? []),
    0,
  );
}

export function countDemos(manifest) {
  return (manifest.standalone?.length ?? 0) + countGroupDemos(manifest.groups ?? []);
}

export async function buildDemosJson({
  projectDir = process.cwd(),
  outputFile = path.resolve(projectDir, 'dist', 'demos.json'),
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedOutputFile = path.resolve(outputFile);
  if (!isWithinRoot(resolvedOutputFile, resolvedProjectDir)) {
    throw new Error(`Refusing to write demos.json outside project directory: ${resolvedOutputFile}`);
  }

  const manifest = await scanDemos(resolvedProjectDir);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const demoCount = countDemos(manifest);

  let existing = null;
  try {
    existing = await fs.readFile(resolvedOutputFile, 'utf8');
  } catch {
    existing = null;
  }

  if (existing === serialized) {
    return { changed: false, demoCount, manifest, outputFile: resolvedOutputFile };
  }

  const outputDir = path.dirname(resolvedOutputFile);
  await fs.mkdir(outputDir, { recursive: true });

  const tempOutputFile = path.join(
    outputDir,
    `.demos.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(tempOutputFile, serialized, 'utf8');
    await fs.rename(tempOutputFile, resolvedOutputFile);
  } catch (error) {
    await fs.rm(tempOutputFile, { force: true }).catch(() => {});
    throw error;
  }

  return { changed: true, demoCount, manifest, outputFile: resolvedOutputFile };
}

function shouldIgnoreWatchEvent(rawFilename) {
  if (typeof rawFilename !== 'string' || !rawFilename) return false;
  const normalized = rawFilename.split(path.sep).join('/');
  if (
    normalized === 'demos.json' ||
    (normalized.startsWith('.demos.json.') && normalized.endsWith('.tmp'))
  ) {
    return true;
  }
  const segments = normalized.split('/');
  const base = segments.at(-1);
  if (base === '.DS_Store') return true;
  if (segments.includes('node_modules') || segments.includes('.git')) return true;
  return false;
}

export function watchDemos({
  projectDir = process.cwd(),
  outputFile = path.resolve(projectDir, 'dist', 'demos.json'),
  debounceMs = 150,
  onRebuild,
  onError,
} = {}) {
  const srcDir = path.resolve(projectDir, 'src');
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
      const result = await buildDemosJson({ projectDir, outputFile });
      if (result.changed) {
        onRebuild?.(result);
      }
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

  const watcher = watch(srcDir, { recursive: true }, (_eventType, filename) => {
    if (shouldIgnoreWatchEvent(filename)) return;
    scheduleBuild();
  });

  watcher.on('error', (error) => {
    onError?.(error);
  });

  return {
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher.close();
    },
  };
}
