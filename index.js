const axios = require('axios');
const { startCli, printFatalError } = require('./src/app/startCli');

startCli({ axios, entryScriptPath: __filename }).catch((e) => {
  printFatalError(e);
  process.exit(1);
});
