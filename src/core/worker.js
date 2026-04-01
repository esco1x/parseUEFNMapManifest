const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { ROOT } = require('./paths');
const { initOodle, getTryOodleDecompress } = require('./oodle');
const { CHUNK_MAGIC_OODLE } = require('./constants');
const { tryDecryptChunk } = require('./chunkDecrypt');
const { decompressChunkToBuffer } = require('./chunkDecompress');

async function runWorker() {
  initOodle({}, false, ROOT);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  let firstChunkLogged = false;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let out = null;
    try {
      const msg = JSON.parse(line);
      const chunkPath = path.isAbsolute(msg.chunkPath) ? msg.chunkPath : path.join(msg.cwd || process.cwd(), msg.chunkPath);
      const requiredSize = typeof msg.requiredSize === 'number' ? msg.requiredSize : 0;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        const hasKey = !!(msg.decryptOpts?.aesKeyHex);
        const raw = fs.existsSync(chunkPath) ? fs.readFileSync(chunkPath) : null;
        const dec = raw && hasKey ? tryDecryptChunk(raw, msg.decryptOpts.aesKeyHex, msg.guidHex, msg.decryptOpts.keyGuid) : null;
        const decLen = dec ? dec.length : 0;
        let oodleCalled = false, oodleOk = false;
        const tryOodleDecompress = getTryOodleDecompress();
        if (dec && decLen > 0 && raw && raw.length >= 4 && raw.subarray(0, 4).equals(CHUNK_MAGIC_OODLE) && tryOodleDecompress) {
          const outSize = Math.max(requiredSize || 0, 16 * 1024 * 1024);
          try {
            let buf = tryOodleDecompress(dec, outSize);
            oodleCalled = true;
            if (!buf && dec.length > 4) {
              const possibleSize = dec.readUInt32LE(0);
              if (possibleSize > 0 && possibleSize <= 64 * 1024 * 1024) buf = tryOodleDecompress(dec.subarray(4), possibleSize);
            }
            if (!buf && dec.length >= 16) {
              const sizeAt12 = dec.readUInt32LE(12);
              if (sizeAt12 > 0 && sizeAt12 <= 64 * 1024 * 1024) buf = tryOodleDecompress(dec.subarray(16), sizeAt12);
            }
            oodleOk = !!(buf && buf.length > 0);
          } catch (e) {
            process.stderr.write(`[worker] Oodle error: ${e.message || e}\n`);
          }
        }
        process.stderr.write(`[worker] first chunk: hasKey=${hasKey} rawLen=${raw?.length ?? 0} decLen=${decLen} oodleCalled=${oodleCalled} oodleOk=${oodleOk}\n`);
      }
      out = decompressChunkToBuffer(chunkPath, msg.guidHex, msg.decryptOpts || null, requiredSize);
    } catch (_) {}
    const buf = out && Buffer.isBuffer(out) ? out : Buffer.alloc(0);
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(buf.length, 0);
    process.stdout.write(lenBuf);
    if (buf.length > 0) process.stdout.write(buf);
  }
}

module.exports = { runWorker };
