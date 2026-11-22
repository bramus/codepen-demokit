# `codepen-demokit`

An interactive starter pack for scaffolding self-contained web demo repositories—like [`bramus/web-platform-demos`](https://github.com/bramus/web-platform-demos)—powered directly by [CodePen Commander](https://www.npmjs.com/package/codepen-commander) (`cdpn`).

Because `codepen-commander` (`^1.4.0`) handles local serving, static site builds, CodePen `classic` & `packages` Blocks, customizable index shells, and batch CodePen 2.0 syncing out of the box, `codepen-demokit` scaffolds a clean standalone repository that depends **only** on `codepen-commander`—with no extra runtime framework layer or `config.json` to maintain.

## Getting Started

Requires **Node.js 20+**.

### 1. Scaffold a new demos repository

```sh
npx codepen-demokit
# (or: npx codepen-demokit init)
```

The interactive scaffolder prompts for:

1. **Project name** (default: `"My CodePen Demos"`)
2. **Site subtitle** (default: `"A collection of self-contained web demos."`)
3. **Directory** (defaults to the slugified project name, e.g. `my-codepen-demos`, or `.` for the current folder)
4. **Default visibility for new Pens** (`Private`, `Public`, `Protected`, or `Collaborators`; default: `Private` — written into `AGENTS.md`)
5. **GitHub Pages deploy workflow** (optional `.github/workflows/deploy.yml`; default: `Yes`)

After generating the project files, `codepen-demokit` checks whether CodePen Commander is already authenticated (`cdpn auth status --offline`). If not, it offers to launch `cdpn auth login` immediately so you can link your CodePen API v2 key (`~/.cdpn`) on the spot.

### 2. What gets created

```text
my-codepen-demos/
├── .github/
│   └── workflows/
│       └── deploy.yml          # Optional GitHub Pages build & deploy workflow
├── .gitignore                  # Ignores node_modules/, dist/, .cdpn
├── AGENTS.md                   # Demo-authoring & cdpn agent instructions
├── README.md                   # Repo documentation & demo index
├── package.json                # Depends only on codepen-commander (^1.4.0)
└── src/
    └── .gitkeep                # Put your self-contained demo folders here
```

The generated `package.json` wires up `codepen-commander` directly with your chosen `--title` and `--subtitle`:

```json
{
  "scripts": {
    "start": "cdpn serve src --title \"My CodePen Demos\" --subtitle \"A collection of self-contained web demos.\"",
    "dev": "cdpn serve src --title \"My CodePen Demos\" --subtitle \"A collection of self-contained web demos.\"",
    "build": "cdpn build src --out ../dist --yes --title \"My CodePen Demos\" --subtitle \"A collection of self-contained web demos.\"",
    "build:watch": "cdpn build src --out ../dist --yes --watch --title \"My CodePen Demos\" --subtitle \"A collection of self-contained web demos.\"",
    "cdpn": "cdpn"
  },
  "devDependencies": {
    "codepen-commander": "^1.4.0"
  }
}
```

Existing files are never overwritten (`[SKIPPED]`), making it safe to run in an existing folder.

### 3. Install dependencies and start developing

```sh
cd my-codepen-demos
git init
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) to browse your demos.

---

## Working in Your Generated Repo

Once scaffolded, your repository uses [`codepen-commander`](https://www.npmjs.com/package/codepen-commander) (`cdpn`) directly:

### Creating & organizing demos

Every demo lives in its own self-contained `kebab-case` folder inside `src/` (standalone, grouped, or arbitrarily nested) and contains a `.cdpn.json` file so `cdpn serve`, `cdpn build`, and batch commands discover it:

```sh
npx cdpn init src/group/my-demo            # Initialize an existing local demo (.cdpn.json + .codepen/)
npx cdpn new src/group/my-demo             # Scaffold a new 2.0 Pen from a CodePen Template
npx cdpn clone <url> src/group/my-demo     # Clone an existing Pen into src/
npx cdpn fork <url> src/group/my-demo      # Fork one of your own 2.0 Pens into src/
```

### Local preview & static builds

```sh
npm start                                  # Serve src/ with live in-memory demos.json at http://127.0.0.1:3000
npm start -- --open                        # Start dev server and open in your browser
PORT=8080 npm start                        # Override the local port
npx cdpn serve src/group/my-demo           # Serve a single demo folder directly as root
npm run build                              # Build static deployable site into dist/
npm run build:watch                        # Rebuild dist/ automatically on changes
```

`cdpn serve` and `cdpn build` automatically support CodePen's `classic` and `packages` blocks, strip hidden files (`.cdpn.json`, `.codepen/`, etc.) from `dist/`, and let you customize the index shell via `src/index.html` / `src/styles.css` / `src/scripts.js` or `npx cdpn shell`.

### Syncing with CodePen 2.0

Authenticate once (keys are stored in `~/.cdpn` with `0600` permissions, never committed):

```sh
npx cdpn auth login
npx cdpn auth status
```

Run batch commands across all discovered demos with `all`, or target a single demo path:

```sh
npx cdpn status all                        # Check sync status across all demos in src/
npx cdpn sync all                          # Two-way sync across all demos in src/
npx cdpn push all                          # Push local edits and create Pens for unlinked demos
npx cdpn pull all                          # Pull remote updates for linked demos
npx cdpn delete all                        # Delete linked Pens on CodePen (moves to Deleted Items)
npx cdpn unlink all                        # Unlink local demos without touching CodePen
```

Pass `--dry-run` to preview changes safely, or run inside a `src/<group>/` subfolder to scope `all` to that group.

### Deploying

- **GitHub Pages**: If you included `.github/workflows/deploy.yml`, enable **Settings → Pages → Source: GitHub Actions** and push to `main`.
- **Any static host**: Run `npm run build` and publish the `dist/` directory (Netlify, Cloudflare Pages, Vercel, etc.).

### Keeping up to date

Because your generated repo depends only on `codepen-commander`, update everything with:

```sh
npm update codepen-commander
```

---

## Migrating from `codepen-demokit` v1

In v1, `codepen-demokit` bundled its own dev server, static builder, CodePen Blocks compiler, shell UI, `config.json`, and bulk sync wrappers. Those capabilities now live natively inside `codepen-commander` (`^1.4.0`):

| Former `codepen-demokit` command | Replacement in `codepen-commander` (`^1.4.0`) |
| :--- | :--- |
| `codepen-demokit start [folder]` | `cdpn serve src` (or `cdpn serve src/<folder>`) |
| `codepen-demokit build [--watch]` | `cdpn build src --out ../dist --yes [--watch]` |
| `codepen-demokit cdpn <sync\|push\|pull\|delete>` | `cdpn <sync\|push\|pull\|delete> all` |
| `codepen-demokit cdpn clone ...` | `cdpn clone <url> src/<folder>` |
| `codepen-demokit cdpn new ...` | `cdpn new src/<folder>` |
| `config.json` (`site.title`, `site.subtitle`) | `--title` and `--subtitle` flags in `package.json` scripts |
| `config.json` (`codepen.user`) | Native `~/.cdpn` profiles via `cdpn auth login` / `cdpn auth default` |

Note that `cdpn serve`, `cdpn build`, and `cdpn <cmd> all` discover only demo folders containing a `.cdpn.json` file; run `npx cdpn init src/<path-to-demo>` for any local demos that don't have one yet.

---

## CLI Reference

```text
Usage: codepen-demokit [init] [options]

Commands:
  init            Interactively scaffold a new demos repository (default)

Options:
  -h, --help      Show this help message
  -v, --version   Show version number
```
