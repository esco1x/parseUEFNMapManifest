const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const pako = require('pako');
const axios = require('axios');

const HEADER_MAGIC = 0x44bec00c;
const CONCURRENCY = 5;
const ZLIB_MAGIC = Buffer.from([0x78, 0x9c]);
const ZLIB_ALT = [Buffer.from([0x78, 0x01]), Buffer.from([0x78, 0xda])];
const CHUNK_MAGIC_OODLE = Buffer.from([0xa2, 0x3a, 0xfe, 0xb1]);

let tryOodleDecompress = null;

function initOodle(config) {
  const scriptDir = __dirname;
  let oodleDll = null;
  const binariesDir = config?.fortniteGamePath && fs.existsSync(config.fortniteGamePath)
    ? path.join(config.fortniteGamePath, 'Binaries', 'Win64')
    : null;
  if (binariesDir && fs.existsSync(binariesDir)) {
    try {
      const names = fs.readdirSync(binariesDir);
      const match = names.find((n) => /^oo2core_\d+_win64\.dll$/i.test(n));
      if (match) {
        const src = path.join(binariesDir, match);
        const dest = path.join(scriptDir, match);
        fs.copyFileSync(src, dest);
        oodleDll = dest;
        console.log('[Oodle] Copied', match, 'from game to project folder.');
      }
    } catch (_) {}
  }
  if (!oodleDll || !fs.existsSync(oodleDll)) {
    oodleDll = path.join(scriptDir, 'oo2core_9_win64.dll');
    if (!fs.existsSync(oodleDll)) {
      try {
        const names = fs.readdirSync(scriptDir);
        const match = names.find((n) => /^oo2core_\d+_win64\.dll$/i.test(n));
        if (match) oodleDll = path.join(scriptDir, match);
      } catch (_) {}
    }
  }
  if (!oodleDll || !fs.existsSync(oodleDll)) {
    console.error('[Oodle] oo2core_*_win64.dll not found. Set Fortnite game path in config (first run) so the script can copy it from FortniteGame\\Binaries\\Win64.');
    return;
  }
  try {
    const koffi = require('koffi');
    const oodle = koffi.load(oodleDll);
    const OodleLZ_Decompress = oodle.func('OodleLZ_Decompress', 'int', ['void*', 'int', 'void*', 'int', 'int', 'int', 'int', 'void*', 'void*', 'void*', 'void*', 'void*', 'void*', 'int']);
    tryOodleDecompress = (compressed, outSize) => {
      const out = Buffer.alloc(outSize);
      const n = OodleLZ_Decompress(compressed, compressed.length, out, outSize, 0, 0, 0, null, null, null, null, null, null, 0);
      if (n > 0 && n <= outSize) return out.subarray(0, n);
      const n2 = OodleLZ_Decompress(compressed, compressed.length, out, outSize, 0, 0, 0, null, null, null, null, null, null, 3);
      if (n2 > 0 && n2 <= outSize) return out.subarray(0, n2);
      return null;
    };
    console.log('[Oodle] DLL loaded:', oodleDll);
  } catch (e) {
    console.error('[Oodle] Failed to load:', e.message || e);
  }
}

const EPIC_UEFN_CLIENT_ID = '3e13c5c57f594a578abe516eecb673fe';
const EPIC_UEFN_CLIENT_SECRET = '530e316c337e409893c55ec44f22cd62';
const CONTENT_API = 'https://content-service.bfda.live.use1a.on.epicgames.com';
const OAUTH_URL = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token';
const AUTH_REDIRECT = 'https://www.epicgames.com/id/api/redirect';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const CONFIG_PATH = path.join(__dirname, 'parseUEFNManifest.config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function autoDetectFortniteGame() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Epic Games', 'Fortnite', 'FortniteGame'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Epic Games', 'Fortnite', 'FortniteGame'),
  ].filter(Boolean);
  for (const gameDir of candidates) {
    if (!fs.existsSync(gameDir)) continue;
    const paksDir = path.join(gameDir, 'Content', 'Paks');
    const binariesDir = path.join(gameDir, 'Binaries', 'Win64');
    const hasPaks = fs.existsSync(path.join(paksDir, 'global.ucas')) && fs.existsSync(path.join(paksDir, 'global.utoc'));
    let hasOodle = false;
    try {
      if (fs.existsSync(binariesDir)) {
        const names = fs.readdirSync(binariesDir);
        hasOodle = names.some((n) => /^oo2core_\d+_win64\.dll$/i.test(n));
      }
    } catch (_) {}
    if (hasPaks && hasOodle) return gameDir;
  }
  return null;
}

