import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_DIR } from './build-site.mjs';

const TEMPLATES_DIR = path.join(PACKAGE_DIR, 'templates');

function toValidPackageName(dirName) {
  const cleaned = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '');
  return cleaned || 'my-codepen-demos';
}

async function readFrameworkVersion() {
  const pkgJsonPath = path.join(PACKAGE_DIR, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));
  return pkg.version || '1.0.0';
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

export async function initProject({ targetDir = process.cwd() } = {}) {
  const resolvedDir = path.resolve(targetDir);
  await fs.mkdir(resolvedDir, { recursive: true });

  const version = await readFrameworkVersion();
  const packageName = toValidPackageName(path.basename(resolvedDir));
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
      cdpn: 'cdpn',
    },
    engines: {
      node: '>=20',
    },
    devDependencies: {
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
    ['config.json.example', 'config.json'],
    ['AGENTS.md', 'AGENTS.md'],
    ['README.md', 'README.md'],
  ];

  for (const [srcName, destName] of templateCopies) {
    const status = await copyIfMissing(
      path.join(TEMPLATES_DIR, srcName),
      path.join(resolvedDir, destName),
    );
    record(destName, status);
  }

  record(
    'src/.gitkeep',
    await writeIfMissing(path.join(resolvedDir, 'src', '.gitkeep'), ''),
  );

  console.log(`Initialized codepen-demokit project in ${resolvedDir}\n`);
  for (const item of results) {
    const icon = item.status === 'created' ? '+' : '-';
    const label = item.status === 'created' ? 'CREATED' : 'SKIPPED';
    console.log(`  ${icon} [${label}] ${item.path}`);
  }

  const relDir = path.relative(process.cwd(), resolvedDir);
  console.log('\nNext steps:');
  if (relDir && relDir !== '.') {
    console.log(`  1. cd ${relDir}`);
    console.log('  2. npm install');
    console.log('  3. Edit config.json to set your site info and CodePen profile ("codepen.user")');
    console.log('  4. npx cdpn auth login <your-codepen-username>');
    console.log('  5. npm start');
  } else {
    console.log('  1. npm install');
    console.log('  2. Edit config.json to set your site info and CodePen profile ("codepen.user")');
    console.log('  3. npx cdpn auth login <your-codepen-username>');
    console.log('  4. npm start');
  }

  return { targetDir: resolvedDir, results };
}
