const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { TOKENS_PATH } = require('./paths');
const { logAxiosError, isHttpDebug } = require('./http');
const {
  EPIC_UEFN_CLIENT_ID,
  EPIC_UEFN_CLIENT_SECRET,
  CONTENT_API,
  OAUTH_URL,
  AUTH_REDIRECT,
  OAUTH_EXCHANGE_URL,
  OAUTH_VERIFY_URL,
  LAUNCHER_CLIENT_ID,
  LAUNCHER_CLIENT_SECRET,
  LAUNCHER_APP_INFO_URL,
} = require('./constants');

function getAuthUrl(clientId) {
  return `${AUTH_REDIRECT}?clientId=${clientId}&responseType=code`;
}

async function exchangeAuthCode(clientId, clientSecret, code) {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code }).toString();
  try {
    const { data } = await axios.post(OAUTH_URL, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
    });
    return data;
  } catch (e) {
    logAxiosError(`OAuth token exchange (POST ${OAUTH_URL})`, e);
    throw e;
  }
}

function tokenExpiryToMs(tokenResponse) {
  if (!tokenResponse || typeof tokenResponse !== 'object') return Date.now() + 8 * 3600 * 1000;
  if (tokenResponse.expires_at) {
    const t = new Date(tokenResponse.expires_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (typeof tokenResponse.expires_in === 'number' && tokenResponse.expires_in > 0) {
    return Date.now() + tokenResponse.expires_in * 1000;
  }
  return Date.now() + 8 * 3600 * 1000;
}

function loadEpicTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_PATH, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (_) {
    return {};
  }
}

function saveEpicTokensMerge(patch, noSave) {
  if (noSave || process.env.UEFN_NO_SAVE_TOKENS === '1') return;
  const cur = loadEpicTokens();
  const next = { ...cur, ...patch };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(next, null, 2), 'utf8');
}

function normalizeEngineVersion(major, minor, cl) {
  const mj = String(Number(String(major).trim()));
  const mn = String(Number(String(minor).trim()));
  const patch = String(String(cl).trim());
  return { major: mj, minor: mn, cl: patch, cdnPathSegment: `${mj}.${mn}.${patch}` };
}

function parseEngineVersionString(s) {
  const t = String(s).trim();
  const parts = t.split('.');
  if (parts.length < 3) throw new Error(`Invalid --engine-version "${t}" (need major.minor.changelist, e.g. 40.0.51995682)`);
  const major = parts[0];
  const minor = parts[1];
  const cl = parts.slice(2).join('.');
  return normalizeEngineVersion(major, minor, cl);
}

function tryReadEngineVersionFromPaksDir(paksDir) {
  if (!paksDir || !fs.existsSync(paksDir)) return null;
  const re = /\+\+Fortnite\+Release-(\d+)\.(\d+)-CL-(\d+)/i;
  let bestCl = -1;
  let best = null;
  try {
    for (const n of fs.readdirSync(paksDir)) {
      const m = n.match(re);
      if (!m) continue;
      const clNum = parseInt(m[3], 10);
      if (clNum > bestCl) {
        bestCl = clNum;
        best = normalizeEngineVersion(m[1], m[2], m[3]);
      }
    }
  } catch (_) {}
  return best;
}

function parseBuildVersionFromLauncherString(buildVersion) {
  const re = /\+\+Fortnite\+Release-(\d+)\.(\d+)-CL-(\d+)/i;
  const m = String(buildVersion || '').match(re);
  if (!m) return null;
  return normalizeEngineVersion(m[1], m[2], m[3]);
}

async function verifyAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return false;
  try {
    const { status } = await axios.get(OAUTH_VERIFY_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      validateStatus: (s) => s < 500,
    });
    return status === 200;
  } catch (_) {
    return false;
  }
}