function copyGlobalUcasUtoc(pakDir, outDir) {
  if (!pakDir || !fs.existsSync(pakDir)) return;
  const ucas = path.join(pakDir, 'global.ucas');
  const utoc = path.join(pakDir, 'global.utoc');
  if (!fs.existsSync(ucas) || !fs.existsSync(utoc)) return;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(ucas, path.join(outDir, 'global.ucas'));
  fs.copyFileSync(utoc, path.join(outDir, 'global.utoc'));
  console.log('  Copied global.ucas & global.utoc into output folder.');
}

function getPaksPath(config) {
  return config?.fortniteGamePath && fs.existsSync(config.fortniteGamePath)
    ? path.join(config.fortniteGamePath, 'Content', 'Paks')
    : null;
}

async function ensureConfig() {
  let config = loadConfig();
  const defaultPluginsDir = path.join(process.cwd(), 'plugins');
  if (!config.defaultPluginsDir) config.defaultPluginsDir = defaultPluginsDir;
  let needSave = false;
  if (config.fortnitePakPath && !config.fortniteGamePath) {
    config.fortniteGamePath = path.dirname(path.dirname(config.fortnitePakPath));
    delete config.fortnitePakPath;
    needSave = true;
  }

  if (!config.fortniteGamePath || !fs.existsSync(config.fortniteGamePath)) {
    console.log('\nFortnite game path not set or folder missing.');
    console.log('Use the FortniteGame folder (e.g. C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame), not the Paks folder.');
    const choice = (await ask('Enter path to FortniteGame folder, or type "auto" to try auto-detect: ')).trim();
    let gamePath = null;
    if (/^auto$/i.test(choice)) {
      gamePath = autoDetectFortniteGame();
      if (gamePath) {
        console.log('Found:', gamePath);
      } else {
        console.log('Auto-detect did not find Fortnite. Enter the path to the FortniteGame folder manually.');
        gamePath = (await ask('Path: ')).trim();
      }
    } else {
      gamePath = choice;
    }
    if (gamePath) {
      const normalized = path.resolve(gamePath);
      if (fs.existsSync(normalized)) {
        const paksDir = path.join(normalized, 'Content', 'Paks');
        if (!fs.existsSync(path.join(paksDir, 'global.ucas')) || !fs.existsSync(path.join(paksDir, 'global.utoc'))) {
          console.error('That folder does not look like FortniteGame (missing Content\\Paks\\global.ucas or global.utoc).');
          process.exit(1);
        }
        config.fortniteGamePath = normalized;
        needSave = true;
      } else {
        console.error('Path does not exist:', normalized);
        process.exit(1);
      }
    } else {
      console.error('No path provided.');
      process.exit(1);
    }

    const pluginsPrompt = (await ask(`Plugins output folder [default: ${config.defaultPluginsDir}]: `)).trim();
    const resolvedPlugins = path.resolve(pluginsPrompt || config.defaultPluginsDir);
    config.defaultPluginsDir = resolvedPlugins;
    needSave = true;
  }

  if (needSave) saveConfig(config);
  return config;
}

function getAuthUrl(clientId) {
  return `${AUTH_REDIRECT}?clientId=${clientId}&responseType=code`;
}

async function exchangeAuthCode(clientId, clientSecret, code) {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code }).toString();
  const { data } = await axios.post(OAUTH_URL, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
  });
  return data;
}

async function getLatestVersion() {
  const { data } = await axios.get('https://api.fortniteapi.com/v1/versions');
  const latest = data.find(
    (v) => v.meta?.tag === 'latest' && v.meta?.state === 'READY' && v.version?.platform === 'Windows'
  );
  if (!latest) throw new Error('Unable to find latest Fortnite version.');
  const [major, minor] = latest.version.id.split('.');
  const cl = latest.version.build;
  return { major, minor, cl };
}

