# Agent Instructions

This repository is a collection of self-contained web demos powered by and synced with CodePen 2.0 via [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn`). Every agent working in this repository MUST follow the rules below.

## 1. Folder Structure & Naming

All demos live inside `src/`. Use clear, descriptive `kebab-case` names for all demo and group folders.

- **Index page**: Provided automatically by `cdpn serve` and `cdpn build` (using CodePen Commander's built-in shell, with `--title` and `--subtitle` configured in `package.json`). You only need to place `index.html`, `styles.css`, or `scripts.js` at `src/` root (or configure a custom shell via `--shell` / `cdpn shell`) if you intentionally want to override the default index UI.
- **Standalone demo** (directly inside `src/`):
  ```text
  src/<demo-name>/
  ├── index.html      # or Pen entry files (e.g. index.pen.html)
  ├── styles.css      # optional
  ├── scripts.js      # optional
  ├── .cdpn.json      # required; CodePen sync metadata, or unlinked info-only via `cdpn init`
  └── .codepen/       # CodePen 2.0 config (pen.config.json)
  ```
- **Grouped or nested demos** (related demos sharing topic folders inside `src/`):
  ```text
  src/<group-name>/
  ├── <demo-one>/
  │   ├── index.html
  │   ├── styles.css  # optional
  │   ├── scripts.js  # optional
  │   ├── .cdpn.json  # required (sync metadata, or unlinked info-only via `cdpn init`)
  │   └── .codepen/
  │       └── pen.config.json
  └── <subgroup-name>/
      └── <demo-two>/
          ├── index.html
          ├── styles.css
          ├── .cdpn.json
          └── .codepen/
              └── pen.config.json
  ```

- Reuse an existing `src/<group-name>/` directory whenever a new demo clearly belongs to that topic.
- Create a new `src/<group-name>/` directory when building a series of related demos around the same feature or topic.

## 2. Self-Contained Demo Rules

Every demo folder MUST be self-contained and portable so it can be opened, served, or copied independently without breaking—and so it syncs cleanly as a standalone CodePen 2.0 Pen:

1. **Entry point & `.cdpn.json` discovery**:
   - `codepen-commander` discovers, indexes, serves, builds, and batch-syncs only folders inside `src/` that contain a `.cdpn.json` file (either linked or unlinked info-only). Subdirectories without `.cdpn.json` are ignored by `cdpn serve`, `cdpn build`, and `cdpn <cmd> all`.
   - Include an `index.html` entry point so standalone demos render cleanly in the browser, or preserve the existing file layout (e.g., `index.pen.html` + `.codepen/` + `.cdpn.json`, or `package.json` with CodePen's `packages` block) for Pens cloned or forked from CodePen via `cdpn`—`cdpn serve` and `cdpn build` automatically handle CodePen's `classic` and `packages` blocks.
2. **Local assets stay inside the demo folder**:
   - Store local files (stylesheets, scripts, images, SVGs, fonts, media, data files) inside that demo's folder and reference them with relative paths (`./...`).
3. **No cross-demo coupling**:
   - Never import or reference files from `src/` root, the repository root, or sibling demos (e.g., `../other-demo/...`).

## 3. CodePen Sync (`cdpn` / CodePen Commander)

This repository uses [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn`) directly (available locally via `npx cdpn` or `npm run cdpn --`, or globally via `cdpn`) to manage and sync demos in `src/` with CodePen 2.0:

- **Creating a new local (unsynced) demo**:
  - Whenever creating a new demo in `src/` that has not been synced with CodePen yet (i.e. not cloned, forked, or scaffolded via `cdpn`), initialize it with `cdpn init` so it receives both an unlinked `.cdpn.json` (with `info`) and `.codepen/pen.config.json` (with the required `fingerprint-1` and `validate-1` blocks, plus any optional blocks like `packages` or `classic`):
    ```sh
    npx cdpn init src/<path-to-demo> -t "<Demo Title>" --visibility {{DEFAULT_VISIBILITY}} --json
    ```
  - Pass additional flags when relevant (`-d "<description>"`, `--tags tag1,tag2`, `--blocks packages`, etc.). Default visibility for new unsynced demos in this repository is `{{DEFAULT_VISIBILITY}}` unless specified otherwise.
  - Non-`Public` demos (`Private`, `Protected`, `Collaborators`) are visible locally in `cdpn serve` (`npm start`) and excluded from static builds (`npm run build`) by default until their `info.access` is set to `"Public"` (e.g., via `npx cdpn privacy public` inside a linked demo folder, or by editing `info.access` in `.cdpn.json` and syncing), unless `--access <levels>` / `--visibility <levels>` is passed to `cdpn build`.
  - Do not overwrite an existing `.cdpn.json` or `.codepen/pen.config.json` (e.g. in demos cloned, forked, or scaffolded via `cdpn`, or demos that already declare additional blocks such as `classic-1` or `packages-1`).
