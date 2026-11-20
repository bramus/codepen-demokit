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
 * Inspects `<penDir>/.codepen/pen.config.json` and detects whether the supported
 * transformation blocks (`classic`, `packages`) are enabled.
 * Default blocks (`validate`, `fingerprint`) require no local transform; all other
 * CodePen blocks are intentionally ignored.
 */
export async function readPenBlocks(penDir, rootRealpath) {
  const configPath = path.join(penDir, CODEPEN_DIR, PEN_CONFIG_FILENAME);
  const parsed = await readSafeJsonObject(configPath, rootRealpath);
  if (!parsed || !isPlainObject(parsed.blocks)) return null;

  const activeBlocks = new Set();
  for (const [key, block] of Object.entries(parsed.blocks)) {
    if (!isPlainObject(block)) continue;
    if (block.disabled === true) continue;

    const rawName =
      typeof block.name === 'string' && block.name.trim() ? block.name.trim() : key;
    const blockType = normalizeBlockType(rawName);
    if (blockType) {
      activeBlocks.add(blockType);
    }
  }

  return {
    penDir,
    hasClassic: activeBlocks.has('classic'),
    hasPackages: activeBlocks.has('packages'),
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
