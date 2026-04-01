const WORKER_READ_TIMEOUT_MS = 60000;

function readExactly(stream, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    function pump() {
      if (buf.length >= n) {
        resolve(buf.subarray(0, n));
        if (buf.length > n) stream.unshift(buf.subarray(n));
        return;
      }
      const chunk = stream.read(n - buf.length);
      if (chunk) {
        buf = Buffer.concat([buf, chunk]);
        pump();
      } else {
        stream.once('readable', pump);
        stream.once('error', reject);
        stream.once('end', () => reject(new Error('Stream ended')));
      }
    }
    stream.on('error', reject);
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
