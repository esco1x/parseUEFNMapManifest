const WORKER_READ_TIMEOUT_MS = 60000;

function readExactly(stream, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;

    function cleanup() {
      stream.off('readable', pump);
      stream.off('error', onError);
      stream.off('end', onEnd);
    }

    function finish(result) {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    }

    function fail(err) {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    }

    function onError(err) {
      fail(err);
    }

    function onEnd() {
      fail(new Error('Stream ended'));
    }

    function pump() {
      if (done) return;
      while (buf.length < n) {
        const chunk = stream.read(n - buf.length);
        if (!chunk) break;
        buf = Buffer.concat([buf, chunk]);
      }
      if (buf.length >= n) {
        const out = buf.subarray(0, n);
        if (buf.length > n) stream.unshift(buf.subarray(n));
        finish(out);
      }
    }

    stream.on('readable', pump);
    stream.on('error', onError);
    stream.on('end', onEnd);
    pump();
  });
}

function readExactlyWithTimeout(stream, n, timeoutMs) {
  return Promise.race([
    readExactly(stream, n),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Worker read timeout')), timeoutMs)),
  ]);
}

module.exports = { WORKER_READ_TIMEOUT_MS, readExactly, readExactlyWithTimeout };
