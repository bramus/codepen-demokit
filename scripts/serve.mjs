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
