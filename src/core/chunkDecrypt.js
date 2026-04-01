const crypto = require('crypto');
const { ZLIB_MAGIC, ZLIB_ALT, ZLIB_SCAN_LEN } = require('./constants');

function hasZlibMagic(buf) {
  const slice = buf.length > ZLIB_SCAN_LEN ? buf.subarray(0, ZLIB_SCAN_LEN) : buf;
  if (slice.indexOf(ZLIB_MAGIC) >= 0) return true;
  for (const m of ZLIB_ALT) {
    if (slice.indexOf(m) >= 0) return true;
  }
  return false;
}

function keyGuidToIv(keyGuid) {
  if (keyGuid == null) return null;
  let s = typeof keyGuid === 'string' ? keyGuid : (keyGuid.Guid || keyGuid.guid || String(keyGuid));
  s = s.replace(/\s/g, '').replace(/^\{|\}$/g, '').replace(/-/g, '');
  if (s.length === 32 && /^[0-9A-Fa-f]{32}$/.test(s)) return Buffer.from(s, 'hex');
  return null;
}

function tryDecryptChunk(data, aesKeyHex, chunkGuidHex, keyGuid, chunkHashHex, chunkFileSize) {
  try {
    const keyHex = aesKeyHex.replace(/^0x/i, '');
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) return null;
    const ivChunk = chunkGuidHex && /^[0-9A-Fa-f]{32}$/.test(chunkGuidHex)
      ? Buffer.from(chunkGuidHex, 'hex') : null;
    const ivKey = keyGuidToIv(keyGuid);
    const ivZero = Buffer.alloc(16, 0);
    let ivHash = null;
    if (chunkHashHex && /^[0-9A-Fa-f]{16}$/.test(chunkHashHex)) {
      const hash8 = Buffer.from(chunkHashHex, 'hex');
      ivHash = Buffer.alloc(16);
      hash8.copy(ivHash, 0);
    }
    let ivFileSize = null;
    if (typeof chunkFileSize === 'number' && chunkFileSize > 0) {
      const fsBuf = Buffer.allocUnsafe(8);
      fsBuf.writeBigUInt64LE(BigInt(Math.floor(chunkFileSize)), 0);
      ivFileSize = crypto.createHash('sha256').update(fsBuf).digest().subarray(0, 16);
    }
    let fallback = null;

    function runWithKey(keyBuf) {
      const blockAlignedFull = Math.floor(data.length / 16) * 16;
      if (blockAlignedFull >= 16) {
        try {
          const decipherEcb = crypto.createDecipheriv('aes-256-ecb', keyBuf, null);
          const outEcb = Buffer.concat([decipherEcb.update(data.subarray(0, blockAlignedFull)), decipherEcb.final()]);
          if (hasZlibMagic(outEcb)) return outEcb;
          if (!fallback) fallback = outEcb;
        } catch (_) {}
        try {
          const decipherEcbNoPad = crypto.createDecipheriv('aes-256-ecb', keyBuf, null, { autoPadding: false });
          const outEcbRaw = Buffer.concat([decipherEcbNoPad.update(data.subarray(0, blockAlignedFull)), decipherEcbNoPad.final()]);
          if (hasZlibMagic(outEcbRaw)) return outEcbRaw;
          if (!fallback) fallback = outEcbRaw;
        } catch (_) {}
      }
      const decryptCbc = (iv, payload, noPadding) => {
        const opts = noPadding ? { autoPadding: false } : {};
        const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv, opts);
        return Buffer.concat([decipher.update(payload || data), decipher.final()]);
      };
      const decryptCtr = (iv) => {
        const decipher = crypto.createDecipheriv('aes-256-ctr', keyBuf, iv);
        return Buffer.concat([decipher.update(data), decipher.final()]);
      };
      const decryptCtrSlice = (iv, payload) => {
        const decipher = crypto.createDecipheriv('aes-256-ctr', keyBuf, iv);
        return Buffer.concat([decipher.update(payload), decipher.final()]);
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
        const ivChunkXorKey = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) ivChunkXorKey[i] = ivChunk[i] ^ keyBuf[i];
        const outXor = tryIv(ivChunkXorKey);
        if (outXor) return outXor;
        const blockAlignedXor = Math.floor(data.length / 16) * 16;
        if (blockAlignedXor >= 16) {
          try {
            const rawXor = decryptCbc(ivChunkXorKey, data.subarray(0, blockAlignedXor), true);
            if (hasZlibMagic(rawXor)) return rawXor;
            if (!fallback) fallback = rawXor;
          } catch (_) {}
        }
        const ivChunkRev = Buffer.from(ivChunk);
        ivChunkRev.reverse();
        const outRev = tryIv(ivChunkRev);
        if (outRev) return outRev;
        const ivChunkLE = Buffer.alloc(16);
        for (let i = 0; i < 4; i++) {
          const j = i * 4;
          ivChunkLE[j] = ivChunk[j + 3];
          ivChunkLE[j + 1] = ivChunk[j + 2];
          ivChunkLE[j + 2] = ivChunk[j + 1];
          ivChunkLE[j + 3] = ivChunk[j];
        }
        const outLE = tryIv(ivChunkLE);
        if (outLE) return outLE;
        const blockAlignedFullLE = Math.floor(data.length / 16) * 16;
        if (blockAlignedFullLE >= 16) {
          try {
            const rawBaLE = decryptCbc(ivChunkLE, data.subarray(0, blockAlignedFullLE), true);
            if (hasZlibMagic(rawBaLE)) return rawBaLE;
            if (!fallback) fallback = rawBaLE;
          } catch (_) {}
        }
        const sha = crypto.createHash('sha256').update(ivChunk).digest();
        const out2 = tryIv(sha.subarray(0, 16));
        if (out2) return out2;
        try {
          const ctrOut = decryptCtr(ivChunk);
          if (hasZlibMagic(ctrOut)) return ctrOut;
        } catch (_) {}
        const blockAlignedFullInner = Math.floor(data.length / 16) * 16;
        if (blockAlignedFullInner >= 32) {
          try {
            const rawBa = decryptCbc(ivChunk, data.subarray(0, blockAlignedFullInner), true);
            if (hasZlibMagic(rawBa)) return rawBa;
            if (!fallback) fallback = rawBa;
          } catch (_) {}
        }
      }
      if (ivHash && ivChunk) {
        const ivCombo = crypto.createHash('sha256').update(ivChunk).update(ivHash).digest().subarray(0, 16);
        const outCombo = tryIv(ivCombo);
        if (outCombo) return outCombo;
        const blockCombo = Math.floor(data.length / 16) * 16;
        if (blockCombo >= 16) {
          try {
            const rawCombo = decryptCbc(ivCombo, data.subarray(0, blockCombo), true);
            if (hasZlibMagic(rawCombo)) return rawCombo;
            if (!fallback) fallback = rawCombo;
          } catch (_) {}
        }
      }
      if (ivFileSize) {
        const out = tryIv(ivFileSize);
        if (out) return out;
        const blockFs = Math.floor(data.length / 16) * 16;
        if (blockFs >= 16) {
          try {
            const rawFs = decryptCbc(ivFileSize, data.subarray(0, blockFs), true);
            if (hasZlibMagic(rawFs)) return rawFs;
            if (!fallback) fallback = rawFs;
          } catch (_) {}
        }
      }
      if (ivHash) {
        const out = tryIv(ivHash);
        if (out) return out;
        const blockAlignedHash = Math.floor(data.length / 16) * 16;
        if (blockAlignedHash >= 16) {
          try {
            const rawBa = decryptCbc(ivHash, data.subarray(0, blockAlignedHash), true);
            if (hasZlibMagic(rawBa)) return rawBa;
            if (!fallback) fallback = rawBa;
          } catch (_) {}
        }
        const ivHashSha = crypto.createHash('sha256').update(ivHash).digest().subarray(0, 16);
        const outSha = tryIv(ivHashSha);
        if (outSha) return outSha;
        if (blockAlignedHash >= 16) {
          try {
            const rawBaSha = decryptCbc(ivHashSha, data.subarray(0, blockAlignedHash), true);
            if (hasZlibMagic(rawBaSha)) return rawBaSha;
            if (!fallback) fallback = rawBaSha;
          } catch (_) {}
        }
      }
      if (data.length >= 32) {
        const out = tryIv(data.subarray(0, 16), data.subarray(16));
        if (out) return out;
        const payloadFrom16 = data.length - 16;
        const blockFrom16 = payloadFrom16 - (payloadFrom16 % 16);
        if (blockFrom16 > 0) {
          try {
            const rawFirst = decryptCbc(data.subarray(0, 16), data.subarray(16, 16 + blockFrom16), true);
            if (hasZlibMagic(rawFirst)) return rawFirst;
            if (!fallback) fallback = rawFirst;
          } catch (_) {}
        }
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
            if (!fallback) fallback = raw;
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
            if (!fallback) fallback = rawFull;
          } catch (_) {}
        }
      }
      if (data.length >= 32) {
        const out = tryIv(data.subarray(data.length - 16), data.subarray(0, data.length - 16));
        if (out) return out;
        const payloadToLast = data.length - 16;
        const blockToLast = payloadToLast - (payloadToLast % 16);
        if (blockToLast >= 16) {
          try {
            const rawLast = decryptCbc(data.subarray(data.length - 16), data.subarray(0, blockToLast), true);
            if (hasZlibMagic(rawLast)) return rawLast;
            if (!fallback) fallback = rawLast;
          } catch (_) {}
        }
      }
      for (const ivOffset of [2, 18, 34]) {
        if (data.length >= ivOffset + 16 + 16) {
          const ivAtOff = data.subarray(ivOffset, ivOffset + 16);
          const payloadFromOff = data.length - ivOffset;
          const blockFromOff = payloadFromOff - (payloadFromOff % 16);
          if (blockFromOff >= 16) {
            try {
              const rawOff = decryptCbc(ivAtOff, data.subarray(ivOffset, ivOffset + blockFromOff), true);
              if (hasZlibMagic(rawOff)) return rawOff;
              if (!fallback) fallback = rawOff;
            } catch (_) {}
          }
        }
      }
      const oneMiB = 1048576;
      if (data.length >= 18 + oneMiB) {
        const ivAt2 = data.subarray(2, 18);
        try {
          const raw2 = decryptCbc(ivAt2, data.subarray(18, 18 + oneMiB), true);
          if (hasZlibMagic(raw2)) return raw2;
          if (!fallback) fallback = raw2;
        } catch (_) {}
        try {
          const ctr2 = decryptCtrSlice(ivAt2, data.subarray(18));
          if (hasZlibMagic(ctr2)) return ctr2;
          if (!fallback) fallback = ctr2;
        } catch (_) {}
      }
      if (data.length >= 16 + 16) {
        const ivFirst = data.subarray(0, 16);
        try {
          const ctrFirst = decryptCtrSlice(ivFirst, data.subarray(16));
          if (hasZlibMagic(ctrFirst)) return ctrFirst;
          if (!fallback) fallback = ctrFirst;
        } catch (_) {}
      }
      if (data.length > oneMiB && data.length - oneMiB >= 16) {
        const ivTrailer = data.subarray(oneMiB, oneMiB + 16);
        try {
          const raw1M = decryptCbc(ivTrailer, data.subarray(0, oneMiB), true);
          if (hasZlibMagic(raw1M)) return raw1M;
          if (!fallback) fallback = raw1M;
        } catch (_) {}
      }
      if (data.length >= 66 + oneMiB) {
        const payload66 = data.subarray(66, 66 + oneMiB);
        for (const ivStart of [0, 16, 32, 50]) {
          if (ivStart + 16 <= 66) {
            const iv66 = data.subarray(ivStart, ivStart + 16);
            try {
              const raw66 = decryptCbc(iv66, payload66, true);
              if (hasZlibMagic(raw66)) return raw66;
              if (!fallback) fallback = raw66;
            } catch (_) {}
          }
        }
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
    if (keyGuid != null) {
      const guidStr = typeof keyGuid === 'string' ? keyGuid : (keyGuid.Guid || keyGuid.guid || String(keyGuid));
      const derivedByGuid = crypto.createHash('sha256').update(key).update(guidStr, 'utf8').digest();
      out = runWithKey(derivedByGuid);
      if (out) return out;
    }
    return fallback;
  } catch (e) {
    return null;
  }
}

module.exports = { hasZlibMagic, keyGuidToIv, tryDecryptChunk };