async function getCookedContentPackage(token, mapCode, major, minor, cl) {
  const mapCodeNorm = mapCode.replace(/\s/g, '').trim();
  const url = `${CONTENT_API}/api/content/v2/link/${mapCodeNorm}/cooked-content-package`;
  const { data } = await axios.get(url, {
    params: { role: 'client', platform: 'windows', major, minor, patch: cl },
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

async function getModuleKey(token, moduleId, version) {
  const url = `${CONTENT_API}/api/content/v4/module/${moduleId}/version/${version}/key`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const aesKey = '0x' + Buffer.from(data.key.Key, 'base64').toString('hex').toUpperCase();
  const guid = data.key.Guid;
  return { aesKey, guid };
}

function readFString(buffer, pos) {
  const len = buffer.readInt32LE(pos);
  pos += 4;
  if (len === 0) return { str: '', nextPos: pos };
  if (len < 0) {
    const byteLen = (-len) * 2 - 2;
    const str = buffer.toString('utf16le', pos, pos + byteLen);
    return { str, nextPos: pos + byteLen + 2 };
  }
  const str = buffer.toString('ascii', pos, pos + len - 1);
  return { str, nextPos: pos + len };
}

function parseFileManifestList(data, pos) {
  const startPos = pos;
  if (pos + 9 > data.length) return null;
  const fmlSize = data.readUInt32LE(pos);
  const fmlVersion = data[pos + 4];
  const fileCount = data.readUInt32LE(pos + 5);
  pos += 9;
  if (fileCount < 0 || fileCount > 500000) return null;
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const r = readFString(data, pos);
    files.push({ filename: r.str, symlinkTarget: '', chunkParts: [], fileSize: 0 });
    pos = r.nextPos;
  }
  for (let i = 0; i < fileCount; i++) {
    const r = readFString(data, pos);
    files[i].symlinkTarget = r.str;
    pos = r.nextPos;
  }
  pos += fileCount * 20;
  pos += fileCount * 1;
  for (let i = 0; i < fileCount; i++) {
    const tagCount = data.readUInt32LE(pos);
    pos += 4;
    for (let t = 0; t < tagCount; t++) {
      const r = readFString(data, pos);
      pos = r.nextPos;
    }
  }
  for (let i = 0; i < fileCount; i++) {
    const partCount = data.readUInt32LE(pos);
    pos += 4;
    let fileSize = 0;
    for (let p = 0; p < partCount; p++) {
      if (pos + 28 > data.length) return null;
      const partStart = pos;
      const partSize = data.readUInt32LE(pos);
      pos += 4;
      const g = [
        data.readUInt32LE(pos), data.readUInt32LE(pos + 4), data.readUInt32LE(pos + 8), data.readUInt32LE(pos + 12),
      ];
      pos += 16;
      const offset = data.readUInt32LE(pos);
      const size = data.readUInt32LE(pos + 4);
      pos += 8;
      const guidHex = g.map((x) => x.toString(16).toUpperCase().padStart(8, '0')).join('');
      files[i].chunkParts.push({ guidHex, offset, size });
      fileSize += size;
      if (partSize > 28) pos = partStart + partSize;
    }
    files[i].fileSize = fileSize;
  }
  if (fmlVersion >= 1) {
    for (let i = 0; i < fileCount; i++) {
      const hasMd5 = data.readUInt32LE(pos);
      pos += 4;
      if (hasMd5 !== 0) pos += 16;
    }
    for (let i = 0; i < fileCount; i++) {
      const r = readFString(data, pos);
      pos = r.nextPos;
    }
  }
  if (fmlVersion >= 2) pos += fileCount * 32;
  if (fmlSize > 0) pos = startPos + fmlSize;
  return { files, nextPos: pos };
}

function parseEpicManifestBody(data) {
  let pos = 0;
  if (data.length < 4) return null;
  const metaSize = data.readUInt32LE(pos);
  if (metaSize < 4 || metaSize > data.length) return null;
  pos += metaSize;
  if (pos + 9 > data.length) return null;
  const cdlStartPos = pos;
  const cdlSize = data.readUInt32LE(pos);
  const count = data.readUInt32LE(pos + 5);
  pos += 9;
  if (count < 1 || count > 100000) return null;
  const expectedCdlBytes = count * (16 + 8 + 20 + 1 + 4 + 8);
  if (pos + expectedCdlBytes > data.length) return null;
  const guids = [];
  const hashes = [];
  const groupNums = [];
  for (let i = 0; i < count; i++) {
    guids.push([
      data.readUInt32LE(pos), data.readUInt32LE(pos + 4), data.readUInt32LE(pos + 8), data.readUInt32LE(pos + 12),
    ]);
    pos += 16;
  }
  for (let i = 0; i < count; i++) {
    hashes.push(data.readBigUInt64LE(pos));
    pos += 8;
  }
  pos += count * 20;
  for (let i = 0; i < count; i++) {
    groupNums.push(data[pos] & 0xff);
    pos += 1;
  }
  pos += count * 4;
  pos += count * 8;
  const pad2 = (n) => String(n).padStart(2, '0');
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const guidHex = guids[i].map((x) => x.toString(16).toUpperCase().padStart(8, '0')).join('');
    const hashHex = hashes[i].toString(16).toUpperCase().padStart(16, '0');
    const pathDecimal = groupNums[i];
    chunks.push({
      pathDecimal,
      filename: hashHex + '_' + guidHex + '.chunk',
      guidHex,
    });
  }
  pos = cdlStartPos + cdlSize;
  let fileManifestList = null;
  if (pos + 9 <= data.length) {
    fileManifestList = parseFileManifestList(data, pos);
  }
  const out = { chunks };
  if (fileManifestList) out.fileManifestList = fileManifestList.files;
  return out;
}

function parseUEFNManifestFromBuffer(buf) {
  if (buf.length < 41) throw new Error('Manifest too short');
  const magic = buf.readUInt32LE(0);
  const headerSize = buf.readUInt32LE(4);
  let decompressed;
  if (magic === (HEADER_MAGIC >>> 0) && headerSize === 41) {
    const storedAs = buf[36];
    const body = buf.slice(41);
    decompressed = (storedAs & 1) !== 0 ? Buffer.from(pako.inflate(body)) : body;
  } else {
    const payload = buf.slice(16);
    const zlibStart = payload.indexOf(ZLIB_MAGIC);
    if (zlibStart < 0) throw new Error('Zlib block not found');
    decompressed = Buffer.from(pako.inflate(payload.slice(zlibStart)));
  }
  const chunkData = parseEpicManifestBody(decompressed);
  if (!chunkData || !chunkData.chunks.length) throw new Error('No chunk list in manifest');
  if (!chunkData.fileManifestList || !chunkData.fileManifestList.length) throw new Error('No file list in manifest');
  return chunkData;
}

function parseUEFNManifest(filePath) {
  return parseUEFNManifestFromBuffer(fs.readFileSync(filePath));
}

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'EpicGames/1.0', ...options.headers };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    https.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location, options).then(resolve).catch(reject);
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const ZLIB_SCAN_LEN = 1024;

