# Web Platform Demos

A collection of self-contained, vanilla HTML, CSS, and JavaScript demos exploring modern and cutting-edge web platform features.

## Quick Start

Start the local static dev server (requires Node.js 20+, no `npm install` needed):

```sh
# Build src/demos.json, watch src/ for changes, and serve src/
npm start
# or: npm run dev

# Serve a specific folder inside src/ as the root (e.g. src/sta/demo1/)
npm start "sta/demo1"
# or: npm run dev "sta/demo1"

# Build static src/demos.json once (for static hosting / CI deployments)
npm run build
# or watch without starting the server:
npm run build:watch
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) to browse. You can override the port with `PORT=8080 npm start`. To deploy statically, run `npm run build` and publish the `src/` directory (`src/demos.json` is generated and gitignored).

## Syncing with CodePen

Syncing with CodePen is optional. This repository includes bulk sync npm scripts (`cdpn:sync`, `cdpn:pull`, `cdpn:push`) backed by [`scripts/sync-codepen.mjs`](./scripts/sync-codepen.mjs), which uses [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn`) under the hood to keep demos in `src/` synced with CodePen 2.0.

### 1. Install, configure, and authenticate (one-time setup)

1. Install the `codepen-commander` package:
   ```sh
   npm install
   ```
2. Copy [`config.json.example`](./config.json.example) to `config.json` and set your CodePen profile name (`codepen_user`) and default visibility for newly created Pens (`codepen_default_visibility`: `Public`, `Private`, `Protected`, or `Collaborators`):
   ```sh
   cp config.json.example config.json
   ```
3. Save your CodePen API v2 key to `~/.cdpn` (never committed to this repository) under the matching profile name:
   ```sh
   npx cdpn auth login <codepen_user>
   npx cdpn auth status
   ```

### 2. Sync demos with CodePen

```sh
# Two-way sync across all demos in src/ (creates unlinked Pens, pushes local edits, pulls remote updates)
npm run cdpn:sync

# Push local changes and create new Pens for unlinked demos
npm run cdpn:push

# Pull remote updates from CodePen for linked demos
npm run cdpn:pull
```

Useful flags (passed through `--`):

```sh
# Preview what would change without pushing or pulling
npm run cdpn:sync -- --dry-run
npm run cdpn:push -- --dry-run
npm run cdpn:pull -- --dry-run

# Force-pull all linked demos (overwrites local changes and refreshes .cdpn.json)
npm run cdpn:pull -- --force
```

Each synced demo stores non-secret sync metadata in `.cdpn.json` (plus optional `.codepen/pen.config.json`). Keep `.cdpn.json` committed so the demo stays linked across machines. Add an optional `.cdpnignore` file inside a demo folder to exclude local-only files from syncing.

Since CodePen Commander is used under the hood, you can also run `npx cdpn` directly for individual operations (such as `clone`, `fork`, `new`, `deploy`, `open`, or resolving sync conflicts inside a specific demo folder).

## Structure & Conventions

The browseable index page and all demos live inside `src/`. Each demo lives in its own descriptively named `kebab-case` subfolder—either directly under `src/` (standalone) or inside a topic group folder (for related demos):

```text
.
├── src/
│   ├── index.html              # Browseable demo index
│   ├── styles.css              # Styles for the index page
│   ├── scripts.js              # Loads ./demos.json and renders the index page
│   ├── demos.json              # Generated static manifest (gitignored)
│   ├── <standalone-demo>/
│   │   ├── index.html
│   │   ├── styles.css          # optional
│   │   ├── scripts.js          # optional
│   │   ├── .cdpn.json          # CodePen sync metadata (when linked via cdpn)
│   │   ├── .codepen/           # optional CodePen 2.0 Pen config
│   │   └── assets/             # optional local images, media, or external scripts
│   └── scroll-triggered-animations/
│       ├── <demo-one>/
│       │   ├── index.html
│       │   ├── styles.css
│       │   └── .cdpn.json
│       └── <demo-two>/
│           ├── index.html
│           ├── styles.css
│           └── scripts.js
├── AGENTS.md                   # Agent instructions
├── .mwgrc                      # Modern Web Guidance configuration
├── config.json.example         # Example CodePen sync configuration (copy to config.json)
├── package.json                # Build, dev server, and CodePen sync scripts
└── scripts/
    ├── build-json.mjs          # Builds & watches static src/demos.json
    ├── serve.mjs               # Local static server serving src/
    └── sync-codepen.mjs        # Bulk CodePen sync script (uses CodePen Commander)
```

- **Self-contained**: Every demo folder contains its own `index.html`, optional `styles.css`, optional `scripts.js`, and any required assets (images, fonts, media, or third-party scripts). No shared index styles or cross-demo imports.
- **Vanilla JavaScript**: Standard browser HTML, CSS, and JS only—no frameworks or build steps inside demos.
- **Native-first**: Demos focus on pure native web platform APIs without polyfills or legacy fallbacks unless explicitly needed.

## Modern Web Guidance (Required)

This project requires the [`modern-web-guidance`](https://github.com/GoogleChrome/modern-web-guidance) agent skill pack, installed **globally** for your coding agent(s) rather than locally in this repository.

Project configuration in `.mwgrc` opts into cutting-edge guides (`allowOriginTrials: true`, `allowVolatileFeatures: true`, `baseline: "limited"`).

To install or update the skill globally:

```sh
npx modern-web-guidance@latest install -g
npx modern-web-guidance@latest update
```

See the [`modern-web-guidance` README](https://github.com/GoogleChrome/modern-web-guidance#readme) for agent-specific plugin installation methods, and [`AGENTS.md`](./AGENTS.md) for the full set of agent instructions.

## Demos

<!--
  src/index.html populates automatically from src/ subfolders (reading each demo's <title>,
  optional <meta name="description">, and optional .cdpn.json). Keep this Markdown list updated
  whenever demos are added, cloned, synced, renamed, moved, or removed.

  Example format:

  ### Scroll-Triggered Animations
  - [`reveal-on-enter`](./src/scroll-triggered-animations/reveal-on-enter/) ([CodePen](https://codepen.io/username/pen/abcde)) — Fade and slide elements in when entering the viewport.

  ### Standalone
  - [`popover-menu`](./src/popover-menu/) — Native popover menu positioned with CSS Anchor Positioning.
-->

_No demos yet._
