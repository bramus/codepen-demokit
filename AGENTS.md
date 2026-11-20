# Agent Instructions (`codepen-demokit`)

This repository is the **`codepen-demokit`** npm package—a framework for organizing, previewing, statically deploying, and syncing self-contained web demos with CodePen 2.0 via [CodePen Commander](https://www.npmjs.com/package/codepen-commander). Actual user demos live in separate consumer repositories that install `codepen-demokit` as a dependency.

## 1. Package Architecture

```text
.
├── bin/
│   └── cli.mjs                 # Unified CLI entrypoint (`codepen-demokit`)
├── lib/
│   ├── blocks.mjs              # CodePen Blocks support (`classic` + `packages`; `validate`/`fingerprint` no-op)
│   ├── config.mjs              # Loads/validates consumer `config.json` (`site` + `codepen`)
│   ├── build-json.mjs          # Scans `<projectDir>/src/` -> builds & watches `demos.json`
│   ├── build-site.mjs          # Builds static deployable `<projectDir>/dist/`
│   ├── serve.mjs               # Local dev server (serves `src/` + `shell/` fallback + watches `dist/demos.json`)
│   ├── sync-codepen.mjs        # CodePen sync, clone & new (`sync`, `pull`, `push`, `delete --keep-info`, `clone`, `new`)
│   └── init.mjs                # Interactive scaffolder for a consumer demos repo (`codepen-demokit init`)
├── shell/                      # Default framework-owned index UI (overridable in consumer `src/`)
│   ├── index.html
│   ├── styles.css
│   └── scripts.js
└── templates/                  # Files copied into consumer repos by `codepen-demokit init`
    ├── gitignore               # Copied as `.gitignore` (no leading dot so `npm pack` always includes it)
    ├── config.json.example
    ├── AGENTS.md               # Demo-authoring rules for consumer repos
    └── README.md
```

## 2. Framework Invariants & Security Rules

1. **Never assume framework root === consumer project root**:
   - Resolve consumer files (`src/`, `dist/`, `config.json`) relative to `projectDir` (default `process.cwd()`).
   - Resolve framework assets (`shell/`, `templates/`, `package.json`) relative to `PACKAGE_DIR` (`import.meta.url`).
2. **Keep `shell/` safe and vanilla**:
   - No frameworks, no build steps, strict CSP compatible (`script-src 'self'`, `style-src 'self'`).
   - Use safe DOM APIs (`textContent`, `document.createElement()`, `<template>.content.cloneNode(true)`, `replaceChildren()`) instead of `innerHTML`.
   - Always validate URLs (`./...` same-origin for local demos; `https://*.codepen.io` for CodePen links).
   - HTML-escape any `site` values rendered into `shell/index.html` (`escapeHtml()` in `lib/config.mjs`).
3. **Filesystem & CLI safety**:
   - Enforce strict root boundaries (`candidate.startsWith(root + path.sep)`) and `realpath` verification across `blocks.mjs`, `serve.mjs`, `build-json.mjs`, `build-site.mjs`, and `sync-codepen.mjs`.
   - Never expose dotfiles (`.cdpn.json`, `.cdpn`, `.env`, etc.) over HTTP or copy them into `dist/`.
   - Bind the dev server strictly to `127.0.0.1` (never `0.0.0.0`).
   - Strictly validate `codepen.user` and `codepen.defaultVisibility` before passing them to `cdpn`.
4. **Packaging hygiene**:
   - Keep `templates/gitignore` without a leading dot so `npm pack` always includes it.
   - Verify published package contents with `npm pack --dry-run` before releasing.
   - Keep `templates/AGENTS.md` in sync whenever consumer CLI commands or conventions change.
