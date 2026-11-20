import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildDemosJson, watchDemos } from './build-json.mjs';
import { SHELL_DIR } from './build-site.mjs';
import { loadSiteConfig, renderShellIndexHtml } from './config.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

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

const SHELL_FALLBACK_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/scripts.js', 'scripts.js'],
]);

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
  if (rawPort === undefined || rawPort === null || rawPort === '') return DEFAULT_PORT;
  const parsed = Number.parseInt(String(rawPort), 10);
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

async function resolveServeRoot(srcDir, srcRealpath, targetArg) {
  if (!targetArg) {
    return { rootDir: srcDir, rootRealpath: srcRealpath, label: 'src/', isRootServe: true };
  }

  if (targetArg.includes('\0') || targetArg.includes('\\') || path.isAbsolute(targetArg)) {
    throw new Error(`Invalid target folder "${targetArg}": pass a relative folder path inside src/.`);
  }

  const trimmed = targetArg.replace(/\/+$/, '');
  if (!trimmed) {
    return { rootDir: srcDir, rootRealpath: srcRealpath, label: 'src/', isRootServe: true };
  }

  const segments = trimmed.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      throw new Error(`Invalid target folder "${targetArg}": path traversal and hidden folders are not allowed.`);
    }
  }

  const candidateDir = path.resolve(srcDir, ...segments);
  if (!isWithinRoot(candidateDir, srcDir)) {
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
  if (!isWithinRoot(realTargetDir, srcRealpath)) {
    throw new Error(`Invalid target folder "${targetArg}": resolves outside src/.`);
  }

  return {
    rootDir: candidateDir,
    rootRealpath: realTargetDir,
    label: `src/${segments.join('/')}/`,
    isRootServe: false,
  };
}

async function resolveSafePath(rawPathname, rootDir, rootRealpath) {
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

  const resolvedPath = path.resolve(rootDir, ...segments);
  if (!isWithinRoot(resolvedPath, rootDir)) {
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
      if (!isWithinRoot(realIndexPath, rootRealpath)) {
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
  if (!isWithinRoot(realFilePath, rootRealpath)) {
    return { status: 403, message: 'Forbidden' };
  }

  return { status: 200, filePath: realFilePath, size: stat.size };
}

export async function startServer({
  projectDir = process.cwd(),
  targetFolder = null,
  port: rawPort = process.env.PORT,
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const srcDir = path.resolve(resolvedProjectDir, 'src');
  const distDemosJsonPath = path.resolve(resolvedProjectDir, 'dist', 'demos.json');

  let srcRealpath;
  try {
    srcRealpath = await fs.realpath(srcDir);
  } catch {
    throw new Error(`Directory "src/" not found in ${resolvedProjectDir}.`);
  }

  const { rootDir, rootRealpath, label, isRootServe } = await resolveServeRoot(
    srcDir,
    srcRealpath,
    targetFolder,
  );
  const port = parsePort(rawPort);

  const { demoCount } = await buildDemosJson({
    projectDir: resolvedProjectDir,
    outputFile: distDemosJsonPath,
  });
  console.log(`Built dist/demos.json (${demoCount} ${demoCount === 1 ? 'demo' : 'demos'})`);

  const demoWatcher = watchDemos({
    projectDir: resolvedProjectDir,
    outputFile: distDemosJsonPath,
    onRebuild({ demoCount: updatedCount }) {
      console.log(`Rebuilt dist/demos.json (${updatedCount} ${updatedCount === 1 ? 'demo' : 'demos'})`);
    },
    onError(error) {
      console.error(`Error rebuilding dist/demos.json: ${error.message}`);
    },
  });
  console.log('Watching src/ for demo changes…');

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

    // Serve generated dist/demos.json at /demos.json when serving root
    if (isRootServe && requestUrl.pathname === '/demos.json') {
      try {
        const content = await fs.readFile(distDemosJsonPath);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': content.byteLength,
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(content);
        }
      } catch {
        sendError(res, 404, 'Not Found');
      }
      return;
    }

    const result = await resolveSafePath(requestUrl.pathname, rootDir, rootRealpath);

    if (result.status === 301 && result.redirect) {
      res.writeHead(301, {
        ...SECURITY_HEADERS,
        Location: result.redirect,
      });
      res.end();
      return;
    }

    // Fall back to framework shell for root index assets if not overridden in src/
    if (result.status === 404 && isRootServe && SHELL_FALLBACK_FILES.has(requestUrl.pathname)) {
      const shellFile = SHELL_FALLBACK_FILES.get(requestUrl.pathname);
      const shellPath = path.join(SHELL_DIR, shellFile);
      const ext = path.extname(shellPath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

      try {
        let content;
        if (shellFile === 'index.html') {
          const templateHtml = await fs.readFile(shellPath, 'utf8');
          const siteConfig = loadSiteConfig(resolvedProjectDir);
          content = Buffer.from(renderShellIndexHtml(templateHtml, siteConfig), 'utf8');
        } else {
          content = await fs.readFile(shellPath);
        }

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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`Serving ${label} at http://${HOST}:${port}`);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    demoWatcher.close();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  return { server, close };
}