function hasZlibMagic(buf) {
  const slice = buf.length > ZLIB_SCAN_LEN ? buf.subarray(0, ZLIB_SCAN_LEN) : buf;
  if (slice.indexOf(ZLIB_MAGIC) >= 0) return true;
  for (const m of ZLIB_ALT) {
    if (slice.indexOf(m) >= 0) return true;
  }
  return false;
}

function keyGuidToIv(keyGuid) {
  if (!keyGuid || typeof keyGuid !== 'string') return null;
  const hex = keyGuid.replace(/-/g, '');
  if (hex.length === 32 && /^[0-9A-Fa-f]{32}$/.test(hex)) return Buffer.from(hex, 'hex');
  return null;
}

function tryDecryptChunk(data, aesKeyHex, chunkGuidHex, keyGuid) {
  try {
    const keyHex = aesKeyHex.replace(/^0x/i, '');
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) return null;
    const ivChunk = chunkGuidHex && /^[0-9A-Fa-f]{32}$/.test(chunkGuidHex)
      ? Buffer.from(chunkGuidHex, 'hex') : null;
    const ivKey = keyGuidToIv(keyGuid);
    const ivZero = Buffer.alloc(16, 0);
    let fallback = null;

    function runWithKey(keyBuf) {
      const decryptCbc = (iv, payload, noPadding) => {
        const opts = noPadding ? { autoPadding: false } : {};
        const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv, opts);
        return Buffer.concat([decipher.update(payload || data), decipher.final()]);
      };
      const decryptCtr = (iv) => {
        const decipher = crypto.createDecipheriv('aes-256-ctr', keyBuf, iv);
        return Buffer.concat([decipher.update(data), decipher.final()]);
      };
      const tryIv = (iv, payload) => {
        try {
          const out = decryptCbc(iv, payload || data);
          if (hasZlibMagic(out)) return out;
          if (!fallback) fallback = out;
        } catch (_) {}
        return null;
      };
      if (ivChunk) {
        const out = tryIv(ivChunk);
        if (out) return out;
        const ivChunkRev = Buffer.from(ivChunk);
        ivChunkRev.reverse();
        const outRev = tryIv(ivChunkRev);
        if (outRev) return outRev;
        const sha = crypto.createHash('sha256').update(ivChunk).digest();
        const out2 = tryIv(sha.subarray(0, 16));
        if (out2) return out2;
        try {
          const ctrOut = decryptCtr(ivChunk);
          if (hasZlibMagic(ctrOut)) return ctrOut;
        } catch (_) {}
      }
      if (data.length >= 32) {
        const out = tryIv(data.subarray(0, 16), data.subarray(16));
        if (out) return out;
      }
      if (data.length >= 48) {
        const ivAt16 = data.subarray(16, 32);
        const out = tryIv(ivAt16, data.subarray(32));
        if (out) return out;
        const payloadLen = data.length - 32;
        const blockAligned = payloadLen - (payloadLen % 16);
        if (blockAligned > 0) {
          const payload = data.subarray(32, 32 + blockAligned);
          const out2 = tryIv(ivAt16, payload);
          if (out2) return out2;
          try {
            const raw = decryptCbc(ivAt16, payload, true);
            if (hasZlibMagic(raw)) return raw;
          } catch (_) {}
        }
        const fullBlockAligned = Math.floor(data.length / 16) * 16;
        if (fullBlockAligned >= 32) {
          const fullPayload = data.subarray(0, fullBlockAligned);
          const outFull = tryIv(ivAt16, fullPayload);
          if (outFull) return outFull;
          try {
            const rawFull = decryptCbc(ivAt16, fullPayload, true);
            if (hasZlibMagic(rawFull)) return rawFull;
          } catch (_) {}
        }
      }
      if (data.length >= 32) {
        const out = tryIv(data.subarray(data.length - 16), data.subarray(0, data.length - 16));
        if (out) return out;
      }
      if (ivKey) {
        const out = tryIv(ivKey);
        if (out) return out;
      }
      try {
        const ctrZero = decryptCtr(ivZero);
        if (hasZlibMagic(ctrZero)) return ctrZero;
      } catch (_) {}
      try {
        const out = decryptCbc(ivZero);
        if (hasZlibMagic(out)) return out;
        return fallback || out;
      } catch (_) {}
      return fallback;
    }

    let out = runWithKey(key);
    if (out) return out;
    if (ivChunk) {
      const derivedKey = crypto.createHmac('sha256', key).update(ivChunk).digest();
      out = runWithKey(derivedKey);
      if (out) return out;
    }
    if (keyGuid && typeof keyGuid === 'string') {
      const derivedByGuid = crypto.createHash('sha256').update(key).update(keyGuid, 'utf8').digest();
      out = runWithKey(derivedByGuid);
      if (out) return out;
    }
    return fallback;
  } catch (e) {
    return null;
  }
}

