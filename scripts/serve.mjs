import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const SRC_REALPATH = await fs.realpath(SRC_DIR);

const MIME_TYPES = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

// TODO(security): Permissions-Policy is intentionally omitted on this localhost-only
// demo server so experimental web platform demos (e.g., sensors, media, fullscreen)
// are not blocked when testing locally.
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

function parsePort(rawPort) {
  if (!rawPort) return DEFAULT_PORT;
  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }
  return parsed;
}

function sendError(res, statusCode, message, extraHeaders = {}) {
  const body = `${statusCode} ${message}\n`;
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function isWithinRoot(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

async function resolveServeRoot(targetArg) {
  if (!targetArg) {
    return { rootDir: SRC_DIR, rootRealpath: SRC_REALPATH, label: 'src/' };
  }

  if (targetArg.includes('\0') || targetArg.includes('\\') || path.isAbsolute(targetArg)) {
    throw new Error(`Invalid target folder "${targetArg}": pass a relative folder path inside src/.`);
  }

  const trimmed = targetArg.replace(/\/+$/, '');
  if (!trimmed) {
    return { rootDir: SRC_DIR, rootRealpath: SRC_REALPATH, label: 'src/' };
  }

  const segments = trimmed.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      throw new Error(`Invalid target folder "${targetArg}": path traversal and hidden folders are not allowed.`);
    }
  }

  const candidateDir = path.resolve(SRC_DIR, ...segments);
  if (!isWithinRoot(candidateDir, SRC_DIR)) {
    throw new Error(`Invalid target folder "${targetArg}": must resolve within src/.`);
  }

  let stat;
  try {
    stat = await fs.stat(candidateDir);
  } catch {
    throw new Error(`Folder "src/${segments.join('/')}" does not exist.`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`"src/${segments.join('/')}" is not a directory.`);
  }

  const realTargetDir = await fs.realpath(candidateDir);
  if (!isWithinRoot(realTargetDir, SRC_REALPATH)) {
    throw new Error(`Invalid target folder "${targetArg}": resolves outside src/.`);
  }

  return {
    rootDir: candidateDir,
    rootRealpath: realTargetDir,
    label: `src/${segments.join('/')}/`,
  };
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 1) {
  console.error('Usage: npm start [folder-in-src]');
  process.exit(1);
}

let ROOT_DIR;
let ROOT_REALPATH;
let SERVE_LABEL;
try {
  const resolvedRoot = await resolveServeRoot(cliArgs[0]);
  ROOT_DIR = resolvedRoot.rootDir;
  ROOT_REALPATH = resolvedRoot.rootRealpath;
  SERVE_LABEL = resolvedRoot.label;
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

async function resolveSafePath(rawPathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPathname);
  } catch {
    return { status: 400, message: 'Bad Request' };
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return { status: 400, message: 'Bad Request' };
  }

  const segments = decodedPath.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      return { status: 403, message: 'Forbidden' };
    }
  }

  const resolvedPath = path.resolve(ROOT_DIR, ...segments);
  if (!isWithinRoot(resolvedPath, ROOT_DIR)) {
    return { status: 403, message: 'Forbidden' };
  }

  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    return { status: 404, message: 'Not Found' };
  }

  if (stat.isDirectory()) {
    if (!decodedPath.endsWith('/')) {
      const normalizedRedirect = `/${segments.map(encodeURIComponent).join('/')}/`;
      return { status: 301, redirect: normalizedRedirect };
    }

    const indexPath = path.join(resolvedPath, 'index.html');
    try {
      const indexStat = await fs.stat(indexPath);
      if (!indexStat.isFile()) {
        return { status: 404, message: 'Not Found' };
      }
      const realIndexPath = await fs.realpath(indexPath);
      if (!isWithinRoot(realIndexPath, ROOT_REALPATH)) {
        return { status: 403, message: 'Forbidden' };
      }
      return { status: 200, filePath: realIndexPath, size: indexStat.size };
    } catch {
      return { status: 404, message: 'Not Found' };
    }
  }

  if (!stat.isFile()) {
    return { status: 404, message: 'Not Found' };
  }

  const realFilePath = await fs.realpath(resolvedPath);
  if (!isWithinRoot(realFilePath, ROOT_REALPATH)) {
    return { status: 403, message: 'Forbidden' };
  }

  return { status: 200, filePath: realFilePath, size: stat.size };
}

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

async function resolveSafeRealFile(candidatePath) {
  if (!isWithinRoot(candidatePath, SRC_DIR)) return null;
  let stat;
  try {
    stat = await fs.stat(candidatePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinRoot(realPath, SRC_REALPATH)) return null;
    return { realPath, size: stat.size };
  } catch {
    return null;
  }
}

async function resolveSafeRealDir(candidatePath) {
  if (!isWithinRoot(candidatePath, SRC_DIR)) return null;
  let stat;
  try {
    stat = await fs.stat(candidatePath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinRoot(realPath, SRC_REALPATH)) return null;
    return realPath;
  } catch {
    return null;
  }
}

async function readDemoEntry(segments) {
  const demoDir = path.resolve(SRC_DIR, ...segments);
  const indexFile = await resolveSafeRealFile(path.join(demoDir, 'index.html'));
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
  const cdpnFile = await resolveSafeRealFile(path.join(demoDir, '.cdpn.json'));
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

async function scanGroupNode(dirRealpath, segments, depth, visitedRealpaths) {
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
    const childCandidate = path.resolve(SRC_DIR, ...childSegments);
    const childRealDir = await resolveSafeRealDir(childCandidate);
    if (!childRealDir || visitedRealpaths.has(childRealDir)) continue;

    visitedRealpaths.add(childRealDir);

    const demoEntry = await readDemoEntry(childSegments);
    if (demoEntry) {
      demos.push(demoEntry);
      continue;
    }

    const subNode = await scanGroupNode(childRealDir, childSegments, depth + 1, visitedRealpaths);
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

async function scanDemos() {
  const visitedRealpaths = new Set([SRC_REALPATH]);
  const root = await scanGroupNode(SRC_REALPATH, [], 0, visitedRealpaths);
  return {
    groups: root.groups,
    standalone: root.demos,
  };
}

const port = parsePort(process.env.PORT);

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url ?? '/', `http://${HOST}:${port}`);
  } catch {
    sendError(res, 400, 'Bad Request');
    return;
  }

  // TODO(security): Authentication and rate-limiting are intentionally omitted on
  // /demos.json because this server binds strictly to 127.0.0.1 for local demo
  // browsing and serves only public, non-sensitive folder metadata from src/.
  if (ROOT_DIR === SRC_DIR && requestUrl.pathname === '/demos.json') {
    try {
      const manifest = await scanDemos();
      const body = JSON.stringify(manifest);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    } catch {
      sendError(res, 500, 'Internal Server Error');
    }
    return;
  }

  const result = await resolveSafePath(requestUrl.pathname);

  if (result.status === 301 && result.redirect) {
    res.writeHead(301, {
      ...SECURITY_HEADERS,
      Location: result.redirect,
    });
    res.end();
    return;
  }

  if (result.status !== 200 || !result.filePath) {
    sendError(res, result.status, result.message ?? 'Error');
    return;
  }

  const ext = path.extname(result.filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    const content = await fs.readFile(result.filePath);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Length': content.byteLength,
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(content);
    }
  } catch {
    sendError(res, 500, 'Internal Server Error');
  }
});

server.listen(port, HOST, () => {
  console.log(`Serving ${SERVE_LABEL} at http://${HOST}:${port}`);
});
