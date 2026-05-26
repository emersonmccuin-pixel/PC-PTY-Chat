# Desktop Build Runbook

## Fresh Clone

Prerequisites:

- Node 22
- pnpm 10.33.0
- Git
- Claude Code CLI, authenticated, for end-to-end product use
- Windows: Visual Studio Build Tools if native module prebuilds are unavailable
- macOS: Xcode Command Line Tools

Verify a clone:

```powershell
pnpm install --frozen-lockfile
pnpm run ci
```

Run the dev stack:

```powershell
pnpm dev
pnpm --filter @pc/web dev
pnpm desktop:dev
```

`pnpm dev` starts the API and channel server. The Vite frontend is separate.

## Local Packaging

Unpacked desktop smoke:

```powershell
pnpm desktop:dist:dir
```

Windows installer:

```powershell
pnpm desktop:dist:win
```

macOS unsigned directory smoke:

```bash
pnpm desktop:dist:mac:dir
```

macOS signed and notarized installer:

```bash
pnpm desktop:dist:mac
```

Artifacts land in `apps/desktop/release/`. Staged app resources land in `apps/desktop/staging/`. Both paths are ignored.

## GitHub Actions

`CI` runs on Windows and macOS for every pull request and push to `main`:

- frozen install
- repo typecheck
- unit tests
- web build
- Playwright spec typecheck

`Desktop Package Smoke` runs on Windows and macOS for desktop-relevant changes:

- frozen install
- desktop typecheck
- Playwright spec typecheck
- unpacked Electron package build

`Desktop Installers` is manual. Run it from Actions with:

- `ref`: git ref to package, default `main`
- `release_tag`: optional tag such as `v0.0.1`; if present, artifacts are attached to a GitHub Release

## Required Secrets

Windows signing is optional:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`, required when `WIN_CSC_LINK` is set

macOS release builds require signing and notarization:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY_P8`

Do not commit certificates, API keys, provisioning profiles, local databases, or generated installers.

## Notes

- Windows installers can be built unsigned, but users may see SmartScreen warnings.
- macOS installers intended for normal distribution must be signed and notarized.
- `node-pty` and `better-sqlite3` are native modules; packaging rebuilds them for Electron.
- If native rebuilds fail locally, verify Node 22, pnpm 10.33.0, Python/build tools, and that the repo path does not confuse native tooling.
