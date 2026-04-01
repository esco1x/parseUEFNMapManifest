const readline = require('readline');

function createConsoleClient() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  return { rl, ask };
}

module.exports = { createConsoleClient };
