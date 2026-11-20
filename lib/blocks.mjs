import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml } from './config.mjs';

export const PEN_HTML_SUFFIX = '.pen.html';

const CODEPEN_DIR = '.codepen';
const PEN_CONFIG_FILENAME = 'pen.config.json';
const CLASSIC_CONFIG_FILENAME = 'classic.config.json';
const CDPN_JSON_FILENAME = '.cdpn.json';
const PACKAGE_JSON_FILENAME = 'package.json';

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_SCRIPT_SNIFF_BYTES = 64 * 1024;
const MAX_WALK_DEPTH = 16;

const ESM_SH_ORIGIN = 'https://esm.sh';
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const NPM_PACKAGE_NAME_PATTERN =
  /^(?:@[a-zA-Z0-9~][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9~][a-zA-Z0-9._~-]*$/;
const SAFE_VERSION_PATTERN = /^[a-zA-Z0-9._^~*+-][a-zA-Z0-9._^~*+<>=| -]*$/;
const ALLOWED_SCRIPT_TYPES = new Set(['module', 'text/javascript']);
const SUPPORTED_BLOCK_TYPES = new Set(['validate', 'fingerprint', 'classic', 'packages']);

const utf8Decoder = new TextDecoder('utf-8');

function isWithinRoot(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function resolveSafeFile(candidatePath, rootRealpath) {
  const resolved = path.resolve(candidatePath);
  if (!isWithinRoot(resolved, rootRealpath)) return null;

  let lstat;
  try {
    lstat = await fs.lstat(resolved);
  } catch {
    return null;
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) return null;

  try {
    const realPath = await fs.realpath(resolved);
    if (!isWithinRoot(realPath, rootRealpath)) return null;
    return { realPath, size: lstat.size };
  } catch {
    return null;
  }
}

async function readSafeJsonObject(filePath, rootRealpath, maxBytes = MAX_CONFIG_BYTES) {
  const file = await resolveSafeFile(filePath, rootRealpath);
  if (!file || file.size > maxBytes) return null;

  try {
    const raw = await fs.readFile(file.realPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
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

function normalizeBlockType(rawName) {
  return String(rawName).trim().toLowerCase().replace(/-\d+$/, '');
}

/**
 * Inspects `<penDir>/.codepen/pen.config.json` and detects enabled supported blocks
 * (`classic`, `packages`; `validate` and `fingerprint` are default no-ops) as well as
 * any active unsupported blocks.
 */
export async function readPenBlocks(penDir, rootRealpath) {
  const configPath = path.join(penDir, CODEPEN_DIR, PEN_CONFIG_FILENAME);
  const parsed = await readSafeJsonObject(configPath, rootRealpath);
  if (!parsed || !isPlainObject(parsed.blocks)) return null;

  const activeBlocks = new Set();
  const unsupportedMap = new Map();

  for (const [key, block] of Object.entries(parsed.blocks)) {
    if (!isPlainObject(block)) continue;
    if (block.disabled === true) continue;

    const rawName =
      typeof block.name === 'string' && block.name.trim() ? block.name.trim() : key;
    const cleanedName = String(rawName).replace(/[\x00-\x1f\x7f]+/g, '').trim().slice(0, 128);
    const blockType = normalizeBlockType(cleanedName);
    if (!blockType) continue;

    activeBlocks.add(blockType);
    if (!SUPPORTED_BLOCK_TYPES.has(blockType) && !unsupportedMap.has(blockType)) {
      unsupportedMap.set(blockType, cleanedName);
    }
  }

  const unsupportedBlocks = [...unsupportedMap.values()].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }),
  );

  return {
    penDir,
    hasClassic: activeBlocks.has('classic'),
    hasPackages: activeBlocks.has('packages'),
    unsupportedBlocks,
  };
}

/**
 * Walks upward from `targetDir` to `rootRealpath` (inclusive) to find the nearest
 * enclosing Pen directory containing `.codepen/pen.config.json`.
 */
export async function findPenContext(targetDir, rootRealpath) {
  let currentDir = path.resolve(targetDir);
  if (!isWithinRoot(currentDir, rootRealpath)) return null;

  for (let depth = 0; depth <= MAX_WALK_DEPTH; depth++) {
    const blocks = await readPenBlocks(currentDir, rootRealpath);
    if (blocks) return blocks;

    if (currentDir === rootRealpath) break;
    const parent = path.dirname(currentDir);
    if (parent === currentDir || !isWithinRoot(parent, rootRealpath)) break;
    currentDir = parent;
  }

  return null;
}

/**
 * Reads the optional `head` HTML string from `<penDir>/.codepen/classic.config.json`.
 */
export async function readClassicHeadMetadata(penDir, rootRealpath) {
  const classicConfigPath = path.join(penDir, CODEPEN_DIR, CLASSIC_CONFIG_FILENAME);
  const classicConfig = await readSafeJsonObject(classicConfigPath, rootRealpath);
  if (!classicConfig || typeof classicConfig.head !== 'string') return null;
  const trimmed = classicConfig.head.trim();
  return trimmed || null;
}

function resolveClassicAssetUrl(rawUrl, htmlRelDirPosix) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;

  // Allow external HTTP(S) and protocol-relative URLs untouched
  if (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('//')
  ) {
    return { href: trimmed, localPenRelPosix: null };
  }

  // Reject any other explicit URL scheme (e.g. javascript:, data:, vbscript:, file:)
  if (URL_SCHEME_PATTERN.test(trimmed)) {
    return null;
  }

  const splitMatch = /^([^?#]*)(.*)$/.exec(trimmed);
  const rawPath = splitMatch ? splitMatch[1] : trimmed;
  const suffix = splitMatch ? splitMatch[2] : '';

  // Pen-root-relative path (e.g. "/style.css", "/script.js"): rewrite relative to the HTML file
  // so the demo works both at "/<group>/<demo>/" and when served directly as "/".
  if (rawPath.startsWith('/')) {
    const stripped = rawPath.replace(/^\/+/, '');
    if (!stripped) return null;
    const normalizedTarget = path.posix.normalize(stripped);
    if (
      !normalizedTarget ||
      normalizedTarget === '.' ||
      normalizedTarget === '..' ||
      normalizedTarget.startsWith('../')
    ) {
      return null;
    }

    let relativeHref = path.posix.relative(htmlRelDirPosix, normalizedTarget);
    if (!relativeHref) return null;
    if (!relativeHref.startsWith('./') && !relativeHref.startsWith('../')) {
      relativeHref = `./${relativeHref}`;
    }
    return { href: `${relativeHref}${suffix}`, localPenRelPosix: normalizedTarget };
  }

  // Already a relative path (e.g. "./style.css", "script.js")
  const normalizedTarget = path.posix.normalize(
    htmlRelDirPosix ? path.posix.join(htmlRelDirPosix, rawPath) : rawPath,
  );
  const localPenRelPosix =
    normalizedTarget &&
    normalizedTarget !== '.' &&
    normalizedTarget !== '..' &&
    !normalizedTarget.startsWith('../')
      ? normalizedTarget
      : null;

  return { href: trimmed, localPenRelPosix };
}

function looksLikeEsModule(source) {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (
      line.startsWith('import ') ||
      line.startsWith('import{') ||
      line.startsWith('import*') ||
      line.startsWith("import'") ||
      line.startsWith('import"') ||
      line.startsWith('export ') ||
      line.startsWith('export{') ||
      line.startsWith('export*')
    ) {
      return true;
    }
  }
  return false;
}

async function localScriptUsesEsm(localPenRelPosix, penDir, rootRealpath) {
  if (!localPenRelPosix) return false;
  const segments = localPenRelPosix.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg.startsWith('.')) return false;
  }

  const candidatePath = path.resolve(penDir, ...segments);
  if (!isWithinRoot(candidatePath, penDir)) return false;

  const file = await resolveSafeFile(candidatePath, rootRealpath);
  if (!file) return false;

  try {
    const snippet = await readPartialUtf8(file.realPath, MAX_SCRIPT_SNIFF_BYTES);
    return looksLikeEsModule(snippet);
  } catch {
    return false;
  }
}

