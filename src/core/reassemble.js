const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tryDecryptChunk } = require('./chunkDecrypt');
const { decompressChunkToBuffer } = require('./chunkDecompress');
const { WORKER_READ_TIMEOUT_MS, readExactlyWithTimeout } = require('./streamRead');

async function reassemble(chunkData, chunksDir, outDir, decryptOpts, opts = {}) {
  const entryScriptPath = opts.entryScriptPath;
  if (!entryScriptPath) throw new Error('reassemble: entryScriptPath is required');
  const debug = !!opts.debug;
  const pluginTag = opts.pluginTag || null;
  const debugDir = debug ? path.join(outDir, 'debug') : null;
  if (debugDir && !fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
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
  const useWorker = !decryptOpts?.aesKeyHex && process.env.UEFN_DECOMPRESS_WORKER !== '0';
  let worker = null;
  function startWorker() {
    if (worker) try { worker.kill(); } catch (_) {}
    const env = { ...process.env };
    if (process.env.UEFN_DEBUG_WORKER === '1') env.UEFN_DEBUG_WORKER = '1';
    worker = spawn(process.execPath, [entryScriptPath, '--worker'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: path.dirname(entryScriptPath),
      env,
    });
    worker.stdin.setEncoding('utf8');
    return worker;
  }
  async function getDecompressedViaWorker(guidHex) {
    const info = guidToChunk.get(guidHex);
    if (!info) return null;
    const chunkPath = path.resolve(chunksDir, info.filename);
    const requiredSize = chunkRequiredSize.get(guidHex) || 0;
    const msg = JSON.stringify({
      chunkPath,
      cwd: process.cwd(),
      guidHex,
      decryptOpts: decryptOpts || null,
      requiredSize,
    }) + '\n';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!worker || worker.exitCode != null) worker = startWorker();
      try {
        await new Promise((resolve, reject) => {
          worker.stdin.write(msg, (err) => { if (err) reject(err); else resolve(); });
        });
        const lenBuf = await readExactlyWithTimeout(worker.stdout, 4, WORKER_READ_TIMEOUT_MS);
        const len = lenBuf.readUInt32LE(0);
        if (len === 0) return null;
        return await readExactlyWithTimeout(worker.stdout, len, WORKER_READ_TIMEOUT_MS);
      } catch (e) {
        if (worker) try { worker.kill(); worker = null; } catch (_) {}
        if (attempt === 1) return null;
      }
    }
    return null;
  }
  async function getPartBufferAsync(part) {
    const offset = Number(part.offset) || 0;
    const size = Number(part.size) || 0;
    const info = guidToChunk.get(part.guidHex);
    let buf;
    if (useWorker) {
      buf = await getDecompressedViaWorker(part.guidHex);
    } else {
      if (!info) return { buffer: Buffer.alloc(size, 0), missing: true };
      try {
        buf = decompressChunkToBuffer(
          path.join(chunksDir, info.filename),
          part.guidHex,
          decryptOpts,
          chunkRequiredSize.get(part.guidHex) || 0,
          info.fileSize
        );
      } catch (_) {
        buf = null;
      }
    }
    if (!buf) {
      if (decryptOpts?.aesKeyHex && info) {
        try {
          const chunkPath = path.join(chunksDir, info.filename);
          if (fs.existsSync(chunkPath)) {
            const raw = fs.readFileSync(chunkPath);
            const base = path.basename(info.filename, '.chunk');
            const hashPart = base.split('_')[0];
            const chunkHashHex = hashPart && hashPart.length === 16 ? hashPart : null;
            const dec = tryDecryptChunk(raw, decryptOpts.aesKeyHex, part.guidHex, decryptOpts.keyGuid, chunkHashHex, info.fileSize);
            const required = chunkRequiredSize.get(part.guidHex) || 0;
            if (debug) {
              const line = `${part.guidHex} decLen=${dec ? dec.length : 0} rawLen=${raw.length} required=${required}\n`;
              fs.appendFileSync(path.join(debugDir, 'missing_chunks_debug.txt'), line);
            }
            if (debug && !dec && raw.length === 1048642) {
              const hexPath = path.join(debugDir, 'failing_chunk_raw_hex.txt');
              if (!fs.existsSync(hexPath)) {
                const first256 = raw.subarray(0, Math.min(256, raw.length));
                const last128 = raw.subarray(Math.max(0, raw.length - 128));
                const lines = [
                  `ChunkGuid: ${part.guidHex}`,
                  `rawLen: ${raw.length} fileSize: ${info.fileSize || 'n/a'}`,
                  '',
                  'First 256 bytes (hex):',
                  first256.toString('hex').replace(/(.{64})/g, '$1\n').trim(),
                  '',
                  'Last 128 bytes (hex):',
                  last128.toString('hex').replace(/(.{64})/g, '$1\n').trim()
                ];
                fs.writeFileSync(hexPath, lines.join('\n'));
              }
            }
            if (process.env.UEFN_KEEP_RAW_MISSING === '1') {
              const start = Math.min(offset, raw.length);
              const end = Math.min(offset + size, raw.length);
              const slice = raw.subarray(start, end);
              buf = slice.length < size ? Buffer.concat([slice, Buffer.alloc(size - slice.length, 0)]) : Buffer.from(slice);
            }
          }
        } catch (_) {}
      }
      if (!buf) return { buffer: Buffer.alloc(size, 0), missing: true };
      return { buffer: buf, missing: true };
    }
    const start = Math.min(offset, buf.length);
    const end = Math.min(offset + size, buf.length);
    const slice = buf.subarray(start, end);
    const buffer = slice.length < size
      ? Buffer.concat([slice, Buffer.alloc(size - slice.length, 0)])
      : Buffer.from(slice);
    return { buffer, missing: false };
  }
  if (useWorker) {
    worker = startWorker();
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (debug) {
    const missingChunksDebugPath = path.join(debugDir, 'missing_chunks_debug.txt');
    try { fs.unlinkSync(missingChunksDebugPath); } catch (_) {}
    const decodePath = path.join(debugDir, 'plugin.decode.json');
    fs.writeFileSync(decodePath, JSON.stringify({ chunks: chunkData.chunks, files: chunkData.fileManifestList }, null, 2));
    console.log('  [debug] Chunk/manifest data written to', decodePath);
  }
  if (decryptOpts?.aesKeyHex && debug) {
    const firstFile = fileManifestList.find((f) => (f.chunkParts || []).length > 0);
    const firstPart = firstFile?.chunkParts?.[0];
    const info = firstPart ? guidToChunk.get(firstPart.guidHex) : null;
    if (info) {
      const chunkPath = path.resolve(chunksDir, info.filename);
      if (fs.existsSync(chunkPath)) {
        try {
          const raw = fs.readFileSync(chunkPath);
          const dec = tryDecryptChunk(raw, decryptOpts.aesKeyHex, firstPart.guidHex, decryptOpts.keyGuid);
          const decLen = dec ? dec.length : 0;
          const lines = ['decLen=' + decLen, 'rawLen=' + raw.length];
          if (dec && dec.length >= 64) {
            lines.push('first64hex=' + dec.subarray(0, 64).toString('hex'));
            fs.writeFileSync(path.join(debugDir, 'decrypt_first_chunk.bin'), dec);
          }
          const debugPath = path.join(debugDir, 'decrypt_debug.txt');
          fs.writeFileSync(debugPath, lines.join('\n'));
          console.log('  [decrypt debug]', debugPath, '- decLen=' + decLen + ' (if 0, decryption failed)');
        } catch (_) {}
      }
    }
  }
  let written = 0, partial = 0, skipped = 0;
  const partialFiles = [];
  for (const file of fileManifestList) {
    const filename = file.filename || file.name;
    if (!filename) continue;
    const ext = path.extname(filename).toLowerCase();
    const displayName =
      pluginTag && /^plugin\.(pak|utoc|ucas|sig)$/i.test(filename)
        ? `${pluginTag}${ext}`
        : filename;
    const safePath = filename.replace(/\.\./g, '').replace(/^\/+/, '');
    const outPath = path.join(outDir, safePath);
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const parts = file.chunkParts || [];
    console.log(`  Writing ${displayName}...`);
    const missingGuids = [];
    if (parts.length === 0) {
      fs.writeFileSync(outPath, Buffer.alloc(0));
    } else {
      const fd = fs.openSync(outPath, 'w');
      const totalParts = parts.length;
      try {
        for (let i = 0; i < totalParts; i++) {
          const part = parts[i];
          const partSize = Number(part.size) || 0;
          let buf;
          try {
            const out = await getPartBufferAsync(part);
            if (out.missing) missingGuids.push(part.guidHex);
            buf = out.buffer;
          } catch (partErr) {
            console.error(`  Part ${i + 1}/${totalParts} failed (${partErr.message || partErr}), writing zeros`);
            buf = Buffer.alloc(partSize, 0);
            missingGuids.push(part.guidHex || '?');
          }
          fs.writeSync(fd, buf, 0, buf.length, null);
          if (typeof global.gc === 'function') global.gc();
          if ((i + 1) % 25 === 0 || i === totalParts - 1) {
            process.stdout.write(`  ${displayName}: ${i + 1}/${totalParts} parts\r`);
            if ((i + 1) % 25 === 0) await new Promise((r) => setImmediate(r));
          }
        }
        if (totalParts > 0) process.stdout.write('\n');
      } finally {
        fs.closeSync(fd);
      }
    }
    if (parts.length === 0) {
      written++;
      continue;
    }
    if (missingGuids.length > 0) {
      partial++;
      partialFiles.push({ filename, missingCount: missingGuids.length, missingGuids: missingGuids.slice(0, 3) });
    } else {
      written++;
    }
  }
  if (worker) try { worker.kill(); worker = null; } catch (_) {}
  return { written, partial, skipped, partialFiles };
}

module.exports = { reassemble };
