# {{PROJECT_NAME}}

{{PROJECT_SUBTITLE}}

Powered by and synced with CodePen 2.0 via [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn`).

## Quick Start

Install dependencies (requires Node.js 20+) and start the local dev server:

```sh
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) to browse.

- Serve a specific demo folder directly as root: `npx cdpn serve src/group/demo`
- Override the port: `PORT=8080 npm start` (or `npm start -- --port 8080`)
- Open automatically in your browser: `npm start -- --open`
- Build a static deployable site into `dist/`: `npm run build` (or `npm run build:watch`)

## Syncing with CodePen

This repository syncs demos in `src/` with CodePen 2.0 directly via [CodePen Commander](https://www.npmjs.com/package/codepen-commander). Run commands using `npx cdpn <command>`, `npm run cdpn -- <command>`, or bare `cdpn <command>` if you install it globally (`npm install -g codepen-commander`).

### One-time setup

Authenticate your CodePen API v2 key (stored in `~/.cdpn`, never committed):

```sh
npx cdpn auth login
npx cdpn auth status
```

### Creating & cloning demos

Every demo folder in `src/` must contain a `.cdpn.json` file to be discovered by `cdpn serve`, `cdpn build`, and batch commands:

```sh
npx cdpn init src/group/my-demo            # Initialize an existing local demo (.cdpn.json + .codepen/)
npx cdpn new src/group/my-demo             # Scaffold a new 2.0 Pen from a CodePen Template
npx cdpn clone <url> src/group/my-demo     # Clone an existing Pen into src/
npx cdpn fork <url> src/group/my-demo      # Fork one of your own 2.0 Pens into src/
```

### Batch & single-Pen commands

Use `all` to walk all discovered `.cdpn.json` demos in subdirectories (or pass a specific demo directory path):

```sh
npx cdpn status all                        # Check sync status across all demos in src/
npx cdpn sync all                          # Two-way sync across all demos in src/
npx cdpn push all                          # Push local edits and create Pens for unlinked demos
npx cdpn pull all                          # Pull remote updates for linked demos
npx cdpn delete all                        # Delete linked Pens on CodePen (moves to Deleted Items)
npx cdpn unlink all                        # Unlink local demos without touching CodePen
```

Pass `--dry-run` to preview changes safely, target a single demo by path, or run from inside a `src/<group>/` subfolder to scope `all` to that group:

```sh
npx cdpn sync all --dry-run
npx cdpn pull src/scroll-driven-animations/coverflow
```

Other individual Pen commands (`open`, `deploy`, `undeploy`, `domains`, `info`, `privacy`, `versions`, `rollback`, `restore`, `list`, `shell`, etc.) work from the repo root or inside any `src/<demo>/` folder.

{{DEPLOYMENT_SECTION}}

## Updating `codepen-commander`

```sh
npm update codepen-commander
```

## Demos

<!-- Add your demos below as you create them inside src/ -->

_No demos yet._
