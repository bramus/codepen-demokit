# Web Platform Demos

A collection of self-contained, vanilla HTML, CSS, and JavaScript demos exploring modern and cutting-edge web platform features.

## Quick Start

Start the local static dev server (requires Node.js 20+, no `npm install` needed):

```sh
# Serve src/ (the full demo index)
npm start
# or: npm run dev

# Serve a specific folder inside src/ as the root (e.g. src/sta/demo1/)
npm start "sta/demo1"
# or: npm run dev "sta/demo1"
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) to browse. You can override the port with `PORT=8080 npm start`.

## Syncing with CodePen (`codepen-commander`)

Syncing with CodePen is optional. If you want to clone existing Pens into `src/` or sync local demos back and forth with CodePen 2.0, this project uses [`codepen-commander`](https://www.npmjs.com/package/codepen-commander) (`cdpn`).

### 1. Install and authenticate (one-time setup)

Install `codepen-commander` and save your CodePen API v2 key to `~/.cdpn` (never committed to this repository):

```sh
npm install
npx cdpn auth login
npx cdpn auth status
```

### 2. Clone, fork, or scaffold a demo into `src/`

```sh
# Clone an existing CodePen Pen into src/
npx cdpn clone https://codepen.io/<user>/pen/<slug> src/<demo-name>
npx cdpn clone https://codepen.io/<user>/pen/<slug> src/<group-name>/<demo-name>

# Fork one of your Pens into src/
npx cdpn fork https://codepen.io/<user>/pen/<slug> src/<demo-name>

# Scaffold a new 2.0 Pen from a CodePen Template into src/
npx cdpn new src/<demo-name>
```

### 3. Sync changes between local files and CodePen

Run sync commands from inside the demo's folder (e.g. `cd src/<demo-name>`):

```sh
npx cdpn status                   # Compare local files against CodePen
npx cdpn pull                     # Pull remote updates from CodePen
npx cdpn push -m "Tweak styles"   # Push local edits (or create & link a new Pen if unlinked)
npx cdpn deploy                   # Push and deploy to CodePen Hosting
npx cdpn open                     # Open the Pen in CodePen (--preview / --deploy)
```

Each synced demo stores non-secret sync metadata in `.cdpn.json` (plus optional `.codepen/pen.config.json`). Keep `.cdpn.json` committed so the demo stays linked across machines. Add an optional `.cdpnignore` file inside a demo folder to exclude local-only files from syncing.

## Structure & Conventions

The browseable index page and all demos live inside `src/`. Each demo lives in its own descriptively named `kebab-case` subfolder—either directly under `src/` (standalone) or inside a topic group folder (for related demos):

```text
.
├── src/
│   ├── index.html              # Browseable demo index (auto-populated from src/ subfolders)
│   ├── styles.css              # Styles for the index page
│   ├── scripts.js              # Dynamic demo loader for the index page
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
├── package.json                # Dev server and codepen-commander scripts
└── scripts/
    └── serve.mjs               # Local static server serving src/ and /demos.json
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
