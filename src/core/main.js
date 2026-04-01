const fs = require('fs');
const path = require('path');
const { ROOT } = require('./paths');
const { initOodle } = require('./oodle');
const { ensureConfig, getPaksPath, copyPakArtifacts } = require('./config');
const { setFortniteUaBuildFromResolvedVersion } = require('./userAgent');
const { parseEngineVersionString, tryReadEngineVersionFromPaksDir } = require('./epic');
const { parseUEFNManifest } = require('./manifestParse');
const { downloadAll } = require('./download');
const { reassemble } = require('./reassemble');
const { runFromApi } = require('./runFromApi');

function sanitizeName(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function snapshotExportFiles(exportRoot) {
  const out = new Set();
  if (!fs.existsSync(exportRoot)) return out;
  for (const name of fs.readdirSync(exportRoot)) out.add(name);
  return out;
}

function renamePluginArtifacts(exportRoot, pluginTag, beforeSet) {
  if (!fs.existsSync(exportRoot)) return;
  const exts = ['.pak', '.utoc', '.ucas', '.sig'];
  const used = new Set();
  for (const ext of exts) {
    let index = 1;
    const matches = [];
    for (const name of fs.readdirSync(exportRoot)) {
      if (beforeSet && beforeSet.has(name)) continue;
      const full = path.join(exportRoot, name);
      if (!fs.statSync(full).isFile()) continue;
      if (path.extname(name).toLowerCase() !== ext) continue;
      if (/^global\./i.test(name)) continue;
      matches.push(name);
    }
    for (const name of matches) {
      let nextName = `${pluginTag}${ext}`;
      while (used.has(nextName) || (fs.existsSync(path.join(exportRoot, nextName)) && nextName !== name)) {
        index++;
        nextName = `${pluginTag}_${index}${ext}`;
      }
      if (name !== nextName) fs.renameSync(path.join(exportRoot, name), path.join(exportRoot, nextName));
      used.add(nextName);
    }
  }
}

function listNewExportFiles(exportRoot, beforeSet) {
  if (!fs.existsSync(exportRoot)) return [];
  return fs
    .readdirSync(exportRoot)
    .filter((name) => (!beforeSet || !beforeSet.has(name)))
    .filter((name) => {
      try {
        return fs.statSync(path.join(exportRoot, name)).isFile();
      } catch (_) {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

function printHelp(topicRaw) {
  const topic = String(topicRaw || '').trim().toLowerCase();
  const exe = 'node .';

  function section(title, body) {
    return `${title}\n${'-'.repeat(title.length)}\n${body.trimEnd()}\n`;
  }

  const topics = {
    overview: () => [
      section(
        'parseUEFNMapManifest',
        `Turn a UEFN map code into plugin files (.pak/.utoc/.ucas/.sig) ready for tools like FModel.`
      ),
      section(
        'Quick start',
        `- Interactive run (map code → download → output/Export):
    ${exe}

- Show detailed help:
    ${exe} --help
    ${exe} --help output
    ${exe} help chunks`
      ),
      section(
        'Commands',
        `Interactive:
  ${exe}

Local manifest mode:
  ${exe} <manifestPath> --base <CDN_URL> [options]`
      ),
      section(
        'Options',
        `--out <dir>                 Output root (default: ./output)
--chunks <dir>              Override chunk cache directory
--engine-version <M.m.CL>   Override engine version used for CDN paths
--debug                     Extra logging + extra debug artifacts on failure
--fresh-login               Force a new Epic login flow
--no-save-tokens            Don’t write tokens to parseUEFNTokens.json
--help, -h                  Show help (optionally: --help <topic>)`
      ),
      section(
        'Help topics',
        `auth            Epic login & parseUEFNTokens.json
engine-version   CDN build selection & overrides
output          What gets written to output/Export and output/.data
chunks          Chunk cache behavior and overrides
local-manifest  Run from an existing .manifest + --base URL
debug           Debug mode and what extra info it produces
env             Environment variables (advanced)`
      ),
    ].join('\n'),

    auth: () =>
      [
        section('Auth / tokens', `How sign-in works and how tokens are stored.`),
        section(
          'What it does',
          `- Uses an Epic sign-in flow and stores tokens in: parseUEFNTokens.json
- On later runs, reuses the saved token if it’s still valid.`
        ),
        section(
          'When to use these options',
          `--fresh-login
  Use if your token is expired/broken or you want to switch accounts.

--no-save-tokens
  Use if you don’t want anything written to disk (session-only).`
        ),
      ].join('\n'),

    'engine-version': () =>
      [
        section('Engine version / CDN path', `Controls which build path the CDN URLs are generated from.`),
        section(
          'Why it matters',
          `The CDN path must match the live Fortnite/UEFN build. If it doesn’t, downloads can fail (403/404).`
        ),
        section(
          'Option',
          `--engine-version <M.m.CL>
  Example:
    ${exe} --engine-version 40.0.51995682`
        ),
      ].join('\n'),

    output: () =>
      [
        section('Output layout', `Where files go and what they mean.`),
        section(
          'Folder structure',
          `output/
  Export/                 Final files you care about
    <pluginTag>.pak
    <pluginTag>.utoc
    <pluginTag>.ucas
    <pluginTag>.sig
    global.*              Copied from Fortnite Paks (if configured)
  .data/
    chunks/<pluginTag>/   Per-map chunk cache + manifest copy
      <pluginTag>.manifest
      *.chunk`
        ),
        section(
          'Option',
          `--out <dir>
  Changes the output root. The Export/.data layout stays the same.`
        ),
      ].join('\n'),

    chunks: () =>
      [
        section('Chunk cache', `How chunks are cached between runs.`),
        section(
          'Default behavior',
          `Chunks are cached under:
  output/.data/chunks/<pluginTag>/

This makes reruns fast (no redownload if the cache is present).`
        ),
        section(
          'Option',
          `--chunks <dir>
  Use a custom cache directory instead of output/.data/chunks/...`
        ),
        section(
          'Tip',
          `If something looks corrupted or you want a clean run, delete the map’s chunk folder (or point --chunks to an empty folder).`
        ),
      ].join('\n'),

    'local-manifest': () =>
      [
        section('Local manifest mode', `Run from an existing .manifest file instead of the map-code API flow.`),
        section(
          'Command',
          `${exe} <manifestPath> --base <CDN_URL> [options]

Example:
  ${exe} plugin.manifest --base "https://.../" --out ./output --debug`
        ),
        section(
          'Important',
          `--base is required because chunk URLs are built relative to it.`
        ),
      ].join('\n'),

    debug: () =>
      [
        section('Debugging', `Extra logs and extra artifacts for troubleshooting.`),
        section('Option', `--debug`),
        section(
          'What to do when something fails',
          `Re-run with --debug and keep the console output + output folder. It may include extra debug files when a chunk fails.`
        ),
      ].join('\n'),

    env: () =>
      [
        section('Environment variables', `Advanced knobs for edge cases.`),
        section(
          'UEFN_KEEP_RAW_MISSING',
          `UEFN_KEEP_RAW_MISSING=1
  If a chunk part fails to decompress, write raw/encrypted bytes instead of zero-fill.`
        ),
        section(
          'UEFN_DECOMPRESS_WORKER',
          `UEFN_DECOMPRESS_WORKER=0
  Disable the decompression worker path (advanced / troubleshooting).`
        ),
      ].join('\n'),
  };

  const key =
    topic === '' ? 'overview'
    : topic === 'help' ? 'overview'
    : topic === 'manifest' ? 'local-manifest'
    : topic === 'local' ? 'local-manifest'
    : topic;

  const fn = topics[key] || null;
  if (!fn) {
    console.log(topics.overview());
    console.log(`Unknown help topic: ${topicRaw}\n`);
    console.log('Valid topics: auth, engine-version, output, chunks, local-manifest, debug, env');
    return;
  }
  console.log(fn());
}

async function runMain({ rl, ask, entryScriptPath }) {
  const args = process.argv.slice(2);

  // Help should work without requiring config or prompting.
  const helpIdx = args.findIndex((a) => a === '--help' || a === '-h');
  if (helpIdx !== -1) {
    const topic = args[helpIdx + 1] && !String(args[helpIdx + 1]).startsWith('--') ? args[helpIdx + 1] : '';
    printHelp(topic);
    rl.close();
    return;
  }
  if (args[0] === 'help') {
    printHelp(args[1] || '');
    rl.close();
    return;
  }

  const config = await ensureConfig(ask);
  let manifestPath = null;
  let outputRoot = path.resolve(config.defaultOutputDir || path.join(process.cwd(), 'output'));
  let chunksDir = null;
  let baseUrl = null;
  let debug = false;
  let engineVersionOverride = null;
  let noSaveTokens = false;
  let freshLogin = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) outputRoot = path.resolve(args[++i]);
    else if (args[i] === '--base' && args[i + 1]) baseUrl = (args[++i]).replace(/\/?$/, '/');
    else if (args[i] === '--chunks' && args[i + 1]) chunksDir = path.resolve(args[++i]);
    else if (args[i] === '--engine-version' && args[i + 1]) engineVersionOverride = args[++i];
    else if (args[i] === '--no-save-tokens') noSaveTokens = true;
    else if (args[i] === '--fresh-login') freshLogin = true;
    else if (args[i] === '--debug') debug = true;
    else if (!args[i].startsWith('--')) manifestPath = args[i];
  }
  initOodle(config, debug, ROOT);

  const hasLocalManifest = manifestPath && fs.existsSync(manifestPath);
  if (hasLocalManifest) {
    if (engineVersionOverride) {
      try {
        setFortniteUaBuildFromResolvedVersion(parseEngineVersionString(engineVersionOverride));
      } catch (_) {}
    } else if (config.fortniteGamePath) {
      const fromPaks = tryReadEngineVersionFromPaksDir(path.join(config.fortniteGamePath, 'Content', 'Paks'));
      if (fromPaks) setFortniteUaBuildFromResolvedVersion(fromPaks);
    }
  }

  if (!hasLocalManifest) {
    await runFromApi(outputRoot, chunksDir, {
      debug,
      config,
      engineVersionOverride,
      noSaveTokens,
      freshLogin,
      ask,
      rl,
      entryScriptPath,
    });
    rl.close();
    return;
  }

  if (!baseUrl) {
    console.error('--base <CDN_URL> is required when using a local manifest.');
    process.exit(1);
  }
  console.log('Parsing UEFN manifest...');
  const chunkData = parseUEFNManifest(manifestPath);
  const { chunks, fileManifestList } = chunkData;
  console.log(`  ${chunks.length} chunks, ${fileManifestList.length} files`);
  const exportRoot = path.join(outputRoot, 'Export');
  const dataRoot = path.join(outputRoot, '.data');
  if (!fs.existsSync(exportRoot)) fs.mkdirSync(exportRoot, { recursive: true });
  if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });
  const baseManifestName = sanitizeName(path.basename(manifestPath, path.extname(manifestPath)));
  const pluginTag = baseManifestName || 'LocalManifest';
  const outDir = exportRoot;
  const effectiveChunksDir = chunksDir || path.join(dataRoot, 'chunks', pluginTag);
  if (!fs.existsSync(effectiveChunksDir)) fs.mkdirSync(effectiveChunksDir, { recursive: true });
  const manifestCopyPath = path.join(effectiveChunksDir, `${pluginTag}.manifest`);
  try {
    fs.copyFileSync(manifestPath, manifestCopyPath);
    console.log('Saved manifest to', manifestCopyPath);
  } catch (_) {}

  console.log('Downloading chunks...');
  const dl = await downloadAll(chunks, baseUrl, effectiveChunksDir);
  console.log(`  ${dl.done} new, ${dl.skipped} cached, ${dl.failed} failed`);

  console.log('Output folder:', path.resolve(outDir));
  console.log('Reassembling files...');
  const beforeExport = snapshotExportFiles(exportRoot);
  const re = await reassemble(chunkData, effectiveChunksDir, outDir, undefined, { debug, entryScriptPath, pluginTag });
  try { renamePluginArtifacts(exportRoot, pluginTag, beforeExport); } catch (_) {}
  const total = re.written + re.partial;
  console.log(`  ${total} file(s) written -> ${outDir}${re.partial ? ` (${re.written} complete, ${re.partial} partial)` : ''}`);
  if (re.skipped > 0) console.log(`  ${re.skipped} skipped (no chunk parts)`);
  if (re.partialFiles?.length) {
    for (const { filename, missingCount, missingGuids } of re.partialFiles) {
      console.log(`  Partial: ${filename} (${missingCount} chunk part(s) failed to decompress; missing GUIDs: ${missingGuids.join(', ')}${missingCount > 3 ? '...' : ''})`);
    }
    if (debug) console.log('  (Inspect debug/ folder in output for failing_chunk_raw_hex.txt and other debug files.)');
  }
  const outNames = listNewExportFiles(exportRoot, beforeExport);
  console.log('\nDone. Output:', outNames.length ? outNames.join(', ') : 'none');
  console.log('Path:', path.resolve(outDir));
  const paksPath = getPaksPath(config);
  if (paksPath) {
    const copied = copyPakArtifacts(paksPath, exportRoot);
    if (copied > 0) console.log(`Copied ${copied} pak artifact file(s) to ${exportRoot}`);
  }
}

module.exports = { runMain };
