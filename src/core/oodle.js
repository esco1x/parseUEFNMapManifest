const fs = require('fs');
const path = require('path');

let tryOodleDecompress = null;

function initOodle(config, debug = false, projectRoot) {
  const scriptDir = projectRoot;
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
        if (debug) console.log('[Oodle] Copied', match, 'from game to project folder.');
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
    if (debug) console.log('[Oodle] DLL loaded:', oodleDll);
  } catch (e) {
    console.error('[Oodle] Failed to load:', e.message || e);
  }
}

module.exports = { initOodle, getTryOodleDecompress: () => tryOodleDecompress };
