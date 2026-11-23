# Agent Instructions (`codepen-demokit`)

This repository is the **`codepen-demokit`** npm package—an interactive starter pack CLI that scaffolds standalone web demo repositories (modeled on [`bramus/web-platform-demos`](https://github.com/bramus/web-platform-demos)) powered directly by [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn` `^1.4.1`).

Generated consumer repositories depend **only** on `codepen-commander` (`devDependencies`), not on `codepen-demokit` at runtime.

## 1. Package Architecture

```text
.
├── bin/
│   └── cli.mjs                         # CLI entrypoint (`codepen-demokit` / `codepen-demokit init`)
├── lib/
│   └── init.mjs                        # Interactive scaffolder, auth check & project generator
├── templates/                          # Files copied/rendered into consumer repos
│   ├── gitignore                       # Copied as `.gitignore` (no leading dot so `npm pack` always includes it)
│   ├── github/
│   │   └── workflows/
│   │       └── deploy.yml              # Copied as `.github/workflows/deploy.yml` (no leading dot for `npm pack`)
│   ├── AGENTS.md                       # Demo-authoring & `cdpn` rules for consumer repos
│   └── README.md                       # Starter README for consumer repos
└── test/
    └── init.test.mjs                   # Automated tests (`npm test`)
```

## 2. Package Invariants & Security Rules

1. **Never assume package root === target consumer directory**:
   - Resolve target consumer files relative to `targetDir` / `cwd`.
   - Resolve package templates and `package.json` relative to `PACKAGE_DIR` (`import.meta.url`).
   - Never overwrite existing files in the target directory (`writeIfMissing` / `copyIfMissing`).
2. **Filesystem & CLI safety**:
   - Enforce strict root containment (`candidate === root || candidate.startsWith(root + path.sep)`) and `lstat`/`realpath` symlink checks in `resolveTargetDirectory()` (`lib/init.mjs`).
   - Reject control characters, absolute paths, backslashes, `..`, `.`, and hidden directory segments in target directory inputs.
   - Shell-escape `--title` and `--subtitle` double-quoted arguments written into generated `package.json` scripts (`formatShellDoubleQuotedArg()`) and reject control characters so user input cannot break out of quotes or inject shell commands.
   - Strictly validate `defaultVisibility` against `VISIBILITY_OPTIONS` (`Private`, `Public`, `Protected`, `Collaborators`) before rendering `AGENTS.md`.
   - Spawn `codepen-commander` directly via `process.execPath` (`shell: false`) with hardcoded argument arrays (`['auth', 'status', '--offline', '--json']` and `['auth', 'login']`); never log API keys or raw credential objects.
3. **Packaging hygiene**:
   - Keep dotfile/dotdir templates without leading dots (`templates/gitignore`, `templates/github/workflows/deploy.yml`) so `npm pack` always includes them.
   - Keep `test/` excluded from `package.json`'s `"files"` array.
   - Run `npm test` and `npm pack --dry-run` before releasing.
   - Keep `templates/AGENTS.md` and `templates/README.md` in sync with `codepen-commander` CLI conventions.
