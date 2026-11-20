# `codepen-demokit`

A zero-config npm framework for organizing, previewing, statically deploying, and syncing collections of self-contained web demos with **CodePen 2.0**.

Powered by [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn`) under the hood, `codepen-demokit` lets you keep your demos in their own Git repository while getting an automatically generated demo index, a local dev server with live manifest rebuilding, static `dist/` builds, bulk CodePen syncing, and clean one-command framework upgrades (`npm update codepen-demokit`).

## Features

- **Core CodePen 2.0 Sync**: Built-in bulk `sync`, `push`, `pull`, and `delete` (with `--keep-info`) commands scoped to all of `src/`, a topic group/subgroup, or a single demo—backed by CodePen Commander (`codepen-commander` is included as a direct dependency).
- **Auto-Generated Demo Index**: Recursively scans `src/` subfolders for demos (standalone, grouped, and arbitrarily nested subgroups), reading each demo's `<title>`, optional `<meta name="description">`, and `.cdpn.json` CodePen link.
- **Updatable Index UI Shell**: Ships a modern, accessible light/dark index page (`shell/`) that updates automatically when you upgrade `codepen-demokit`—and can be customized via `config.json` or overridden selectively in `src/`.
- **Zero-Config Local Dev Server**: `start` builds `dist/demos.json`, watches `src/` to rebuild it on the fly, serves demos directly from `src/`, and lets you preview a single demo subfolder as root.
- **Static Deployment Ready**: `build` outputs a self-contained `dist/` folder ready for GitHub Pages, Netlify, Cloudflare Pages, Vercel, or any static host (stripping `.cdpn.json` and dotfiles automatically).
- **Separate Git Repos**: Your demos live in their own clean Git repo and depend on `codepen-demokit` via `package.json`.

---

## Getting Started (New Demos Repo)

Requires **Node.js 20+**.

### 1. Scaffold a new demos repository

```sh
npx codepen-demokit init
```

The interactive initializer prompts for:

1. **Project name** (default: `"My CodePen Demos"`)
2. **Directory** (defaults to the slugified project name, e.g. `my-codepen-demos`)
3. **CodePen username** (optional, stored in `config.json`)
4. **Default Pen visibility** (`Private`, `Public`, `Protected`, or `Collaborators`; default: `Private`)

Then enter the created folder, initialize Git, and install dependencies:

```sh
cd my-codepen-demos
git init
npm install
```

This creates a clean consumer repository:

```text
my-codepen-demos/
├── src/                        # Put your self-contained demo folders here
├── config.json                 # Site title/subtitle + CodePen profile & default visibility
├── config.json.example         # Example configuration
├── AGENTS.md                   # Demo-authoring agent instructions
├── .gitignore                  # Ignores node_modules/, dist/, .cdpn
├── package.json                # Depends on codepen-demokit + wires up npm scripts
└── README.md
```

### 2. Review `config.json` and authenticate with CodePen

`init` populates `config.json` from your answers—you can edit it anytime to adjust your index metadata or CodePen profile:

```json
{
  "site": {
    "title": "My CodePen Demos",
    "subtitle": "A collection of self-contained web demos.",
    "footer": "Powered by codepen-demokit."
  },
  "codepen": {
    "user": "your-codepen-username",
    "defaultVisibility": "Private"
  }
}
```

Then save your CodePen API v2 key to `~/.cdpn` (never committed to your repository) using CodePen Commander:

```sh
npx cdpn auth login your-codepen-username
npx cdpn auth status
```

### 3. Add demos under `src/` and start developing

Each demo lives in its own self-contained `kebab-case` folder inside `src/`—either standalone, inside a topic group, or inside nested subgroups:

```text
src/
├── popover-menu/                                # Standalone demo
│   ├── index.html
│   └── styles.css
├── scroll-driven-animations/                    # Topic group
│   └── coverflow/
│       ├── index.html
│       ├── styles.css
│       └── .cdpn.json                           # Committed CodePen sync metadata
└── view-transitions/                            # Nested topic groups
    ├── cross-document/
    │   └── off-the-beaten-path/
    │       └── index.html
    └── same-document/
        └── sortable/
            └── index.html
```

Start the dev server:

```sh
# Build dist/demos.json, watch src/, and serve the full demo index at http://127.0.0.1:3000
npm start

# Serve a single demo folder directly as root
npm start "view-transitions/same-document/sortable"

# Use a custom port
PORT=8080 npm start
```

---

## Syncing with CodePen

CodePen syncing is a core feature of `codepen-demokit` and uses [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn`) under the hood. All bulk commands read `codepen.user` and `codepen.defaultVisibility` from `config.json` (and exit with a warning if `config.json` or required CodePen settings are missing).