async function refreshUeFnToken(refreshToken) {
  const basicAuth = Buffer.from(`${EPIC_UEFN_CLIENT_ID}:${EPIC_UEFN_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();
  try {
    const { data } = await axios.post(OAUTH_URL, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
    });
    return data;
  } catch (e) {
    logAxiosError('refreshUeFnToken', e);
    throw e;
  }
}

async function exchangeUeFnTokenForLauncherToken(uefnAccessToken) {
  try {
    const ex = await axios.get(OAUTH_EXCHANGE_URL, {
      headers: { Authorization: `Bearer ${uefnAccessToken}` },
    });
    const exchangeCode = ex.data?.code;
    if (!exchangeCode) throw new Error('OAuth exchange returned no code (UEFN token may not allow exchange)');

    const launcherBasic = Buffer.from(`${LAUNCHER_CLIENT_ID}:${LAUNCHER_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'exchange_code',
      exchange_code: exchangeCode,
    }).toString();
    const { data } = await axios.post(OAUTH_URL, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${launcherBasic}`,
      },
    });
    return data;
  } catch (e) {
    logAxiosError('exchangeUeFnTokenForLauncherToken', e);
    throw e;
  }
}

async function getOrRefreshLauncherAccessToken(uefnAccessToken, opts = {}) {
  const saved = loadEpicTokens();
  const skewMs = 120000;
  if (saved.launcherAccessToken) {
    const freshEnough = !saved.launcherExpiresAt || saved.launcherExpiresAt > Date.now() + skewMs;
    if (freshEnough || !saved.launcherExpiresAt) {
      if (await verifyAccessToken(saved.launcherAccessToken)) {
        if (isHttpDebug(opts)) console.error('[tokens] Using saved launcher token');
        return saved.launcherAccessToken;
      }
    } else if (await verifyAccessToken(saved.launcherAccessToken)) {
      if (isHttpDebug(opts)) console.error('[tokens] Using saved launcher token (past soft expiry, verify OK)');
      return saved.launcherAccessToken;
    }
  }

  const launcherData = await exchangeUeFnTokenForLauncherToken(uefnAccessToken);
  const launcherToken = launcherData.access_token;
  if (!launcherToken) throw new Error('Launcher token response missing access_token');
  const launcherExpiresAt = tokenExpiryToMs(launcherData);
  if (!opts.noSaveTokens) {
    saveEpicTokensMerge({ launcherAccessToken: launcherToken, launcherExpiresAt }, opts.noSaveTokens);
  }
  return launcherToken;
}

async function fetchFortniteStudioBuildVersion(launcherAccessToken, opts = {}) {
  const body = {
    appKeys: [
      {
        artifactId: 'Fortnite_Studio',
        catalogId: '1e8bda5cfbb641b9a9aea8bd62285f73',
        sandboxId: 'fn',
      },
    ],
  };
  try {
    if (isHttpDebug(opts)) console.error('[launcher] POST', LAUNCHER_APP_INFO_URL);
    const { data } = await axios.post(LAUNCHER_APP_INFO_URL, body, {
      headers: { Authorization: `Bearer ${launcherAccessToken}` },
    });
    const el = Array.isArray(data) ? data[0] : null;
    const bv = el?.buildVersion;
    if (!bv) throw new Error('Launcher appInfo: [0].buildVersion missing');
    const parsed = parseBuildVersionFromLauncherString(bv);
    if (!parsed) throw new Error(`Launcher assets: could not parse buildVersion "${bv}"`);
    return { ...parsed, rawBuildVersion: bv };
  } catch (e) {
    logAxiosError('fetchFortniteStudioBuildVersion', e);
    throw e;
  }
}

async function tryLoadValidUeFnToken(opts = {}) {
  if (opts.freshLogin) return null;
  const saved = loadEpicTokens();
  if (!saved.uefnAccessToken) return null;

  const tryRefresh = async () => {
    if (!saved.uefnRefreshToken) return null;
    try {
      const td = await refreshUeFnToken(saved.uefnRefreshToken);
      const at = td.access_token;
      if (!at) return null;
      saveEpicTokensMerge(
        {
          uefnAccessToken: at,
          uefnExpiresAt: tokenExpiryToMs(td),
          uefnRefreshToken: td.refresh_token || saved.uefnRefreshToken,
        },
        opts.noSaveTokens
      );
      return (await verifyAccessToken(at)) ? at : null;
    } catch (_) {
      return null;
    }
  };

  if (saved.uefnExpiresAt && saved.uefnExpiresAt < Date.now() + 30000) {
    return tryRefresh();
  }
  if (await verifyAccessToken(saved.uefnAccessToken)) return saved.uefnAccessToken;
  return tryRefresh();
}

async function resolveFortniteEngineVersion(config, opts = {}) {
  const envVer = process.env.UEFN_ENGINE_VERSION;
  if (opts.engineVersionOverride) {
    const v = parseEngineVersionString(opts.engineVersionOverride);
    return { ...v, source: '--engine-version' };
  }
  if (envVer && String(envVer).trim()) {
    const v = parseEngineVersionString(envVer);
    return { ...v, source: 'UEFN_ENGINE_VERSION' };
  }
  if (opts.uefnAccessToken) {
    try {
      const launcherTok = await getOrRefreshLauncherAccessToken(opts.uefnAccessToken, opts);
      if (launcherTok) {
        const fromLauncher = await fetchFortniteStudioBuildVersion(launcherTok, opts);
        return {
          ...fromLauncher,
          source: `UEFN Prod Version (${fromLauncher.rawBuildVersion})`,
        };
      }
    } catch (e) {
      if (isHttpDebug(opts)) console.error('[engine] Launcher API buildVersion failed:', e.message || e);
    }
  }
  const paksDir = config?.fortniteGamePath ? path.join(config.fortniteGamePath, 'Content', 'Paks') : null;
  const fromPaks = tryReadEngineVersionFromPaksDir(paksDir);
  if (fromPaks) {
    return { ...fromPaks, source: 'local Paks (Release-*-CL-* filename)' };
  }
  throw new Error('Unable to resolve engine version from Epic launcher API or local Paks. Pass --engine-version MAJOR.MINOR.CL.');
}

async function getCookedContentPackage(token, mapCode, major, minor, cl) {
  const mapCodeNorm = mapCode.replace(/\s/g, '').trim();
  const url = `${CONTENT_API}/api/content/v2/link/${mapCodeNorm}/cooked-content-package`;
  try {
    const { data } = await axios.get(url, {
      params: { role: 'client', platform: 'windows', major, minor, patch: cl },
      headers: { Authorization: `Bearer ${token}` },
    });
    return data;
  } catch (e) {
    logAxiosError('getCookedContentPackage', e);
    throw e;
  }
}

async function getModuleKey(token, moduleId, version) {
  const url = `${CONTENT_API}/api/content/v4/module/${moduleId}/version/${version}/key`;
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const aesKey = '0x' + Buffer.from(data.key.Key, 'base64').toString('hex').toUpperCase();
    const guid = data.key.Guid;
    if (process.env.UEFN_DEBUG_KEY === '1' && data.key) {
      try {
        const k = data.key;
        console.error('[key response] Guid:', typeof k.Guid === 'string' ? k.Guid : JSON.stringify(k.Guid));
        console.error('[key response] Key: ' + (k.Key ? `${String(k.Key).length} chars (base64)` : 'missing'));
        if (k.ChunkKeys && Array.isArray(k.ChunkKeys)) {
          console.error('[key response] ChunkKeys length:', k.ChunkKeys.length);
        }
      } catch (_) {}
    }
    return { aesKey, guid };
  } catch (e) {
    logAxiosError('getModuleKey', e);
    throw e;
  }
}

module.exports = {
  getAuthUrl,
  exchangeAuthCode,
  tokenExpiryToMs,
  loadEpicTokens,
  saveEpicTokensMerge,
  normalizeEngineVersion,
  parseEngineVersionString,
  tryReadEngineVersionFromPaksDir,
  parseBuildVersionFromLauncherString,
  verifyAccessToken,
  refreshUeFnToken,
  exchangeUeFnTokenForLauncherToken,
  getOrRefreshLauncherAccessToken,
  fetchFortniteStudioBuildVersion,
  tryLoadValidUeFnToken,
  resolveFortniteEngineVersion,
  getCookedContentPackage,
  getModuleKey,
  EPIC_UEFN_CLIENT_ID,
  EPIC_UEFN_CLIENT_SECRET,
};
