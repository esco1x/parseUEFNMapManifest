const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = {
  ROOT,
  CONFIG_PATH: path.join(ROOT, 'parseUEFNManifest.config.json'),
  TOKENS_PATH: path.join(ROOT, 'parseUEFNTokens.json'),
};