```sh
# Two-way sync across all demos in src/ (creates unlinked Pens, pushes local edits, pulls remote updates)
npm run cdpn:sync

# Push local changes and create new Pens for unlinked demos
npm run cdpn:push

# Pull remote updates from CodePen for linked demos
npm run cdpn:pull

# Delete all linked Pens on CodePen (passes --keep-info to retain Pen metadata in .cdpn.json for the next push)
npm run cdpn:delete
```

### Scoping & Flags

Pass an optional relative folder inside `src/` (a group, subgroup, or single demo) and/or flags through `--`:

```sh
# Scope any command to a group, subgroup, or single demo
npm run cdpn:push -- scroll-driven-animations
npm run cdpn:delete -- view-transitions/same-document
npm run cdpn:pull -- view-transitions/same-document/sortable

# Preview without modifying anything on CodePen or disk
npm run cdpn:sync -- --dry-run
npm run cdpn:push -- scroll-driven-animations --dry-run
npm run cdpn:delete -- view-transitions/same-document --dry-run

# Force-pull all linked demos (overwrites local changes and refreshes .cdpn.json)
npm run cdpn:pull -- --force
```

Each synced demo stores non-secret sync metadata in `.cdpn.json` (plus optional `.codepen/pen.config.json`). Keep `.cdpn.json` committed in your demos repo so sync state persists across machines. Add an optional `.cdpnignore` file inside a demo folder to exclude local-only files from syncing.

Because CodePen Commander is installed alongside `codepen-demokit`, you can also invoke `npx cdpn` directly for individual Pen commands (`clone`, `fork`, `new`, `deploy`, `open`, or manually resolving conflicts inside a specific demo folder).

---

## Static Builds & Deployment

Generate a completely static, self-contained build in `dist/`:

```sh
npm run build
# or rebuild continuously on src/ and config.json changes:
npm run build:watch
```

`build` copies all non-hidden demo files from `src/` into `dist/` (automatically excluding `.cdpn.json`, `.cdpnignore`, `.codepen/`, `.DS_Store`, and other dotfiles), layers the framework's default index shell (`index.html`, `styles.css`, `scripts.js`) with your `config.json` `site` metadata, and generates `dist/demos.json`.

Deploy the `dist/` directory to any static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel, etc.) with `npm run build` as your build command.

---

## Customizing the Index Page

- **Title, subtitle, and footer**: Set `site.title`, `site.subtitle`, and `site.footer` in `config.json`.
- **Full UI overrides**: If you want custom markup, styling, or scripts for the index page, create `src/index.html`, `src/styles.css`, and/or `src/scripts.js`. Any file placed at `src/` root automatically overrides the corresponding framework shell file in both `start` and `build`, while non-overridden files continue receiving framework updates.

---

## Configuration Reference (`config.json`)

| Key | Required | Description |
| :--- | :---: | :--- |
| `site.title` | No | Page `<title>` and `<h1>` heading (default: `"My CodePen Demos"`). |
| `site.subtitle` | No | Intro subtitle shown under the heading. |
| `site.footer` | No | Footer text shown at the bottom of the index page. |
| `codepen.user` | For `cdpn:*` | CodePen Commander profile name (`npx cdpn auth login <user>`). |
| `codepen.defaultVisibility` | For `cdpn:*` | Default `--access` for newly created Pens: `Public`, `Private`, `Protected`, or `Collaborators`. |

---

## CLI Reference

You can invoke the CLI directly via `npx codepen-demokit <command>` or through your project's `npm` scripts:

| Command | Description |
| :--- | :--- |
| `codepen-demokit init` | Interactively prompt for project & CodePen details and scaffold a new demos repository without overwriting existing files. |
| `codepen-demokit start [folder] [--port <port>]` | Build `dist/demos.json`, watch `src/`, and start the local static dev server (alias: `dev`). |
| `codepen-demokit build [--watch]` | Build the static deployable site into `dist/` (optionally watching `src/` and `config.json`). |
| `codepen-demokit cdpn <sync\|pull\|push\|delete> [folder] [--dry-run] [--force]` | Bulk sync demos with CodePen via CodePen Commander. |

---

## Upgrading `codepen-demokit`

In your demos repository, update the framework dependency like any npm package to get CLI fixes, new CodePen Commander integrations, and index shell improvements:

```sh
npm update codepen-demokit
# or pin to the latest major/minor release:
npm install -D codepen-demokit@latest
```
