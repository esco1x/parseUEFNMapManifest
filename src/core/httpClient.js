const { installAxiosInterceptor } = require('./userAgent');

function configureHttpClient(axios) {
  installAxiosInterceptor(axios);
}

module.exports = { configureHttpClient };
