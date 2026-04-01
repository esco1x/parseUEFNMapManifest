const HEADER_MAGIC = 0x44bec00c;
const CONCURRENCY = 5;
const ZLIB_MAGIC = Buffer.from([0x78, 0x9c]);
const ZLIB_ALT = [Buffer.from([0x78, 0x01]), Buffer.from([0x78, 0xda])];
const CHUNK_MAGIC_OODLE = Buffer.from([0xa2, 0x3a, 0xfe, 0xb1]);
const ZLIB_SCAN_LEN = 1024;

const EPIC_UEFN_CLIENT_ID = '3e13c5c57f594a578abe516eecb673fe';
const EPIC_UEFN_CLIENT_SECRET = '530e316c337e409893c55ec44f22cd62';
const CONTENT_API = 'https://content-service.bfda.live.use1a.on.epicgames.com';
const OAUTH_URL = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token';
const AUTH_REDIRECT = 'https://www.epicgames.com/id/api/redirect';
const OAUTH_EXCHANGE_URL = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/exchange';
const OAUTH_VERIFY_URL = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/verify';

const LAUNCHER_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const LAUNCHER_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';

const FORTNITE_STUDIO_ASSETS_URL =
  'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2/platform/Windows/namespace/fn/catalogItem/1e8bda5cfbb641b9a9aea8bd62285f73/app/Fortnite_Studio/label/Live';

module.exports = {
  HEADER_MAGIC,
  CONCURRENCY,
  ZLIB_MAGIC,
  ZLIB_ALT,
  CHUNK_MAGIC_OODLE,
  ZLIB_SCAN_LEN,
  EPIC_UEFN_CLIENT_ID,
  EPIC_UEFN_CLIENT_SECRET,
  CONTENT_API,
  OAUTH_URL,
  AUTH_REDIRECT,
  OAUTH_EXCHANGE_URL,
  OAUTH_VERIFY_URL,
  LAUNCHER_CLIENT_ID,
  LAUNCHER_CLIENT_SECRET,
  FORTNITE_STUDIO_ASSETS_URL,
};
