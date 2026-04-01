const https = require('https');
const { getFortniteGameUserAgent } = require('./userAgent');

function isHttpDebug(options = {}) {
  return options.debug === true || process.argv.includes('--debug');
}

function logAxiosError(label, err) {
  if (!isHttpDebug()) return;
  const cfg = err.config;
  const res = err.response;
  console.error(`[HTTP] ${label} — request failed`);
  if (cfg) {
    const method = String(cfg.method || 'get').toUpperCase();
    let fullUrl = cfg.url || '';
    if (cfg.baseURL && fullUrl && !/^https?:\/\//i.test(fullUrl)) {
      fullUrl = String(cfg.baseURL).replace(/\/?$/, '/') + String(fullUrl).replace(/^\//, '');
    }
    console.error('[HTTP] Method:', method);
    console.error('[HTTP] URL:', fullUrl || '(unknown)');
    if (cfg.params && typeof cfg.params === 'object' && Object.keys(cfg.params).length) {
      console.error('[HTTP] params (may already be in URL):', JSON.stringify(cfg.params));
    }
  }
  if (res) {
    console.error('[HTTP] Status:', res.status, res.statusText || '');
    console.error('[HTTP] Response headers:', JSON.stringify(res.headers, null, 2));
    let preview;
    const data = res.data;
    if (Buffer.isBuffer(data)) preview = data.subarray(0, 2048).toString('utf8');
    else if (typeof data === 'string') preview = data.slice(0, 2048);
    else try { preview = JSON.stringify(data, null, 2).slice(0, 2048); } catch (_) { preview = String(data).slice(0, 2048); }
    console.error('[HTTP] Response body length:', typeof data === 'string' || Buffer.isBuffer(data) ? data.length : '(n/a)');
    console.error('[HTTP] Response body preview:', preview && preview.length >= 2048 ? `${preview}…` : preview);
  } else if (err.message) {
    console.error('[HTTP] No response object:', err.message);
    if (err.code) console.error('[HTTP] err.code:', err.code);
  }
}

function get(url, options = {}) {
  const debug = isHttpDebug(options);
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': getFortniteGameUserAgent(), ...options.headers };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    if (debug) {
      console.error('[HTTP] GET', url);
      const safeHeaders = { ...headers };
      if (safeHeaders.Authorization) safeHeaders.Authorization = 'Bearer ***';
      console.error('[HTTP] Request headers:', JSON.stringify(safeHeaders));
    }
    https.get(url, { headers }, (res) => {
      const code = res.statusCode;
      if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
        const loc = res.headers.location;
        if (!loc) {
          const err = new Error(`HTTP ${code} redirect without Location`);
          err.statusCode = code;
          err.url = url;
          if (debug) console.error('[HTTP]', code, 'redirect missing Location for', url);
          res.resume();
          reject(err);
          return;
        }
        const nextUrl = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).href;
        if (debug) console.error('[HTTP]', code, 'redirect ->', nextUrl);
        res.resume();
        return get(nextUrl, options).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (code !== 200) {
          const err = new Error(`HTTP ${code}`);
          err.statusCode = code;
          err.statusMessage = res.statusMessage;
          err.url = url;
          err.responseHeaders = res.headers;
          err.responseBodyPreview = body.subarray(0, 4096);
          if (debug) {
            console.error('[HTTP]', code, res.statusMessage || '', 'GET', url);
            console.error('[HTTP] Response headers:', JSON.stringify(res.headers, null, 2));
            const text = body.subarray(0, 4096).toString('utf8');
            console.error('[HTTP] Response body length:', body.length);
            console.error('[HTTP] Response body preview:', text.length >= 4096 ? `${text.slice(0, 4096)}…` : text || '(empty)');
          }
          reject(err);
          return;
        }
        if (debug) console.error('[HTTP] 200 OK', url, `(${body.length} bytes)`);
        resolve(body);
      });
      res.on('error', (e) => {
        if (debug) console.error('[HTTP] response stream error for', url, e.message || e);
        reject(e);
      });
    }).on('error', (e) => {
      if (debug) console.error('[HTTP] socket/request error GET', url, e.message || e, e.code || '');
      reject(e);
    });
  });
}

module.exports = { isHttpDebug, logAxiosError, get };
