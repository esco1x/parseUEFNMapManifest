const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ZLIB_MAGIC, ZLIB_ALT, CHUNK_MAGIC_OODLE, ZLIB_SCAN_LEN } = require('./constants');
const { hasZlibMagic, tryDecryptChunk } = require('./chunkDecrypt');
const { getTryOodleDecompress } = require('./oodle');

const EXTENDED_ZLIB_SCAN_LEN = 256 * 1024;

function findZlibOffset(data) {
  const idx = data.indexOf(ZLIB_MAGIC);
  if (idx >= 0) return idx;
  for (const m of ZLIB_ALT) {
    const i = data.indexOf(m);
    if (i >= 0) return i;
  }
  return -1;
}

function tryInflateAny(buf, requiredSize) {
  const scanLen = Math.min(buf.length, Math.max(ZLIB_SCAN_LEN, EXTENDED_ZLIB_SCAN_LEN));
  const scan = scanLen < buf.length ? buf.subarray(0, scanLen) : buf;

  const offsets = new Set();
  for (const m of [ZLIB_MAGIC, ...ZLIB_ALT]) {
    let at = 0;
    while (at >= 0 && at < scan.length) {
      const i = scan.indexOf(m, at);
      if (i < 0) break;
      offsets.add(i);
      at = i + 1;
    }
  }

  const sorted = Array.from(offsets).sort((a, b) => a - b);
  for (const off of sorted) {
    try {
      const out = zlib.inflateSync(buf.subarray(off));
      if (!requiredSize || out.length >= requiredSize) return out;
    } catch (_) {}
  }

  return null;
}

function decompressChunk(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length >= 32 && data.subarray(0, 4).equals(CHUNK_MAGIC_OODLE)) {
    throw new Error('Oodle chunk (needs decompression)');
  }
  const out = tryInflateAny(data);
  if (!out) throw new Error('Zlib not found');
  return out;
}

function decompressChunkToBuffer(chunkPath, guidHex, decryptOpts, requiredSize, chunkFileSize) {
  const tryOodleDecompress = getTryOodleDecompress();
  if (!fs.existsSync(chunkPath)) return null;
  try {
    return decompressChunk(chunkPath);
  } catch (e) {
    const raw = fs.readFileSync(chunkPath);
    if (decryptOpts?.aesKeyHex) {
      const base = path.basename(chunkPath, '.chunk');
      const parts = base.split('_');
      const chunkHashHex = parts[0] && parts[0].length === 16 ? parts[0] : null;
      const dec = tryDecryptChunk(raw, decryptOpts.aesKeyHex, guidHex, decryptOpts.keyGuid, chunkHashHex, chunkFileSize);
      if (dec && dec.length > 0) {
        const zOut = tryInflateAny(dec, requiredSize || null);
        if (zOut) return zOut;
        if (dec.length >= (requiredSize || 0)) return dec;
        if (dec.length >= 4 && dec.subarray(0, 4).equals(CHUNK_MAGIC_OODLE) && tryOodleDecompress) {
          const outSize = Math.max(requiredSize || 0, 16 * 1024 * 1024);
          for (const toDecompress of [dec, dec.length >= 32 ? dec.subarray(32) : null]) {
            if (!toDecompress || toDecompress.length === 0) continue;
            try {
              let buf = tryOodleDecompress(toDecompress, outSize);
              if (!buf && toDecompress.length > 4) {
                const possibleSize = toDecompress.readUInt32LE(0);
                if (possibleSize > 0 && possibleSize <= 64 * 1024 * 1024) {
                  buf = tryOodleDecompress(toDecompress.subarray(4), possibleSize);
                }
              }
              if (!buf && toDecompress.length >= 16) {
                const sizeAt12 = toDecompress.readUInt32LE(12);
                if (sizeAt12 > 0 && sizeAt12 <= 64 * 1024 * 1024) {
                  buf = tryOodleDecompress(toDecompress.subarray(16), sizeAt12);
                }
              }
              if (!buf && toDecompress.length >= 8) {
                const sizeAt4 = toDecompress.readUInt32LE(4);
                if (sizeAt4 > 0 && sizeAt4 <= 64 * 1024 * 1024) {
                  buf = tryOodleDecompress(toDecompress.subarray(8), sizeAt4);
                }
              }
              if (buf && buf.length > 0) return buf;
              if (toDecompress.length >= (requiredSize || 0)) return toDecompress;
            } catch (_) {}
          }
          if (dec.length >= (requiredSize || 0)) return dec;
        }
        if (dec.length >= 36 && dec.subarray(32, 36).equals(CHUNK_MAGIC_OODLE) && tryOodleDecompress) {
          const outSize = Math.max(requiredSize || 0, 16 * 1024 * 1024);
          try {
            const buf = tryOodleDecompress(dec.subarray(32), outSize);
            if (buf && buf.length > 0) return buf;
          } catch (_) {}
        }
      }
    }
    const zOut = tryInflateAny(raw, requiredSize || null);
    if (zOut) return zOut;
    if (raw.length >= 32 && raw.subarray(0, 4).equals(CHUNK_MAGIC_OODLE) && tryOodleDecompress && !decryptOpts?.aesKeyHex) {
      const outSize = Math.max(requiredSize || 0, 16 * 1024 * 1024);
      const toDecompress = raw.subarray(32);
      try {
        let buf = tryOodleDecompress(toDecompress, outSize);
        if (!buf && toDecompress.length > 4) {
          const possibleSize = toDecompress.readUInt32LE(0);
          if (possibleSize > 0 && possibleSize <= 64 * 1024 * 1024) {
            buf = tryOodleDecompress(toDecompress.subarray(4), possibleSize);
          }
        }
        if (buf && buf.length > 0) return buf;
      } catch (_) {}
    }
    return null;
  }
}

module.exports = { findZlibOffset, decompressChunk, decompressChunkToBuffer };
