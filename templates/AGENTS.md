# Agent Instructions

This repository is a collection of self-contained, vanilla web platform demos powered by [`codepen-demokit`](https://www.npmjs.com/package/codepen-demokit) and synced with CodePen 2.0 via [CodePen Commander](https://www.npmjs.com/package/codepen-commander). Every agent working in this repository MUST follow the rules below.

## 1. Folder Structure & Naming

All demos live inside `src/`. Use clear, descriptive `kebab-case` names for all demo and group folders.

- **Index page**: Provided automatically by `codepen-demokit` (configured via `site` in `config.json`). You only need to place `index.html`, `styles.css`, or `scripts.js` at `src/` root if you intentionally want to override the default index UI.
- **Standalone demo** (directly inside `src/`):
  ```text
  src/<demo-name>/
  ├── index.html
  ├── styles.css      # only if needed
  ├── scripts.js      # only if needed
  ├── .cdpn.json      # CodePen sync metadata (when synced via CodePen Commander)
  └── .codepen/       # optional CodePen 2.0 config (e.g. pen.config.json)
  ```
- **Grouped or nested demos** (related demos sharing topic folders inside `src/`):
  ```text
  src/<group-name>/
  ├── <demo-one>/
  │   ├── index.html
  │   ├── styles.css  # only if needed
  │   ├── scripts.js  # only if needed
  │   └── .cdpn.json  # when synced
  └── <subgroup-name>/
      └── <demo-two>/
          ├── index.html
          └── styles.css
  ```

- Reuse an existing `src/<group-name>/` directory whenever a new demo clearly belongs to that topic.
- Create a new `src/<group-name>/` directory when building a series of related demos around the same feature or topic.

## 2. Self-Contained Demo Rules

Every demo folder MUST be completely self-contained and portable so it can be opened, served, or copied independently without breaking (and so it syncs cleanly as a standalone CodePen 2.0 Pen):

1. **Standard filenames**:
   - `index.html` — required entry point.
   - `styles.css` — stylesheet, included only when CSS is needed.
   - `scripts.js` — client-side script, included only when JavaScript is needed.
   - For Pens cloned or forked from CodePen via `cdpn`, preserve their existing file layout unless the user explicitly asks to reorganize them.
2. **Vanilla JavaScript only**:
   - Use standard vanilla HTML, CSS, and JavaScript (prefer `<script type="module" src="./scripts.js"></script>` or `<script src="./scripts.js" defer></script>`).
   - No UI frameworks, no bundlers, no preprocessors, no build steps, and no `node_modules` imports inside demos.
   - **Prioritize pure native web platform APIs.** Do **not** add polyfills or legacy fallbacks unless explicitly requested by the user.
   - If a demo relies on an experimental feature, Origin Trial, or browser flag, clearly note the requirement (e.g., minimum browser version or `chrome://flags` setting) in the demo UI (or its `<meta name="description">`) and its entry in `README.md`.
3. **All external assets stay inside the demo folder**:
   - Store images, SVGs, fonts, media, data files, or third-party scripts **inside that demo's folder** (e.g., `./assets/` or `./vendor/`) and reference them with relative paths (`./...`).
   - Do not hotlink third-party CDNs unless explicitly requested.
4. **No cross-demo coupling**:
   - Never import or reference files from `src/` root, the repository root, or sibling demos (e.g., `../other-demo/...`).

## 3. CodePen Sync (`cdpn:*` & CodePen Commander)

This repository uses `codepen-demokit` (powered by CodePen Commander / `cdpn` under the hood) to keep demos in `src/` synced with CodePen 2.0:

- Bulk commands (configured via `codepen.user` and `codepen.defaultVisibility` in `config.json`):
  - `npm run cdpn:sync` — two-way sync across `src/`
  - `npm run cdpn:push` — push local edits and create Pens for unlinked demos
  - `npm run cdpn:pull` — pull remote updates (supports `-- --force`)
  - `npm run cdpn:delete` — delete linked Pens on CodePen while keeping Pen metadata (`--keep-info`) in `.cdpn.json`
  - All bulk commands support optional folder scoping (e.g., `npm run cdpn:push -- scroll-driven-animations`) and `-- --dry-run`.
- Single-Pen commands via `npx cdpn`:
  - Pass `--json` and explicit flags when running non-interactively (e.g., `-t "<title>"`, `--access <Public|Private|Protected|Collaborators>`, `-m "<label>"`, `--yes`).
- Sync metadata files:
  - Commit `.cdpn.json` (contains no secrets) and `.codepen/` inside each synced demo folder so sync state persists across machines.
  - Never commit API keys or `.cdpn` files.
  - Do not manually edit `.cdpn.json`; let `cdpn` manage it.

## 4. Keeping the Demo Index Up to Date

- The web index page and `dist/demos.json` are **automatically built** by `codepen-demokit` from `src/` subfolders (reading each demo's `<title>`, optional `<meta name="description">`, and optional `.cdpn.json` URL). Never manually edit `dist/`.
- Whenever you add, clone, fork, scaffold, push to CodePen for the first time, rename, move, or remove a demo, update the `## Demos` section in `README.md`.

## 5. Code Quality & Local Verification

- Use clean, semantic HTML5 with `<!DOCTYPE html>`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, a descriptive `<title>`, and an optional `<meta name="description" content="...">` (displayed automatically on the index card).
- Use safe DOM APIs (`textContent`, `document.createElement()`, `replaceChildren()`) instead of `innerHTML` with dynamic data.
- Preview locally with `npm start` (serves at `http://127.0.0.1:3000`), or `npm start "group/demo"` to serve a single demo directly as the root.
- Verify static production builds with `npm run build` (outputs deployable static site to `dist/`).
