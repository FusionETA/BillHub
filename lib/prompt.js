// Reading a secret from a terminal without putting it on the screen.
//
// readline echoes what you type, which is wrong for a password on a shared
// screen, a projected demo, or a session someone is recording. Muting the
// output stream is the only way to stop it.
const readline = require('readline');

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Not a terminal, so a password cannot be typed here. Set it in the environment instead.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(prompt);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// One place to decide what counts as long enough, so the scripts cannot drift
// apart and leave a weaker way in.
const MIN_PASSWORD = 12;

function rejectWeak(password) {
  if (!password) return 'No password given.';
  if (password.length < MIN_PASSWORD) {
    return `Too short: ${password.length} characters, minimum ${MIN_PASSWORD}. `
      + 'This login reads every bill in 41 organisations, on a host anyone can reach.';
  }
  return null;
}

module.exports = { askHidden, MIN_PASSWORD, rejectWeak };
