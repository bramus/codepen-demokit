# My CodePen Demos

A collection of self-contained web demos organized with [`codepen-demokit`](https://www.npmjs.com/package/codepen-demokit) and synced with CodePen 2.0.

## Quick Start

Install dependencies (requires Node.js 20+) and start the local dev server:

```sh
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) to browse.

- Serve a specific demo folder directly as root: `npm start "group/demo"`
- Override the port: `PORT=8080 npm start`
- Build a static deployable site into `dist/`: `npm run build`

## Syncing with CodePen

This repository syncs demos in `src/` with CodePen 2.0 via `codepen-demokit` (powered by [CodePen Commander](https://www.npmjs.com/package/codepen-commander) under the hood).

### One-time setup

1. Edit [`config.json`](./config.json) (see [`config.json.example`](./config.json.example)) and set `codepen.user` and `codepen.defaultVisibility`.
2. Authenticate your CodePen API v2 key (stored in `~/.cdpn`, never committed):
   ```sh
   npx cdpn auth login <your-codepen-username>
   npx cdpn auth status
   ```

### CodePen commands

```sh
npm run cdpn:sync      # Two-way sync across src/
npm run cdpn:push      # Push local edits and create Pens for unlinked demos
npm run cdpn:pull      # Pull remote updates for linked demos
npm run cdpn:delete    # Delete linked Pens on CodePen (retains Pen info in .cdpn.json)
npm run cdpn:clone -- <url> [folder]  # Clone a Pen into src/ via `cdpn clone`
npm run cdpn:new -- [folder]          # Scaffold a new Pen in src/ via `cdpn new`
```

Scope any bulk sync command to a group, subgroup, or single demo folder inside `src/`, and pass `--dry-run` to preview:

```sh
npm run cdpn:push -- my-group --dry-run
npm run cdpn:pull -- my-group/my-demo
```

For individual Pen commands (`open`, `status`, `fork`, `deploy`, `list`, etc.), run `npx cdpn <command>` (works from the repo root or inside any `src/<demo>/` folder) or `npm run cdpn -- <command>`—or optionally install CodePen Commander globally (`npm install -g codepen-commander`) to run bare `cdpn` directly.

## Updating `codepen-demokit`

```sh
npm update codepen-demokit
```

## Demos

<!-- Add your demos below as you create them inside src/ -->

_No demos yet._