function normalizeHtmlClasses(rawClasses) {
  if (typeof rawClasses === 'string') {
    return rawClasses.trim();
  }
  if (Array.isArray(rawClasses)) {
    return rawClasses
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
      .join(' ');
  }
  return '';
}

/**
 * Compiles a `.pen.html` body fragment into a complete HTML document using
 * `.codepen/classic.config.json` and `.cdpn.json` title metadata. If the Pen also
 * enables the `packages` block, the importmap transform is applied afterward.
 */
export async function compileClassicPenHtml({ penHtmlPath, penContext, rootRealpath }) {
  const penHtmlFile = await resolveSafeFile(penHtmlPath, rootRealpath);
  if (!penHtmlFile || penHtmlFile.size > MAX_HTML_BYTES) return null;

  let bodyHtml;
  try {
    bodyHtml = await fs.readFile(penHtmlFile.realPath, 'utf8');
  } catch {
    return null;
  }

  const classicConfig =
    (await readSafeJsonObject(
      path.join(penContext.penDir, CODEPEN_DIR, CLASSIC_CONFIG_FILENAME),
      rootRealpath,
    )) ?? {};
  const cdpnConfig =
    (await readSafeJsonObject(
      path.join(penContext.penDir, CDPN_JSON_FILENAME),
      rootRealpath,
    )) ?? {};

  const title =
    typeof cdpnConfig?.info?.title === 'string' && cdpnConfig.info.title.trim()
      ? cdpnConfig.info.title.trim()
      : path.basename(penContext.penDir) || 'Pen';

  const htmlClasses = normalizeHtmlClasses(classicConfig.htmlClasses);
  // TODO(security): `classicConfig.head` and `bodyHtml` are raw HTML authored by the
  // demo developer in local `src/` (same trust boundary as `src/*/index.html`), so they
  // are intentionally embedded unescaped while `title`, `htmlClasses`, and asset URLs
  // are validated and HTML-escaped.
  const headHtml = typeof classicConfig.head === 'string' ? classicConfig.head.trim() : '';

  const relFromPen = path.relative(penContext.penDir, path.dirname(penHtmlFile.realPath));
  const htmlRelDirPosix = relFromPen ? relFromPen.split(path.sep).join('/') : '';

  const styleTags = [];
  if (Array.isArray(classicConfig.styles)) {
    for (const entry of classicConfig.styles) {
      const rawHref =
        typeof entry === 'string'
          ? entry
          : isPlainObject(entry)
            ? (entry.href ?? entry.url ?? entry.src)
            : null;
      const resolved = resolveClassicAssetUrl(rawHref, htmlRelDirPosix);
      if (!resolved) continue;
      styleTags.push(`<link rel="stylesheet" href="${escapeHtml(resolved.href)}">`);
    }
  }

  const scriptTags = [];
  if (Array.isArray(classicConfig.scripts)) {
    for (const entry of classicConfig.scripts) {
      const rawSrc =
        typeof entry === 'string'
          ? entry
          : isPlainObject(entry)
            ? (entry.src ?? entry.url)
            : null;
      const explicitType =
        isPlainObject(entry) && typeof entry.type === 'string'
          ? entry.type.trim().toLowerCase()
          : null;

      const resolved = resolveClassicAssetUrl(rawSrc, htmlRelDirPosix);
      if (!resolved) continue;

      let scriptType =
        explicitType && ALLOWED_SCRIPT_TYPES.has(explicitType) ? explicitType : null;
      const pathWithoutQuery = resolved.href.split(/[?#]/, 1)[0].toLowerCase();
      if (!scriptType && pathWithoutQuery.endsWith('.mjs')) {
        scriptType = 'module';
      }
      if (!scriptType && penContext.hasPackages && resolved.localPenRelPosix) {
        if (await localScriptUsesEsm(resolved.localPenRelPosix, penContext.penDir, rootRealpath)) {
          scriptType = 'module';
        }
      }

      const typeAttr = scriptType ? ` type="${escapeHtml(scriptType)}"` : '';
      scriptTags.push(`<script${typeAttr} src="${escapeHtml(resolved.href)}"></script>`);
    }
  }

  const htmlOpenTag = htmlClasses
    ? `<html lang="en" class="${escapeHtml(htmlClasses)}">`
    : '<html lang="en">';

  const headLines = [
    '    <meta charset="UTF-8">',
    `    <title>${escapeHtml(title)}</title>`,
  ];
  if (headHtml) {
    headLines.push(`    ${headHtml}`);
  }
  for (const tag of styleTags) {
    headLines.push(`    ${tag}`);
  }

  const trimmedBody = bodyHtml.replace(/\r?\n$/, '');
  const bodyLines = [];
  if (trimmedBody) {
    bodyLines.push(`    ${trimmedBody}`);
  }
  for (const tag of scriptTags) {
    bodyLines.push(`    ${tag}`);
  }

  let html = [
    '<!DOCTYPE html>',
    htmlOpenTag,
    '',
    '  <head>',
    ...headLines,
    '  </head>',
    '',
    '  <body>',
    ...bodyLines,
    '  </body>',
    '',
    '</html>',
    '',
  ].join('\n');

  if (penContext.hasPackages) {
    html = await applyPackagesBlock({ html, penContext, rootRealpath });
  }

  return html;
}

function buildEsmShImports(dependencies) {
  const imports = {};
  if (!isPlainObject(dependencies)) return imports;

  for (const [rawName, rawVersion] of Object.entries(dependencies)) {
    if (typeof rawName !== 'string' || typeof rawVersion !== 'string') continue;
    const name = rawName.trim();
    const version = rawVersion.trim();
    if (!name || !version) continue;
    if (!NPM_PACKAGE_NAME_PATTERN.test(name) || name.includes('..')) continue;
    if (!SAFE_VERSION_PATTERN.test(version) || version.includes('..')) continue;

    const encodedVersion = version.replace(/ /g, '%20');
    const baseUrlStr = `${ESM_SH_ORIGIN}/${name}@${encodedVersion}`;
    let parsedUrl;
    try {
      parsedUrl = new URL(baseUrlStr);
    } catch {
      continue;
    }
    if (
      parsedUrl.origin !== ESM_SH_ORIGIN ||
      parsedUrl.search ||
      parsedUrl.hash ||
      parsedUrl.pathname.includes('..')
    ) {
      continue;
    }

    imports[name] = baseUrlStr;
    imports[`${name}/`] = `${baseUrlStr}/`;
  }

  return imports;
}

function serializeImportMap(mapObj) {
  // Escape `<` as `\u003c` so serialized JSON can never break out of `<script>`.
  return JSON.stringify(mapObj, null, 2).replace(/</g, '\\u003c');
}

function findTagEnd(html, startIndex) {
  let quote = null;
  for (let i = startIndex; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function isTagNameBoundary(ch) {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch);
}

function getTagAttribute(attrText, targetName) {
  const attrPattern =
    /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const lowerTarget = targetName.toLowerCase();

  for (const match of attrText.matchAll(attrPattern)) {
    if (match[1].toLowerCase() === lowerTarget) {
      return match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
  return null;
}

function findExistingImportMapScript(html) {
  const lower = html.toLowerCase();
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      if (endComment === -1) break;
      i = endComment + 3;
      continue;
    }

    if (lower.startsWith('<script', lt) && isTagNameBoundary(html[lt + 7])) {
      const openEnd = findTagEnd(html, lt + 7);
      if (openEnd === -1) break;

      const closeStart = lower.indexOf('</script', openEnd + 1);
      if (closeStart === -1) break;
      const closeEnd = findTagEnd(html, closeStart + 8);
      if (closeEnd === -1) break;

      const attrText = html.slice(lt + 7, openEnd);
      const scriptType = getTagAttribute(attrText, 'type');
      if (scriptType !== null && scriptType.trim().toLowerCase() === 'importmap') {
        return {
          contentStart: openEnd + 1,
          contentEnd: closeStart,
        };
      }

      i = closeEnd + 1;
      continue;
    }

    i = lt + 1;
  }

  return null;
}

function findImportMapInsertionPoint(html) {
  const lower = html.toLowerCase();
  let i = 0;
  let firstScriptStart = -1;
  let afterHtmlOrDoctype = -1;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const endComment = html.indexOf('-->', lt + 4);
      if (endComment === -1) break;
      i = endComment + 3;
      continue;
    }

    if (lower.startsWith('<head', lt) && isTagNameBoundary(html[lt + 5])) {
      const openEnd = findTagEnd(html, lt + 5);
      if (openEnd !== -1) {
        return { index: openEnd + 1, leadingNewline: true };
      }
      break;
    }

    if (
      firstScriptStart === -1 &&
      lower.startsWith('<script', lt) &&
      isTagNameBoundary(html[lt + 7])
    ) {
      firstScriptStart = lt;
    }

    if (lower.startsWith('<!doctype', lt) && isTagNameBoundary(html[lt + 9])) {
      const openEnd = findTagEnd(html, lt + 9);
      if (openEnd !== -1) {
        afterHtmlOrDoctype = openEnd + 1;
        i = openEnd + 1;
        continue;
      }
    }

    if (lower.startsWith('<html', lt) && isTagNameBoundary(html[lt + 5])) {
      const openEnd = findTagEnd(html, lt + 5);
      if (openEnd !== -1) {
        afterHtmlOrDoctype = openEnd + 1;
        i = openEnd + 1;
        continue;
      }
    }

    i = lt + 1;
  }

  if (firstScriptStart !== -1) {
    return { index: firstScriptStart, leadingNewline: false };
  }
  if (afterHtmlOrDoctype !== -1) {
    return { index: afterHtmlOrDoctype, leadingNewline: true };
  }
  return { index: 0, leadingNewline: false };
}

/**
 * Applies the CodePen `packages` block to an HTML document by reading `package.json`
 * dependencies from the Pen root and injecting (or merging into an existing)
 * `<script type="importmap">` targeting `https://esm.sh/`.
 */
export async function applyPackagesBlock({ html, penContext, rootRealpath }) {
  if (!penContext?.hasPackages) return html;

  const pkgJsonPath = path.join(penContext.penDir, PACKAGE_JSON_FILENAME);
  const pkgJson = await readSafeJsonObject(pkgJsonPath, rootRealpath);
  if (!pkgJson || !isPlainObject(pkgJson.dependencies)) return html;

  const generatedImports = buildEsmShImports(pkgJson.dependencies);
  if (Object.keys(generatedImports).length === 0) return html;

  const existingScript = findExistingImportMapScript(html);
  if (existingScript) {
    const rawExisting = html.slice(existingScript.contentStart, existingScript.contentEnd).trim();
    try {
      const parsedExisting = rawExisting ? JSON.parse(rawExisting) : {};
      if (!isPlainObject(parsedExisting)) return html;

      const userImports = isPlainObject(parsedExisting.imports) ? parsedExisting.imports : {};
      const merged = {
        ...parsedExisting,
        imports: {
          ...generatedImports,
          ...userImports,
        },
      };

      return (
        html.slice(0, existingScript.contentStart) +
        `\n${serializeImportMap(merged)}\n` +
        html.slice(existingScript.contentEnd)
      );
    } catch {
      return html;
    }
  }

  const { index, leadingNewline } = findImportMapInsertionPoint(html);
  const prefix = leadingNewline ? '\n' : '';
  const importMapTag = `${prefix}<script type="importmap">\n${serializeImportMap({ imports: generatedImports })}\n</script>\n`;

  return html.slice(0, index) + importMapTag + html.slice(index);
}

/**
 * When a requested `.html` file does not exist on disk, checks if the enclosing Pen
 * enables the `classic` block and has a matching `.pen.html` source file. Returns the
 * compiled HTML string or `null`.
 */
export async function resolveVirtualClassicHtml({
  dirRealpath,
  requestedFilename,
  rootRealpath,
}) {
  if (
    typeof requestedFilename !== 'string' ||
    !requestedFilename ||
    requestedFilename.includes('\0') ||
    requestedFilename.includes('\\') ||
    requestedFilename.includes('/') ||
    requestedFilename !== path.basename(requestedFilename) ||
    requestedFilename.startsWith('.')
  ) {
    return null;
  }
  const lowerName = requestedFilename.toLowerCase();
  if (!lowerName.endsWith('.html') || lowerName.endsWith(PEN_HTML_SUFFIX)) {
    return null;
  }

  const penContext = await findPenContext(dirRealpath, rootRealpath);
  if (!penContext?.hasClassic) return null;

  const penHtmlFilename = `${requestedFilename.slice(0, -'.html'.length)}${PEN_HTML_SUFFIX}`;
  const penHtmlCandidate = path.join(dirRealpath, penHtmlFilename);

  return compileClassicPenHtml({
    penHtmlPath: penHtmlCandidate,
    penContext,
    rootRealpath,
  });
}

/**
 * Applies active HTML blocks (currently `packages`) to an existing `.html` file on disk.
 * Returns `{ transformed: true, html }` when a transform ran, or `{ transformed: false }`.
 */
export async function resolveServedHtmlWithBlocks({ filePath, rootRealpath }) {
  const lowerPath = filePath.toLowerCase();
  if (!lowerPath.endsWith('.html') || lowerPath.endsWith(PEN_HTML_SUFFIX)) {
    return { transformed: false };
  }

  const penContext = await findPenContext(path.dirname(filePath), rootRealpath);
  if (!penContext?.hasPackages) {
    return { transformed: false };
  }

  const safeFile = await resolveSafeFile(filePath, rootRealpath);
  if (!safeFile || safeFile.size > MAX_HTML_BYTES) {
    return { transformed: false };
  }

  const rawHtml = await fs.readFile(safeFile.realPath, 'utf8');
  const html = await applyPackagesBlock({ html: rawHtml, penContext, rootRealpath });
  if (html === rawHtml) {
    return { transformed: false };
  }
  return { transformed: true, html };
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

const UNSUPPORTED_BLOCK_PAGE_STYLE = `
@layer reset, base, components;

:root {
  color-scheme: light dark;

  --surface-page: light-dark(oklch(98.5% 0.004 250), oklch(15% 0.012 260));
  --surface-card: light-dark(oklch(100% 0 0), oklch(20% 0.014 260));
  --surface-code: light-dark(oklch(94.5% 0.008 255), oklch(25% 0.016 260));

  --text-primary: light-dark(oklch(20% 0.015 260), oklch(94% 0.008 250));
  --text-muted: light-dark(oklch(46% 0.016 260), oklch(72% 0.014 255));
  --text-subtle: light-dark(oklch(56% 0.014 260), oklch(62% 0.014 255));

  --border-subtle: light-dark(oklch(88% 0.01 255), oklch(30% 0.018 260));

  --accent: light-dark(oklch(48% 0.2 260), oklch(75% 0.15 250));
  --accent-fg: light-dark(oklch(99% 0 0), oklch(15% 0.015 260));

  --radius-card: 0.875rem;
  --radius-code: 0.375rem;
  accent-color: var(--accent);
}

@layer reset {
  html,
  body,
  main,
  article,
  header,
  footer,
  div,
  ul,
  li {
    box-sizing: border-box;
  }

  body,
  h1,
  p,
  ul {
    margin: 0;
  }
}

@layer base {
  body {
    min-block-size: 100dvb;
    display: grid;
    place-items: center;
    padding: clamp(1.5rem, 5vw, 3rem) clamp(1.25rem, 4vw, 2rem);
    background-color: var(--surface-page);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.55;
  }

  h1 {
    font-size: clamp(1.4rem, 3vw, 1.75rem);
    line-height: 1.25;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }

  p {
    text-wrap: pretty;
  }

  a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 0.25rem;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.875em;
    padding-block: 0.125em;
    padding-inline: 0.4em;
    border-radius: var(--radius-code);
    background-color: var(--surface-code);
  }
}

@layer components {
  .error-card {
    inline-size: min(100%, 38rem);
    display: grid;
    gap: 1.15rem;
    padding: clamp(1.5rem, 4vw, 2.25rem);
    background-color: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-card);
    corner-shape: squircle;
  }

  .error-header {
    display: grid;
    gap: 0.45rem;
    justify-items: start;
  }

  .demo-path {
    padding: 0;
    background: none;
    color: var(--text-subtle);
    font-size: 0.8rem;
  }

  .error-body {
    display: grid;
    gap: 1.25rem;
    color: var(--text-muted);
    font-size: 0.95rem;
  }

  .block-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    list-style: none;
    padding: 0;
  }

  .block-list code {
    color: var(--text-primary);
    font-weight: 500;
  }

  .error-illustration {
    display: block;
    inline-size: 7rem;
    block-size: 7rem;
    margin-block: 0.5rem;
    margin-inline: auto;
    color: light-dark(#000, var(--text-primary));
  }

  .error-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.65rem;
    padding-block-start: 1rem;
    border-block-start: 1px solid color-mix(in oklch, var(--border-subtle) 70%, transparent);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45em;
    padding-block: 0.55em;
    padding-inline: 0.95em;
    border-radius: var(--radius-code);
    border: 1px solid transparent;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.3;
    text-decoration: none;
    white-space: nowrap;
    transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
  }

  .btn-primary {
    background-color: var(--accent);
    color: var(--accent-fg);

    &:hover {
      background-color: color-mix(in oklch, var(--accent) 88%, var(--text-primary));
    }
  }

  .btn-secondary {
    border-color: var(--border-subtle);
    background-color: var(--surface-page);
    color: var(--text-primary);

    &:hover {
      border-color: color-mix(in oklch, var(--accent) 60%, var(--border-subtle));
      color: var(--accent);
    }
  }

  .btn-codepen {
    margin-inline-start: auto;
  }

  .btn-icon {
    flex-shrink: 0;
    inline-size: 0.95rem;
    block-size: 0.95rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .btn {
      transition: none;
    }
  }
}
`;

const UNSUPPORTED_BLOCK_PAGE_STYLE_HASH = createHash('sha256')
  .update(UNSUPPORTED_BLOCK_PAGE_STYLE, 'utf8')
  .digest('base64');

export const UNSUPPORTED_BLOCK_PAGE_CSP =
  `default-src 'none'; style-src 'sha256-${UNSUPPORTED_BLOCK_PAGE_STYLE_HASH}'; img-src 'none'; script-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`;

const UNSUPPORTED_BLOCK_EMOJI_SVG = `<svg class="error-illustration" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
            <circle cx="60" cy="60" r="52" />
            <line x1="33.5" y1="37.5" x2="50.5" y2="54.5" />
            <line x1="50.5" y1="37.5" x2="33.5" y2="54.5" />
            <line x1="69.5" y1="37.5" x2="86.5" y2="54.5" />
            <line x1="86.5" y1="37.5" x2="69.5" y2="54.5" />
            <line x1="32" y1="72" x2="88" y2="72" />
            <path d="M 58 72 V 83 A 11 11 0 0 0 80 83 V 72" />
            <line x1="69" y1="72" x2="69" y2="84" />
          </svg>`;

/**
 * Renders a self-contained HTML error page explaining which CodePen block(s) in
 * `.codepen/pen.config.json` are not supported, with links back to the homepage
 * and/or to open the demo on CodePen.
 */
export async function renderUnsupportedBlocksPage({
  penContext,
  rootRealpath,
  demoRelPath = null,
  homeHref = null,
}) {
  const cdpnConfig =
    (await readSafeJsonObject(
      path.join(penContext.penDir, CDPN_JSON_FILENAME),
      rootRealpath,
    )) ?? {};

  const codepenUrl = sanitizeCodePenUrl(cdpnConfig?.url);

  const blocks = penContext.unsupportedBlocks;
  const isPlural = blocks.length > 1;
  const headingText = isPlural ? 'Unsupported CodePen Blocks' : 'Unsupported CodePen Block';
  const displayPath = demoRelPath ?? `${path.basename(penContext.penDir)}/`;

  const blockItemsHtml = blocks
    .map((name) => `<li><code>${escapeHtml(name)}</code></li>`)
    .join('');

  const explanationHtml = isPlural
    ? `<p>This demo uses blocks configured in <code>.codepen/pen.config.json</code> that are not supported by <code>codepen-demokit</code>:</p>
          <ul class="block-list" aria-label="Unsupported blocks">${blockItemsHtml}</ul>`
    : `<p>This demo uses the <code>${escapeHtml(blocks[0])}</code> block in <code>.codepen/pen.config.json</code>, which is not supported by <code>codepen-demokit</code>.</p>`;

  const actions = [];
  if (homeHref) {
    const homeBtnClass = codepenUrl ? 'btn btn-secondary' : 'btn btn-primary';
    actions.push(
      `<a class="${homeBtnClass}" href="${escapeHtml(homeHref)}">
          <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.5 3.5 6 8l4.5 4.5" />
          </svg>
          <span>Back to Homepage</span>
        </a>`,
    );
  }
  if (codepenUrl) {
    actions.push(
      `<a class="btn btn-primary btn-codepen" href="${escapeHtml(codepenUrl)}" target="_blank" rel="noopener noreferrer">
          <svg class="btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="8,1.5 14.5,5.5 8,9.5 1.5,5.5" />
            <polygon points="8,6.5 14.5,10.5 8,14.5 1.5,10.5" />
            <line x1="1.5" y1="5.5" x2="1.5" y2="10.5" />
            <line x1="14.5" y1="5.5" x2="14.5" y2="10.5" />
            <line x1="8" y1="1.5" x2="8" y2="6.5" />
            <line x1="8" y1="9.5" x2="8" y2="14.5" />
          </svg>
          <span>Open on CodePen</span>
        </a>`,
    );
  }

  const actionsHtml =
    actions.length > 0
      ? `\n      <footer class="error-actions">\n        ${actions.join('\n        ')}\n      </footer>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(headingText)}</title>
    <style>${UNSUPPORTED_BLOCK_PAGE_STYLE}</style>
  </head>
  <body>
    <main>
      <article class="error-card">
        <header class="error-header">
          <code class="demo-path">${escapeHtml(displayPath)}</code>
          <h1>${escapeHtml(headingText)}</h1>
        </header>
        <div class="error-body">
          ${explanationHtml}
          ${UNSUPPORTED_BLOCK_EMOJI_SVG}
        </div>${actionsHtml}
      </article>
    </main>
  </body>
</html>
`;

  return { html, csp: UNSUPPORTED_BLOCK_PAGE_CSP };
}

/**
 * Checks whether `dirRealpath` belongs to a Pen with unsupported active blocks and,
 * if so, returns `{ html, csp }` for the error page.
 */
export async function resolveUnsupportedBlocksPage({
  dirRealpath,
  rootRealpath,
  isRootServe = true,
}) {
  const penContext = await findPenContext(dirRealpath, rootRealpath);
  if (!penContext || penContext.unsupportedBlocks.length === 0) {
    return null;
  }

  const relDir = path.relative(rootRealpath, dirRealpath);
  const dirSegments = relDir ? relDir.split(path.sep).filter(Boolean) : [];
  const homeHref = isRootServe && dirSegments.length > 0 ? '../'.repeat(dirSegments.length) : null;

  const relPen = path.relative(rootRealpath, penContext.penDir);
  const penSegments = relPen ? relPen.split(path.sep).filter(Boolean) : [];
  const demoRelPath =
    penSegments.length > 0 ? `${penSegments.join('/')}/` : `${path.basename(penContext.penDir)}/`;

  return renderUnsupportedBlocksPage({
    penContext,
    rootRealpath,
    demoRelPath,
    homeHref,
  });
}

