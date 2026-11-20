# Agent Instructions

This repository is a collection of self-contained, vanilla web platform demos. Every agent working in this repository MUST follow the rules below.

## 1. Mandatory Skill: `modern-web-guidance`

Using the **`modern-web-guidance`** skill is a **hard requirement** for this repository.

- `modern-web-guidance` should be installed globally as a user-level skill pack rather than locally inside this repository.
- **Before creating or modifying any HTML, CSS, or client-side JavaScript**, you MUST consult `modern-web-guidance`:
  1. Search for relevant guides using focused 2–5 word English queries:
     ```sh
     npx -y modern-web-guidance@latest search "<query>"
     ```
  2. Retrieve the matching guide(s) and any applicable discipline guide (e.g., `css`, `css-layout`, `dark-mode`, `accessibility`):
     ```sh
     npx -y modern-web-guidance@latest retrieve "<id>"
     ```
  3. Cross-check your implementation against the retrieved guides before finishing.
- Do not skip this step or rely solely on training knowledge—web platform APIs evolve rapidly.

### Browser Support & Feature Policy

- `.mwgrc` in the repository root is configured with:
  - `"allowOriginTrials": true`
  - `"allowVolatileFeatures": true`
  - `"baseline": "limited"`
- **Prioritize pure native web platform APIs.** Do **not** add polyfills or legacy fallbacks unless explicitly requested by the user.
- If a demo relies on an experimental feature, Origin Trial, or browser flag, clearly note the requirement (e.g., minimum browser version or `chrome://flags` setting) in the demo UI or its entry in `README.md` and `src/index.html`.

## 2. Folder Structure & Naming

All demos and the browseable index page live inside `src/`. Use clear, descriptive `kebab-case` names for all demo and group folders.

- **Index page**:
  - `src/index.html` and `src/styles.css`
- **Standalone demo** (directly inside `src/`):
  ```text
  src/<demo-name>/
  ├── index.html
  ├── styles.css      # only if needed
  ├── scripts.js      # only if needed
  ├── .cdpn.json      # CodePen sync metadata (when synced via cdpn)
  └── .codepen/       # optional CodePen 2.0 config (e.g. pen.config.json)
  ```
- **Grouped demos** (related demos sharing a topic folder inside `src/`):
  ```text
  src/<group-name>/
  ├── <demo-one>/
  │   ├── index.html
  │   ├── styles.css  # only if needed
  │   ├── scripts.js  # only if needed
  │   └── .cdpn.json  # when synced via cdpn
  └── <demo-two>/
      ├── index.html
      └── styles.css
  ```
  Example: `src/scroll-triggered-animations/reveal-on-enter/` and `src/scroll-triggered-animations/sticky-header/`.

- Reuse an existing `src/<group-name>/` directory whenever a new demo clearly belongs to that topic.
- Create a new `src/<group-name>/` directory when building a series of related demos around the same feature or topic.

## 3. Self-Contained Demo Rules

Every demo folder MUST be completely self-contained and portable so it can be opened, served, or copied independently without breaking (and so it syncs cleanly as a standalone CodePen 2.0 Pen):

1. **Standard filenames**:
   - `index.html` — required entry point.
   - `styles.css` — stylesheet, included only when CSS is needed.
   - `scripts.js` — client-side script, included only when JavaScript is needed.
   - For Pens cloned or forked from CodePen via `cdpn`, preserve their existing file layout unless the user explicitly asks to reorganize them.
2. **Vanilla JavaScript only**:
   - Use standard vanilla HTML, CSS, and JavaScript (prefer `<script type="module" src="./scripts.js"></script>` or `<script src="./scripts.js" defer></script>`).
   - No UI frameworks, no bundlers, no preprocessors, no build steps, and no `node_modules` imports inside demos.
3. **All external assets stay inside the demo folder**:
   - If a demo requires images, SVGs, fonts, media, data files, or external/third-party scripts, store them **inside that demo's folder** (either alongside `index.html` or in a local subdirectory such as `./assets/` or `./vendor/`) and reference them with relative paths (`./...`).
   - Do not hotlink third-party CDNs unless explicitly requested.
4. **No cross-demo coupling**:
   - Never import or reference files from `src/` (e.g., `../styles.css`), the repository root, or sibling demos (e.g., `../other-demo/...`).

## 4. CodePen Sync (`codepen-commander` / `cdpn`)

