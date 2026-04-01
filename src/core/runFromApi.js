const fs = require('fs');
const path = require('path');
const { TOKENS_PATH, ROOT } = require('./paths');
const { get } = require('./http');
const { setFortniteUaBuildFromResolvedVersion } = require('./userAgent');
const { parseUEFNManifestFromBuffer } = require('./manifestParse');
const { downloadAll, repairFailedChunks } = require('./download');
const { reassemble } = require('./reassemble');
const { getPaksPath, copyPakArtifacts } = require('./config');
const { initOodle } = require('./oodle');
const {
  getAuthUrl,
  exchangeAuthCode,
  tokenExpiryToMs,
  saveEpicTokensMerge,
  tryLoadValidUeFnToken,
  resolveFortniteEngineVersion,
  getCookedContentPackage,
  getModuleKey,
  EPIC_UEFN_CLIENT_ID,
  EPIC_UEFN_CLIENT_SECRET,
} = require('./epic');

function sanitizeName(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function buildVersionTag(ver) {
  if (ver && ver.rawBuildVersion) return String(ver.rawBuildVersion).trim();
  if (ver && ver.major != null && ver.minor != null && ver.cl != null) {
    return `++Fortnite+Release-${String(ver.major)}.${String(ver.minor).padStart(2, '0')}-CL-${String(ver.cl)}-Windows`;
  }
  return 'UnknownVersion-Windows';
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

async function runFromApi(outputRoot, chunksOverrideDir, opts = {}) {
  const { ask, rl, entryScriptPath } = opts;
  if (!ask || !rl) throw new Error('runFromApi: ask and rl are required');
  if (!entryScriptPath) throw new Error('runFromApi: entryScriptPath is required');

  const tokenOpts = {
    ...opts,
    noSaveTokens: !!opts.noSaveTokens,
    freshLogin: !!opts.freshLogin,
  };

  let token = null;
  let tokenData = null;
  if (!opts.freshLogin) {
    token = await tryLoadValidUeFnToken(tokenOpts);
    if (token) console.log('Using saved UEFN token (', path.basename(TOKENS_PATH), ').');
  }
  if (!token) {
    console.log('\nOpen this URL in your browser, sign in, and paste the authorization code:\n');
    console.log(getAuthUrl(EPIC_UEFN_CLIENT_ID));
    const code = (await ask('\nAuthorization code: ')).trim();
    if (!code) {
      console.error('No code provided.');
      rl.close();
      process.exit(1);
    }

    console.log('\nExchanging code for token...');
    tokenData = await exchangeAuthCode(EPIC_UEFN_CLIENT_ID, EPIC_UEFN_CLIENT_SECRET, code);
    token = tokenData.access_token;
    if (!opts.noSaveTokens) {
      saveEpicTokensMerge({
        uefnAccessToken: token,
        uefnExpiresAt: tokenExpiryToMs(tokenData),
        uefnRefreshToken: tokenData.refresh_token || undefined,
      });
      console.log('Saved tokens to', TOKENS_PATH, '(UEFN; launcher token saved after version lookup).');
    }
  }

  console.log('Resolving UEFN engine version...');
  const ver = await resolveFortniteEngineVersion(opts.config || {}, {
    ...tokenOpts,
    uefnAccessToken: token,
    engineVersionOverride: opts.engineVersionOverride,
  });
  setFortniteUaBuildFromResolvedVersion(ver);
  initOodle(opts.config || {}, !!opts.debug, ROOT);
  const { major, minor, cl, cdnPathSegment, source: versionSource } = ver;
  console.log(`  ${cdnPathSegment} - ${versionSource}`);
  if (versionSource.indexOf('FortniteAPI') !== -1) {
    console.log('  Tip: if manifest download fails (403) or module looks wrong, pass --engine-version MAJOR.MINOR.CL (Copy from PROD versions). If a 403 error occurs that means there\'s usually something wrong with the URL');
  }

  const mapCode = (await ask('Map code (e.g. 0000-0000-0000): ')).trim();
  if (!mapCode) {
    console.error('No map code provided.');
    rl.close();
    process.exit(1);
  }
  const versionTag = sanitizeName(buildVersionTag(ver));
  const mapTag = sanitizeName(mapCode.replace(/\s+/g, ''));
  const pluginTag = `${versionTag}_${mapTag}`;
  const exportRoot = path.join(outputRoot, 'Export');
  const dataRoot = path.join(outputRoot, '.data');
  const outDir = exportRoot;
  const chunksDir = chunksOverrideDir
    ? path.resolve(chunksOverrideDir)
    : path.join(dataRoot, 'chunks', pluginTag);
  const manifestStorePath = path.join(chunksDir, `${pluginTag}.manifest`);
  if (!fs.existsSync(exportRoot)) fs.mkdirSync(exportRoot, { recursive: true });
  if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });
  if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });

  console.log('Fetching cooked content package...');
  const cooked = await getCookedContentPackage(token, mapCode, major, minor, cl);
  const moduleId = cooked.resolved?.root?.moduleId;
  const version = cooked.resolved?.root?.version;
  if (!moduleId || version == null) {
    console.error('No resolved root module in response.');
    rl.close();
    process.exit(1);
  }

  const contentModule = cooked.content?.find((m) => m.moduleId === moduleId && m.version === version);
  if (!contentModule?.binaries?.manifest) {
    console.error('Module not found or missing binaries/manifest.');
    rl.close();
    process.exit(1);
  }
  const cookJobId = contentModule.cookJobId;
  if (!cookJobId) {
    console.error('Module missing cookJobId.');
    rl.close();
    process.exit(1);
  }

  const baseUrl = `https://cooked-content-live-cdn.epicgames.com/valkyrie/cooked-content/${moduleId}/${cdnPathSegment}/v${version}/${cookJobId}/`;
  const manifestPath = contentModule.binaries.manifest;
  const manifestUrl = baseUrl + manifestPath;
  const chunkPrefix = manifestPath.includes('/') ? manifestPath.replace(/\/[^/]*$/, '/') : '';

  let aesKeyHex = null;
  let guid = null;
  if (cooked.isEncrypted) {
    console.log('Content is encrypted; fetching decryption key...');
    if (opts.debug) process.env.UEFN_DEBUG_KEY = '1';
    try {
      const keyData = await getModuleKey(token, moduleId, version);
      aesKeyHex = keyData.aesKey;
      guid = keyData.guid;
      console.log('AES key:', aesKeyHex);
    } finally {
      if (opts.debug) delete process.env.UEFN_DEBUG_KEY;
    }
  }

  if (opts.debug) {
    console.error('[manifest] moduleId:', moduleId);
    console.error('[manifest] version:', version);
    console.error('[manifest] cookJobId:', cookJobId);
    console.error('[manifest] Fortnite engine (CDN segment):', cdnPathSegment);
    console.error('[manifest] manifestPath (relative):', manifestPath);
    console.error('[manifest] chunkPrefix:', chunkPrefix || '(none)');
    console.error('[manifest] baseUrl:', baseUrl);
    console.error('[manifest] manifestUrl (full):', manifestUrl);
  }
  console.log('Downloading manifest...');
  const manifestBuf = await get(manifestUrl, { token, debug: opts.debug });
  fs.writeFileSync(manifestStorePath, manifestBuf);
  console.log('Saved manifest to', manifestStorePath);
  console.log('Parsing UEFN manifest...');
  const chunkData = parseUEFNManifestFromBuffer(manifestBuf);
  const { chunks, fileManifestList } = chunkData;
  console.log(`  ${chunks.length} chunks, ${fileManifestList.length} files`);

  console.log('Downloading chunks...');
  const dl = await downloadAll(chunks, baseUrl, chunksDir, { aesKeyHex, guid, keyGuid: guid, chunkPrefix });
  console.log(`  ${dl.done} new, ${dl.skipped} cached, ${dl.failed} failed`);
  if (aesKeyHex) {
    const prefix = chunkPrefix.endsWith('/') ? chunkPrefix : chunkPrefix ? chunkPrefix + '/' : '';
    const repaired = await repairFailedChunks(chunks, baseUrl, chunksDir, { aesKeyHex, keyGuid: guid }, (chunk) => {
      const pathSeg = String(chunk.pathDecimal ?? 0).padStart(2, '0');
      return `${baseUrl}${prefix}ChunksV4/${pathSeg}/${chunk.filename}`;
    });
    if (repaired > 0) console.log(`  Repaired ${repaired} chunk(s) on retry.`);
  }

  console.log('Output folder:', path.resolve(outDir));
  console.log('Reassembling files...');
  if (opts.debug) process.env.UEFN_DEBUG_WORKER = '1';
  let re = null;
  const beforeExport = snapshotExportFiles(exportRoot);
  try {
    re = await reassemble(chunkData, chunksDir, outDir, aesKeyHex ? { aesKeyHex, keyGuid: guid } : undefined, {
      ...opts,
      entryScriptPath,
      pluginTag,
    });
  } catch (err) {
    console.error('Reassemble failed:', err.message || err);
    if (opts.debug) console.error(err.stack);
    throw err;
  } finally {
    if (re != null) {
      try { renamePluginArtifacts(exportRoot, pluginTag, beforeExport); } catch (_) {}
      const total = re.written + re.partial;
      console.log(`  ${total} file(s) written -> ${outDir}${re.partial ? ` (${re.written} complete, ${re.partial} partial)` : ''}`);
      if (re.skipped > 0) console.log(`  ${re.skipped} skipped (no chunk parts)`);
      if (re.partialFiles?.length) {
        for (const { filename, missingCount, missingGuids } of re.partialFiles) {
          console.log(`  Partial: ${filename} (${missingCount} chunk part(s) failed to decompress; missing GUIDs: ${missingGuids.join(', ')}${missingCount > 3 ? '...' : ''})`);
        }
        console.log('  (Missing ranges: zero-filled, or set UEFN_KEEP_RAW_MISSING=1 to write encrypted bytes.)');
        if (opts.debug) console.log('  (Inspect debug/ folder in output for failing_chunk_raw_hex.txt and other debug files.)');
        console.log('  (Some chunks may use an unsupported encryption format; 3/4 files are complete.)');
        if (opts.debug) {
          const debugDir = path.join(outDir, 'debug');
          if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
          const first = re.partialFiles[0];
          const missingGuid = first?.missingGuids?.[0];
          const chunkInfo = chunkData.chunks.find((c) => c.guidHex === missingGuid);
          if (chunkInfo && missingGuid) {
            const chunkPath = path.join(chunksDir, chunkInfo.filename);
            if (fs.existsSync(chunkPath)) {
              const raw = fs.readFileSync(chunkPath);
              const preview = raw.subarray(0, Math.min(64, raw.length));
              console.log('  [debug] Failing chunk file:', chunkPath);
              console.log('  [debug] Size:', raw.length, 'bytes; first 64 (hex):', preview.toString('hex'));
              if (raw.length >= 32) {
                const payloadPath = path.join(debugDir, `failing_chunk_${missingGuid}.bin`);
                fs.writeFileSync(payloadPath, raw.subarray(32));
                console.log('  [debug] Payload (bytes 32+) written to:', payloadPath);
              }
            }
          }
        }
      }
      const outNames = listNewExportFiles(exportRoot, beforeExport);
      console.log('\nDone. Output:', outNames.length ? outNames.join(', ') : 'none');
      console.log('Path:', path.resolve(outDir));
    }
  }
  const paksPath = getPaksPath(opts.config);
  if (paksPath) {
    const copied = copyPakArtifacts(paksPath, exportRoot);
    if (copied > 0) console.log(`Copied ${copied} pak artifact file(s) to ${exportRoot}`);
  }
}

module.exports = { runFromApi };
