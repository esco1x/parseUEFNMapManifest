const fs = require('fs');
const pako = require('pako');
const { HEADER_MAGIC, ZLIB_MAGIC } = require('./constants');

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
  const windowSizes = [];
  const fileSizes = [];
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
  for (let i = 0; i < count; i++) {
    windowSizes.push(data.readUInt32LE(pos));
    pos += 4;
  }
  for (let i = 0; i < count; i++) {
    fileSizes.push(Number(data.readBigUInt64LE(pos)));
    pos += 8;
  }
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const guidHex = guids[i].map((x) => x.toString(16).toUpperCase().padStart(8, '0')).join('');
    const hashHex = hashes[i].toString(16).toUpperCase().padStart(16, '0');
    const pathDecimal = groupNums[i];
    chunks.push({
      pathDecimal,
      filename: hashHex + '_' + guidHex + '.chunk',
      guidHex,
      windowSize: windowSizes[i],
      fileSize: fileSizes[i],
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

module.exports = {
  readFString,
  parseFileManifestList,
  parseEpicManifestBody,
  parseUEFNManifestFromBuffer,
  parseUEFNManifest,
};