This repository relies on [`codepen-commander`](https://www.npmjs.com/package/codepen-commander) (the `cdpn` CLI, installed as a `devDependency` in `package.json`) to clone, fork, scaffold, and sync demos with CodePen 2.0.

- **Invocation**: Run `npx cdpn <command>` (or `npm run cdpn -- <command>`, or `cdpn` if installed globally). `npx cdpn` resolves the local `devDependency` from both the repository root and any demo subfolder under `src/`.
- **Authentication**: API keys are stored outside the repository in `~/.cdpn` (via `npx cdpn auth login`) or via the `CODEPEN_API_KEY` environment variable. Never commit API keys or `.cdpn` files.
- **Non-interactive agent usage**:
  - Pass `--json` on data/state commands (`auth status`, `clone`, `fork`, `new`, `status`, `pull`, `push`, `deploy`, `undeploy`, `domains`, `info`, `settings`, `list`, `versions`, `rollback`, `privacy`, `delete`) for structured output without interactive prompts.
  - Pass required flags explicitly when running non-interactively (e.g., `-t "<title>"`, `--access <Public|Private|Protected|Collaborators>`, `-m "<label>"`, `--yes`).
- **Working directory**:
  - Path-taking commands can run from the repository root targeting `src/`:
    - Clone an existing Pen: `npx cdpn clone <url> src/<demo-name>` (or `src/<group-name>/<demo-name>`)
    - Fork a Pen: `npx cdpn fork <url> src/<demo-name>`
    - Scaffold from a CodePen Template: `npx cdpn new src/<demo-name> --template "<id-or-title>"`
  - Folder-scoped commands (`status`, `pull`, `push`, `deploy`, `undeploy`, `domains`, `info`, `settings`, `versions`, `rollback`, `privacy`, `delete`, `open`) operate on the current working directory—run them with `Cwd` set to the specific demo folder (e.g., `src/<demo-name>/`).
  - Pushing an unlinked demo folder (without `.cdpn.json`) creates a new Pen on CodePen and writes `.cdpn.json` automatically.
- **Sync metadata files**:
  - Commit `.cdpn.json` (contains only Pen URL, ID, profile name, and last synced version ID—no secrets) and `.codepen/` inside each synced demo folder so sync state persists across machines.
  - Do not manually edit or remove `.cdpn.json`; let `cdpn` manage it (e.g., `npx cdpn delete` removes `.cdpn.json` cleanly when deleting the remote Pen).
  - Add an optional `.cdpnignore` inside a demo folder to exclude extra local-only files from syncing (`.cdpn.json`, `.cdpnignore`, `.git`, `node_modules`, and `.DS_Store` are ignored automatically).

## 5. Keeping the Demo Index Up to Date

Whenever you add, clone, fork, scaffold, push to CodePen for the first time, rename, move, or remove a demo, you **MUST** update **both**:

1. **`README.md`**:
   - Update the `## Demos` section with a link to `./src/<demo-name>/` or `./src/<group-name>/<demo-name>/`, a brief description, and an optional CodePen link (from `.cdpn.json`) when synced.
   - Keep grouped demos organized under a `### <Group Title>` heading, and standalone demos under `### Standalone` (or at the top level of `## Demos` if no groups exist yet).
2. **`src/index.html`**:
   - Add, update, or remove the demo card linking to `./<demo-name>/` or `./<group-name>/<demo-name>/` (relative to `src/`), plus the optional `.demo-codepen` link when synced via `.cdpn.json`.
   - Follow the semantic `<section>` and `<article class="demo-card">` templates documented in the comments of `src/index.html`.
   - Remove the `.empty-state` block once the first demo is added.

## 6. Code Quality & Local Verification

- Use clean, semantic HTML5 with `<!DOCTYPE html>`, `<meta charset="utf-8">`, `<meta name="viewport" content="width=device-width, initial-scale=1">`, and a descriptive `<title>`.
- Use safe DOM APIs (`textContent`, `document.createElement()`, `replaceChildren()`) instead of `innerHTML` with dynamic data.
- Keep demo code minimal, readable, and focused on illustrating the feature.
- Preview and verify demos locally using `npm start` or `npm run dev` (serves `src/` at `http://127.0.0.1:3000`), or pass a folder relative to `src/` (e.g., `npm start "scroll-triggered-animations/reveal-on-enter"`) to serve that demo directly as the root.
