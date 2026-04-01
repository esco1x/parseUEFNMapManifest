const os = require('os');

let fortniteUaBuildSegment = process.env.UEFN_UA_BUILD || '++Fortnite+Release-40.00-CL-51995682';

function setFortniteUaBuildFromResolvedVersion(ver) {
  if (!ver) return;
  if (ver.rawBuildVersion != null && ver.rawBuildVersion !== '') {
    fortniteUaBuildSegment = String(ver.rawBuildVersion).replace(/-Windows$/i, '').trim();
    return;
  }
  if (ver.major != null && ver.minor != null && ver.cl != null) {
    const minPad = String(Number(ver.minor)).padStart(2, '0');
    fortniteUaBuildSegment = `++Fortnite+Release-${ver.major}.${minPad}-CL-${ver.cl}`;
  }
}

function getFortniteGameUserAgent() {
  const core = String(fortniteUaBuildSegment).replace(/-Windows$/i, '').trim();
  const winBuild = process.platform === 'win32' ? `${os.release()}.1.768.64bit` : '10.0.26200.1.768.64bit';
  return `FortniteGame/${core} (http-eventloop) Windows/${winBuild}`;
}

function installAxiosInterceptor(axios) {
  axios.interceptors.request.use((config) => {
    config.headers = config.headers || {};
    const h = config.headers;
    if (h['User-Agent'] == null && h['user-agent'] == null) {
      h['User-Agent'] = getFortniteGameUserAgent();
    }
    return config;
  });
}

module.exports = {
  setFortniteUaBuildFromResolvedVersion,
  getFortniteGameUserAgent,
  installAxiosInterceptor,
};
