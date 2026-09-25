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
    // Mute the typing, not the question. Suppressing everything hid the prompt
    // too, which left you staring at a blank line with no idea whether it
    // wanted the password or the confirmation.
    let muted = false;
    rl._writeToOutput = (chunk) => { if (!muted) rl.output.write(chunk); };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

// One place to decide what counts as long enough, so the scripts cannot drift
// apart and leave a weaker way in. Matches what create-account has always
// asked for.
const MIN_PASSWORD = 8;

function rejectWeak(password) {
  if (!password) return 'No password given.';
  if (password.length < MIN_PASSWORD) {
    return `Too short: ${password.length} characters, minimum ${MIN_PASSWORD}.`;
  }
  return null;
}

module.exports = { askHidden, MIN_PASSWORD, rejectWeak };
