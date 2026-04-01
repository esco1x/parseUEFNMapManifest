# parseUEFNMapManifest

Turn a Fortnite UEFN map code into cooked plugin files you can open in tools like [FModel](https://fmodel.app/).

The CLI signs in with Epic, resolves the correct build path, downloads the manifest/chunks, reassembles files, and writes them to an `output` layout.

*This project is not affiliated with, endorsed by, sponsored by, or connected to Epic Games, Fortnite, or UEFN.*

---

## Requirements

- Node.js 18+
- Fortnite installed (for:
  - `Content\Paks` -> copy `global.*` artifacts
  - `Binaries\Win64` -> copy `oo2core_*_win64.dll` for Oodle decompression)

---

## Quick start

```bash
git clone https://github.com/esco1x/parseUEFNMapManifest.git
cd parseUEFNMapManifest
npm install
node .
```

On first run, you will be prompted for:

1. **FortniteGame path** (or type `auto` for auto-detect)
2. **Default output folder** (default is `./output`)

Config is saved to `parseUEFNManifest.config.json`.

---

## Commands

### Interactive mode (normal)

```bash
node .
```

### Local manifest mode

```bash
node . <manifestPath> --base "<CDN_URL>" [--out <dir>] [--chunks <dir>] [--debug]
```

`--base` is required in local manifest mode.

---

## CLI options

```text
--out <dir>                 Output root (default from config, usually ./output)
--chunks <dir>              Override chunk cache directory
--engine-version <M.m.CL>   Override engine version used for CDN paths
--debug                     Extra debug logging/artifacts on failures
--fresh-login               Force a new Epic login flow
--no-save-tokens            Do not write/merge tokens to parseUEFNTokens.json
--help, -h                  Show help
```

For detailed built-in docs:

```bash
node . --help
node . --help output
node . help auth
```

---

## Output layout

Default output root is `./output` unless overridden/configured.

```text
output/
  Export/
    <pluginTag>.pak
    <pluginTag>.utoc
    <pluginTag>.ucas
    <pluginTag>.sig
    global.*                  (copied from Fortnite Paks when available)
  .data/
    chunks/<pluginTag>/
      <pluginTag>.manifest
      *.chunk
```

- `Export` contains final files for viewing tools.
- `.data/chunks/...` is per-map cache/manifest storage.

---

## Config + token files

- `parseUEFNManifest.config.json`
  - `fortniteGamePath`
  - `defaultOutputDir`
- `parseUEFNTokens.json`
  - saved Epic tokens unless `--no-save-tokens` is used

If config is missing/invalid, the CLI prompts again.

---

## Environment variables (advanced)

```text
UEFN_KEEP_RAW_MISSING=1   Write raw/encrypted bytes instead of zero-fill for missing chunk parts
UEFN_DECOMPRESS_WORKER=0  Disable decompression worker path
```

---

## Notes

- Encrypted maps are supported (module key is requested from Epic APIs when needed).
- Oodle DLL is loaded/copied from your Fortnite install; you do not need to ship one manually.

---
