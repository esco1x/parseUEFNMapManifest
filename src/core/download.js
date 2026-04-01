const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { CONCURRENCY, ZLIB_SCAN_LEN } = require('./constants');
const { get } = require('./http');
const { tryDecryptChunk, hasZlibMagic } = require('./chunkDecrypt');
const { findZlibOffset } = require('./chunkDecompress');

async function downloadAll(chunks, baseUrl, outDir, opts = {}) {
  const { aesKeyHex, keyGuid, chunkPrefix = '' } = opts;
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
            const base = String(chunk.filename || '').replace(/\.chunk$/i, '');
            const hashPart = base.split('_')[0];
            const chunkHashHex = hashPart && hashPart.length === 16 ? hashPart : null;
            const decrypted = tryDecryptChunk(data, aesKeyHex, chunk.guidHex, opts.keyGuid, chunkHashHex, chunk.fileSize);
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
  if (done + skipped + failed > 0) process.stdout.write('\n');
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
        const base = String(chunk.filename || '').replace(/\.chunk$/i, '');
        const hashPart = base.split('_')[0];
        const chunkHashHex = hashPart && hashPart.length === 16 ? hashPart : null;
        const dec = tryDecryptChunk(data, opts.aesKeyHex, chunk.guidHex, opts.keyGuid, chunkHashHex, chunk.fileSize);
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

module.exports = { downloadAll, repairFailedChunks };