async function downloadAll(chunks, baseUrl, outDir, opts = {}) {
  const { aesKeyHex, guid, keyGuid, chunkPrefix = '' } = opts;
  const prefix = chunkPrefix.endsWith('/') ? chunkPrefix : chunkPrefix ? chunkPrefix + '/' : '';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const queue = [...chunks];
  let done = 0, skipped = 0, failed = 0;
  async function worker() {
    while (queue.length > 0) {
      const chunk = queue.shift();
      const pathSeg = String(chunk.pathDecimal ?? 0).padStart(2, '0');
      const url = `${baseUrl}${prefix}ChunksV4/${pathSeg}/${chunk.filename}`;
      const filePath = path.join(outDir, chunk.filename);
      if (fs.existsSync(filePath)) {
        skipped++;
      } else {
        try {
          let data = await get(url);
          if (aesKeyHex && data.length > 0) {
            const decrypted = tryDecryptChunk(data, aesKeyHex, chunk.guidHex, opts.keyGuid);
            if (decrypted && hasZlibMagic(decrypted)) {
              const start = findZlibOffset(decrypted.length > ZLIB_SCAN_LEN ? decrypted.subarray(0, ZLIB_SCAN_LEN) : decrypted);
              if (start >= 0) {
                try {
                  zlib.inflateSync(decrypted.subarray(start));
                  data = decrypted;
                } catch (_) {}
              }
            }
          }
          fs.writeFileSync(filePath, data);
          done++;
        } catch (e) {
          failed++;
        }
        if ((done + skipped + failed) % 10 === 0 && done + skipped + failed > 0)
          process.stdout.write(`\r  Download ${done + skipped + failed}/${chunks.length} (${done} new, ${skipped} cached, ${failed} failed)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (done + skipped + failed > 0) process.stdout.write('\r');
  return { done, skipped, failed };
}

async function repairFailedChunks(chunks, baseUrl, chunksDir, opts, getChunkUrl) {
  if (!opts.aesKeyHex) return 0;
  let repaired = 0;
  for (const chunk of chunks) {
    const filePath = path.join(chunksDir, chunk.filename);
    if (!fs.existsSync(filePath)) continue;
    let ok = false;
    try {
      const data = fs.readFileSync(filePath);
      const scan = data.length > ZLIB_SCAN_LEN ? data.subarray(0, ZLIB_SCAN_LEN) : data;
      const zlibStart = findZlibOffset(scan);
      if (zlibStart >= 0) {
        zlib.inflateSync(data.subarray(zlibStart));
        ok = true;
      }
    } catch (_) {}
    if (ok) continue;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const url = getChunkUrl(chunk);
        const data = await get(url);
        const dec = tryDecryptChunk(data, opts.aesKeyHex, chunk.guidHex, opts.keyGuid);
        if (dec && hasZlibMagic(dec)) {
          const start = findZlibOffset(dec.length > ZLIB_SCAN_LEN ? dec.subarray(0, ZLIB_SCAN_LEN) : dec);
          if (start >= 0) {
            try {
              zlib.inflateSync(dec.subarray(start));
              fs.writeFileSync(filePath, dec);
              repaired++;
              break;
            } catch (_) {}
          }
        }
        const rawZlib = findZlibOffset(data.length > ZLIB_SCAN_LEN ? data.subarray(0, ZLIB_SCAN_LEN) : data);
        if (rawZlib >= 0) {
          try {
            zlib.inflateSync(data.subarray(rawZlib));
            fs.writeFileSync(filePath, data);
            repaired++;
            break;
          } catch (_) {}
        }
      } catch (_) {}
    }
  }
  return repaired;
}

function findZlibOffset(data) {
  const idx = data.indexOf(ZLIB_MAGIC);
  if (idx >= 0) return idx;
  for (const m of ZLIB_ALT) {
    const i = data.indexOf(m);
    if (i >= 0) return i;
  }
  return -1;
}

function decompressChunk(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length >= 32 && data.subarray(0, 4).equals(CHUNK_MAGIC_OODLE)) {
    throw new Error('Oodle chunk (needs decompression)');
  }
  const zlibStart = findZlibOffset(data.length > ZLIB_SCAN_LEN ? data.slice(0, ZLIB_SCAN_LEN) : data);
  if (zlibStart < 0) throw new Error('Zlib not found');
  return zlib.inflateSync(data.slice(zlibStart));
}

function reassemble(chunkData, chunksDir, outDir, decryptOpts) {
  const { chunks, fileManifestList } = chunkData;
  const guidToChunk = new Map();
  for (const c of chunks) guidToChunk.set(c.guidHex, c);
  const chunkRequiredSize = new Map();
  for (const file of fileManifestList) {
    for (const part of file.chunkParts || []) {
      const need = (chunkRequiredSize.get(part.guidHex) || 0);
      chunkRequiredSize.set(part.guidHex, Math.max(need, part.offset + part.size));
    }
  }
  const chunkCache = new Map();
  function getDecompressed(guidHex) {
    if (chunkCache.has(guidHex)) return chunkCache.get(guidHex);
    const info = guidToChunk.get(guidHex);
    if (!info) return null;
    const chunkPath = path.join(chunksDir, info.filename);
    if (!fs.existsSync(chunkPath)) return null;
    try {
      const buf = decompressChunk(chunkPath);
      chunkCache.set(guidHex, buf);
      return buf;
    } catch (e) {
      const raw = fs.readFileSync(chunkPath);
      if (decryptOpts?.aesKeyHex) {
        const dec = tryDecryptChunk(raw, decryptOpts.aesKeyHex, guidHex, decryptOpts.keyGuid);
        if (dec && hasZlibMagic(dec)) {
          const zlibStart = findZlibOffset(dec.length > ZLIB_SCAN_LEN ? dec.subarray(0, ZLIB_SCAN_LEN) : dec);
          if (zlibStart >= 0) {
            try {
              const buf = zlib.inflateSync(dec.subarray(zlibStart));
              chunkCache.set(guidHex, buf);
              return buf;
            } catch (_) {}
          }
        }
      }
      const zlibStart = findZlibOffset(raw.length > ZLIB_SCAN_LEN ? raw.subarray(0, ZLIB_SCAN_LEN) : raw);
      if (zlibStart >= 0) {
        try {
          const buf = zlib.inflateSync(raw.subarray(zlibStart));
          chunkCache.set(guidHex, buf);
          return buf;
        } catch (_) {}
      }
      if (raw.length >= 32 && raw.subarray(0, 4).equals(CHUNK_MAGIC_OODLE) && tryOodleDecompress) {
        const required = chunkRequiredSize.get(guidHex) || 0;
        const outSize = Math.max(required, 16 * 1024 * 1024);
        let toDecompress = raw.subarray(32);
        let didDecrypt = false;
        if (decryptOpts?.aesKeyHex && toDecompress.length >= 16) {
          try {
            const keyHex = decryptOpts.aesKeyHex.replace(/^0x/i, '');
            const key = Buffer.from(keyHex, 'hex');
            if (key.length === 32) {
              const iv = raw.subarray(16, 32);
              const blockAligned = Math.floor(toDecompress.length / 16) * 16;
              if (blockAligned > 0) {
                let decrypted = null;
                try {
                  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                  decrypted = Buffer.concat([decipher.update(toDecompress.subarray(0, blockAligned)), decipher.final()]);
                } catch (_) {
                  const dec = crypto.createDecipheriv('aes-256-cbc', key, iv, { autoPadding: false });
                  decrypted = dec.update(toDecompress.subarray(0, blockAligned));
                }
                if (decrypted && decrypted.length > 0) {
                  didDecrypt = true;
                  if (!hasZlibMagic(decrypted)) toDecompress = decrypted;
                }
              }
            }
          } catch (_) {}
        }
        try {
          let buf = tryOodleDecompress(toDecompress, outSize);
          if (!buf && toDecompress.length > 4) {
            const possibleSize = toDecompress.readUInt32LE(0);
            if (possibleSize > 0 && possibleSize <= 64 * 1024 * 1024) {
              buf = tryOodleDecompress(toDecompress.subarray(4), possibleSize);
            }
          }
          if (buf && buf.length > 0) {
            chunkCache.set(guidHex, buf);
            return buf;
          }
          if (didDecrypt && toDecompress.length >= (required || 0)) {
            chunkCache.set(guidHex, toDecompress);
            return toDecompress;
          }
        } catch (e) {
          console.error('[Oodle] Decompress threw:', e.message || e);
        }
      }
      return null;
    }
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  let written = 0, partial = 0, skipped = 0;
  const partialFiles = [];
  for (const file of fileManifestList) {
    const filename = file.filename || file.name;
    if (!filename) continue;
    const safePath = filename.replace(/\.\./g, '').replace(/^\/+/, '');
    const outPath = path.join(outDir, safePath);
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const parts = file.chunkParts || [];
    const buffers = [];
    const missingGuids = [];
    for (const part of parts) {
      const buf = getDecompressed(part.guidHex);
      if (!buf) {
        missingGuids.push(part.guidHex);
        buffers.push(Buffer.alloc(part.size, 0));
        continue;
      }
      buffers.push(buf.subarray(part.offset, part.offset + part.size));
    }
    if (buffers.length === 0) {
      skipped++;
      continue;
    }
    fs.writeFileSync(outPath, Buffer.concat(buffers));
    if (missingGuids.length > 0) {
      partial++;
      partialFiles.push({ filename, missingCount: missingGuids.length, missingGuids: missingGuids.slice(0, 3) });
    } else {
      written++;
    }
  }
  return { written, partial, skipped, partialFiles };
}

async function runFromApi(outDir, chunksDir, opts = {}) {
  console.log('\nOpen this URL in your browser, sign in, and paste the authorization code:\n');
  console.log(getAuthUrl(EPIC_UEFN_CLIENT_ID));
  const code = (await ask('\nAuthorization code: ')).trim();
  if (!code) {
    console.error('No code provided.');
    rl.close();
    process.exit(1);
  }

  console.log('\nExchanging code for token...');
  const tokenData = await exchangeAuthCode(EPIC_UEFN_CLIENT_ID, EPIC_UEFN_CLIENT_SECRET, code);
  const token = tokenData.access_token;

  const mapCode = (await ask('Map code (e.g. 3225-0366-8885): ')).trim();
  if (!mapCode) {
    console.error('No map code provided.');
    rl.close();
    process.exit(1);
  }

  console.log('Fetching latest Fortnite version...');
  const { major, minor, cl } = await getLatestVersion();

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

  const baseUrl = `https://cooked-content-live-cdn.epicgames.com/valkyrie/cooked-content/${moduleId}/${major}.${minor}.${cl}/v${version}/${cookJobId}/`;
  const manifestPath = contentModule.binaries.manifest;
  const manifestUrl = baseUrl + manifestPath;
  const chunkPrefix = manifestPath.includes('/') ? manifestPath.replace(/\/[^/]*$/, '/') : '';

  let aesKeyHex = null;
  let guid = null;
  if (cooked.isEncrypted) {
    console.log('Content is encrypted; fetching decryption key...');
    const keyData = await getModuleKey(token, moduleId, version);
    aesKeyHex = keyData.aesKey;
    guid = keyData.guid;
    console.log('AES key:', aesKeyHex);
  }

  console.log('Downloading manifest...');
  const manifestBuf = await get(manifestUrl, { token });
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

  console.log('Reassembling files...');
  const re = reassemble(chunkData, chunksDir, outDir, aesKeyHex ? { aesKeyHex, keyGuid: guid } : undefined);
  console.log(`  ${re.written + re.partial} written -> ${outDir}${re.partial ? ` (${re.written} complete, ${re.partial} partial)` : ''}`);
  if (re.partialFiles?.length) {
    for (const { filename, missingCount, missingGuids } of re.partialFiles) {
      console.log(`  Partial: ${filename} (${missingCount} chunk part(s) failed to decompress; missing GUIDs: ${missingGuids.join(', ')}${missingCount > 3 ? '...' : ''})`);
    }
    console.log('  (Missing chunk ranges were zero-filled so file size is correct; content in those ranges is invalid.)');
    console.log('  Some chunks are Oodle-compressed. Set OODLE_DLL to oo2core_*_win64.dll path and install koffi for full ucas.');
    if (opts.debug) {
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
            const payloadPath = path.join(outDir, `failing_chunk_${missingGuid}.bin`);
            fs.writeFileSync(payloadPath, raw.subarray(32));
            console.log('  [debug] Payload (bytes 32+) written to:', payloadPath);
          }
        }
      }
    }
  }
  if (re.skipped > 0) console.log(`  ${re.skipped} skipped (missing chunks)`);

  console.log('\nDone. Output:', fileManifestList.map((f) => f.filename).filter(Boolean).join(', ') || 'none');
  console.log('Path:', path.resolve(outDir));
  const paksPath = getPaksPath(opts.config);
  if (paksPath) copyGlobalUcasUtoc(paksPath, outDir);
}

async function main() {
  const config = await ensureConfig();
  initOodle(config);
  const args = process.argv.slice(2);
  let manifestPath = null;
  let outDir = path.resolve(config.defaultPluginsDir || path.join(process.cwd(), 'plugins'));
  let chunksDir = path.join(process.cwd(), 'chunks');
  let baseUrl = null;

  let debug = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) outDir = path.resolve(args[++i]);
    else if (args[i] === '--base' && args[i + 1]) baseUrl = (args[++i]).replace(/\/?$/, '/');
    else if (args[i] === '--chunks' && args[i + 1]) chunksDir = path.resolve(args[++i]);
    else if (args[i] === '--debug') debug = true;
    else if (!args[i].startsWith('--')) manifestPath = args[i];
  }

  const hasLocalManifest = manifestPath && fs.existsSync(manifestPath);
  if (!hasLocalManifest) {
    await runFromApi(outDir, chunksDir, { debug, config });
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

  console.log('Downloading chunks...');
  const dl = await downloadAll(chunks, baseUrl, chunksDir);
  console.log(`  ${dl.done} new, ${dl.skipped} cached, ${dl.failed} failed`);

  console.log('Reassembling files...');
  const re = reassemble(chunkData, chunksDir, outDir);
  console.log(`  ${re.written + re.partial} written -> ${outDir}${re.partial ? ` (${re.written} complete, ${re.partial} partial)` : ''}`);
  if (re.partialFiles?.length) {
    for (const { filename, missingCount, missingGuids } of re.partialFiles) {
      console.log(`  Partial: ${filename} (${missingCount} chunk part(s) failed to decompress; missing GUIDs: ${missingGuids.join(', ')}${missingCount > 3 ? '...' : ''})`);
    }
  }
  if (re.skipped > 0) console.log(`  ${re.skipped} skipped (missing chunks)`);

  console.log('Done. Output:', fileManifestList.map((f) => f.filename).filter(Boolean).join(', ') || 'none');
  console.log('Path:', path.resolve(outDir));
  const paksPath = getPaksPath(config);
  if (paksPath) copyGlobalUcasUtoc(paksPath, outDir);
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
