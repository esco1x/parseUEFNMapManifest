const { runMain } = require('../core/main');
const { runWorker } = require('../core/worker');
const { createConsoleClient } = require('../core/consoleClient');
const { configureHttpClient } = require('../core/httpClient');

function printFatalError(e) {
  console.error(e.response?.data || e.message || e);
  if (e && e.url) console.error('[HTTP] Failed URL:', e.url);
  if (e && e.statusCode != null) console.error('[HTTP] Status:', e.statusCode, e.statusMessage || '');
  if (e && e.responseBodyPreview && Buffer.isBuffer(e.responseBodyPreview)) {
    const prev = e.responseBodyPreview.toString('utf8');
    console.error('[HTTP] Body preview:', prev.length > 2000 ? `${prev.slice(0, 2000)}…` : prev);
  }
  if (e && e.stack) console.error(e.stack);
}

async function startCli({ axios, entryScriptPath }) {
  configureHttpClient(axios);
  if (process.argv.includes('--worker')) {
    await runWorker();
    return;
  }
  const { rl, ask } = createConsoleClient();
  await runMain({ rl, ask, entryScriptPath });
}

module.exports = { startCli, printFatalError };