- **Cloning, forking, or scaffolding a Pen into `src/`**:
  - `npx cdpn clone <url> src/<folder>` — clone an existing CodePen Pen into `src/`
  - `npx cdpn fork <url> src/<folder>` — fork one of your own 2.0 Pens into `src/`
  - `npx cdpn new src/<folder>` — scaffold a brand-new 2.0 Pen from a CodePen Template (or default starter) into a new or empty folder inside `src/`
- **Batch and single-Pen sync commands**:
  - Use the explicit `all` target to walk subdirectories from the repository root (covering all `.cdpn.json` demos in `src/`), or run from inside a `src/<group>/` folder to scope to that group:
    - `npx cdpn status all` — inspect sync status across all discovered demos
    - `npx cdpn sync all` — two-way sync across all discovered demos (creates unlinked Pens, pushes local-ahead, pulls remote-ahead, detects conflicts)
    - `npx cdpn push all` — push local edits and create Pens for unlinked demos
    - `npx cdpn pull all` — pull remote updates for linked demos (supports `--force`)
    - `npx cdpn delete all` — delete linked Pens on CodePen (moves to Deleted Items for 3 days; keeps `.cdpn.json` & `.codepen/` by default, pass `--cleanup` to keep only unlinked `info`, or `--full-cleanup` to remove both)
    - `npx cdpn unlink all` — unlink local demos without touching online Pens, `.codepen/`, or `info`
  - Pass `--dry-run` on `sync`, `push`, `pull`, `delete`, or `unlink` to preview without modifying CodePen or local files.
  - Target a single demo by passing its path (e.g., `npx cdpn push src/scroll-driven-animations/coverflow`) or running `npx cdpn <command>` inside that demo folder.
- **Non-interactive CLI usage**:
  - Pass `--json` and explicit flags when running non-interactively (e.g., `-t "<title>"`, `--visibility <Public|Private|Protected|Collaborators>`, `-m "<label>"`, `--yes`, `--profile <name>`).
- **Sync metadata files**:
  - `.cdpn.json` exists both when a demo is synced with CodePen (full sync metadata including `url`, `pen_id`, `profile`, `files`, and `info`) and when it is not synced yet (containing only the `info` field—e.g. `title`, `description`, `tags`, `access`, `template`—such as after `cdpn init`, `cdpn unlink`, or `cdpn delete --cleanup`).
  - Commit `.codepen/` and `.cdpn.json` (contains no secrets) inside each demo folder so Pen configuration, metadata, and sync state persist across machines.
  - Never commit API keys or `.cdpn` files (authentication profiles live in `~/.cdpn`).
  - Do not manually edit sync fields (`url`, `pen_id`, `last_synced_version_id`, `last_synced_info_hash`, `files`, etc.) in `.cdpn.json`; let `cdpn` manage them (only the `info` field may be edited manually, or updated via `cdpn info` / `cdpn privacy`).

## 4. Keeping the Demo Index Up to Date

- The web index page and `demos.json` are **automatically generated** from `src/` subfolders containing a `.cdpn.json` file (reading each demo's title, description, tags, and CodePen URL from `.cdpn.json`, with fallback to `index.html` `<title>` / `<meta name="description">`). Never manually edit `dist/`.
  - `cdpn serve` serves **all** discovered `.cdpn.json` demos locally (in-memory `demos.json`), regardless of visibility.
  - `cdpn build` publishes **only `Public` demos** (`"access": "Public"` in `.cdpn.json`) into `dist/` and `dist/demos.json` by default. Non-public demos (`Private`, `Protected`, `Collaborators`) are excluded unless `--access <levels>` (alias `--visibility <levels>`, e.g., `--access Public,Private` or `--access all`) is passed.
- Whenever you add, initialize, clone, fork, scaffold, push to CodePen for the first time, rename, move, or remove a demo, update the `## Demos` section in `README.md`.

## 5. Local Verification

- Give each demo a descriptive `info.title` and optional `info.description` in `.cdpn.json` (plus matching `<title>` and `<meta name="description" content="...">` in `index.html`) so it displays cleanly on the index card.
- Preview locally with `npm start` (runs `cdpn serve src ...` at `http://127.0.0.1:3000`), or `npx cdpn serve src/<group>/<demo>` to serve a single demo directly as the root.
- Verify static production builds with `npm run build` (runs `cdpn build src --out dist --yes ...` and outputs the deployable static site of `Public` demos to `dist/`; pass `-- --access all` or `-- --access Public,Private` to include non-public demos).
