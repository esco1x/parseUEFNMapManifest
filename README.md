# parseUEFNMapManifest

**Turn a Fortnite UEFN map code into plugin files** you can open in FModel or any Unreal asset viewer. Sign in with Epic, enter a map code, and the script downloads the map’s cooked content, reassembles it, and drops everything into a plugins folder—including `global.ucas` and `global.utoc` from your Fortnite install so the plugin files work out of the box.

*This project is not affiliated with, endorsed by, sponsored by, or connected to Epic Games, Fortnite, or UEFN.*
---

## What you need

- **Node.js** 18+
- **Fortnite installed** – The script needs your Fortnite game folder once (on first run). It uses:
  - **`Content\Paks`** – to copy `global.ucas` and `global.utoc` into the output folder.
  - **`Binaries\Win64`** – to copy the Oodle DLL (`oo2core_*_win64.dll`) into the project so it can decompress UEFN map chunks. The DLL is not included in this repo; the script copies it from your game.

---

## Quick start

```bash
git clone https://github.com/esco1x/parseUEFNMapManifest.git
cd parseUEFNMapManifest
npm install
node parseUEFNManifest.js
```

**First run:** the script will ask for:

1. **Fortnite game path** – The **FortniteGame** folder (e.g. `C:\Program Files\Epic Games\Fortnite\FortniteGame`). Do **not** point to the Paks folder; use the game root. Type the path, or type **`auto`** to try auto-detect.
2. **Plugins output folder** – Where to put the plugin files. Default is `./plugins`; press Enter to keep it or type another path.

Those choices are saved in `parseUEFNManifest.config.json`. The script also copies the Oodle DLL from `FortniteGame\Binaries\Win64` into the project folder so it can load it on future runs.

After that, you’ll get the Epic sign-in link → paste the auth code → enter the map code (e.g. `6155-1398-4059`). The script then downloads the manifest and chunks, reassembles the plugin files into your plugins folder, and copies `global.ucas` and `global.utoc` from your game’s `Content\Paks` into the same folder.

---

## Config file

`parseUEFNManifest.config.json` is created in the script directory and stores:

| Key | Description |
|-----|-------------|
| `fortniteGamePath` | Full path to the **FortniteGame** folder (e.g. `C:\Program Files\Epic Games\Fortnite\FortniteGame`). The script derives `Content\Paks` and `Binaries\Win64` from this. |
| `defaultPluginsDir` | Default output folder for plugin files (e.g. `C:\...\plugins`). |

You can edit this file to change paths. If you delete it or remove `fortniteGamePath`, the script will prompt you again on the next run.

---

## Usage

### By map code (normal use)

```bash
node parseUEFNManifest.js
```

Output goes to your configured plugins folder unless you override with `--out`.

### Override output folder

```bash
node parseUEFNManifest.js --out "C:\MyFolder\plugins"
```

### Chunk cache and debug

```bash
node parseUEFNManifest.js --chunks ./chunk-cache   # custom folder for downloaded chunks
node parseUEFNManifest.js --debug                  # extra logging if chunks fail
```

### Using a local manifest file

If you already have a manifest (e.g. `plugin.manifest`) and the CDN base URL:

```bash
node parseUEFNManifest.js plugin.manifest --base "https://...CDN.../" --out ./output
```

`--base` is required so the script can download chunks.

---

## What you get

In the output folder (default: `./plugins`):

- **plugin.pak**, **plugin.sig**, **plugin.ucas**, **plugin.utoc** – the map’s plugin files.
- **global.ucas**, **global.utoc** – copied from your Fortnite `Content\Paks` folder so the plugin files load correctly in FModel or other tools.

Chunks are cached in `./chunks` (or your `--chunks` path) so repeat runs don’t re-download everything.

Open the output folder in [FModel](https://fmodel.app/) to browse and export assets.

---

## Encrypted maps

Most (if not all) published UEFN maps are encrypted. The script fetches the decryption key from Epic when needed and uses the Oodle DLL (copied from your Fortnite `Binaries\Win64` folder) to decompress chunks. No need to download or place the DLL yourself.

---

## License

Use and modify as you like.
