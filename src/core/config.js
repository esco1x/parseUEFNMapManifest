const fs = require('fs');
const path = require('path');
const { CONFIG_PATH } = require('./paths');

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

function copyPakArtifacts(pakDir, outDir) {
  if (!pakDir || !fs.existsSync(pakDir)) return 0;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  let copied = 0;
  const exts = new Set(['.pak', '.utoc', '.ucas', '.sig']);
  try {
    for (const name of fs.readdirSync(pakDir)) {
      if (!/^global\./i.test(name)) continue;
      const ext = path.extname(name).toLowerCase();
      if (!exts.has(ext)) continue;
      const src = path.join(pakDir, name);
      const stat = fs.statSync(src);
      if (!stat.isFile()) continue;
      fs.copyFileSync(src, path.join(outDir, name));
      copied++;
    }
  } catch (_) {}
  return copied;
}

function getPaksPath(config) {
  return config?.fortniteGamePath && fs.existsSync(config.fortniteGamePath)
    ? path.join(config.fortniteGamePath, 'Content', 'Paks')
    : null;
}

async function ensureConfig(ask) {
  let config = loadConfig();
  const defaultOutputDir = path.join(process.cwd(), 'output');
  if (!config.defaultOutputDir) config.defaultOutputDir = defaultOutputDir;
  let needSave = false;
  if (config.defaultPluginsDir && !config.defaultOutputDir) config.defaultOutputDir = config.defaultPluginsDir;
  if (config.defaultPluginsDir) {
    delete config.defaultPluginsDir;
    needSave = true;
  }
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

    const outputPrompt = (await ask(`Output folder [default: ${config.defaultOutputDir}]: `)).trim();
    const resolvedOutput = path.resolve(outputPrompt || config.defaultOutputDir);
    config.defaultOutputDir = resolvedOutput;
    needSave = true;
  }

  if (needSave) saveConfig(config);
  return config;
}

module.exports = {
  loadConfig,
  saveConfig,
  autoDetectFortniteGame,
  copyGlobalUcasUtoc,
  copyPakArtifacts,
  getPaksPath,
  ensureConfig,
};
