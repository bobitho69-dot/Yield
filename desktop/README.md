# Yield for desktop

An [Electron](https://www.electronjs.org/) shell around the hosted Yield
workspace. One app that opens **Yield Code** (the agentic coder), **Yield Chat**,
and the **app builder** — with a native window, menu bar, and OS integration.

Because it loads the live web app, everything works exactly as it does in the
browser: GitHub OAuth, launching agents, MCP server config, version history, and
the full multi-model backend. Point it at any Yield deployment.

## Run it (development)

```bash
cd desktop
npm install
npm start                       # opens the app against the default deployment
YIELD_URL=https://your-yield.workers.dev npm start   # or your own deployment
```

`Cmd/Ctrl+1..4` jump between Code, Chat, Builder, and Security.

## Build installers

Builds are **platform-native** — build the `.dmg` on macOS and the `.exe` on
Windows (electron-builder can't cross-compile signed installers).

```bash
npm run dist:mac    # → release/Yield-<version>.dmg          (run on macOS)
npm run dist:win    # → release/Yield-setup-<version>.exe     (run on Windows)
npm run dist        # current platform's default target
```

Output lands in `desktop/release/`.

### Icons

Drop your app icons in `desktop/build/`:

- `build/icon.icns` — macOS (1024×1024 source recommended)
- `build/icon.ico` — Windows (256×256)

electron-builder falls back to the default Electron icon if these are absent, so
builds still succeed without them.

### Signing & notarization (recommended for distribution)

Unsigned apps trigger Gatekeeper (macOS) and SmartScreen (Windows) warnings.

- **macOS:** set an Apple Developer ID and enable notarization. With
  electron-builder, provide `CSC_LINK`/`CSC_KEY_PASSWORD` (the `.p12`) and
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` env vars, then
  `npm run dist:mac`.
- **Windows:** provide a code-signing certificate via `CSC_LINK`/
  `CSC_KEY_PASSWORD`, then `npm run dist:win`.

See the [electron-builder code signing docs](https://www.electron.build/code-signing)
for the full setup.

## Publishing

Push the built `.dmg` and `.exe` to a GitHub Release. The
[Download page](../public/download.html) links to
`releases/latest`, so a new release is picked up automatically.

## Configuration

| Env var     | Default                              | Purpose                                  |
| ----------- | ------------------------------------ | ---------------------------------------- |
| `YIELD_URL` | `https://yield.example.workers.dev`  | Which Yield deployment the app loads.    |

Edit `APP_URL` in `main.js` to change the built-in default before packaging.
