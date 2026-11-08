import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { harness, flush } from '../tests/harness.js';

// The same hook module and element tree as the plugin, with an in-memory host.
// No Claude account, model calls, goal-file writes, or network access.
const h = await harness();
await h.command('demo');
let buttons = [];
function print(tree, indent = '') {
  if (typeof tree === 'string') { stdout.write(indent + tree.replace(/\n/g, '\n' + indent) + '\n'); return; }
  if (!tree) return;
  if (tree.type === 'Button') {
    buttons.push(tree);
    stdout.write(indent + '[' + buttons.length + '] ' + tree.label + '\n');
  } else if (tree.type !== 'Input') for (const child of tree.children ?? []) print(child, indent);
}
async function draw() {
  buttons = [];
  stdout.write('\n=== Learning Goal · offline demo ===\n\n');
  print(await h.render());
  stdout.write('\nAll state is in memory. This is a simulated host, not Claude Code.\n');
}
await draw();
if (stdin.isTTY && !process.argv.includes('--once')) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = await rl.question('\nButton number, or q to quit: ');
      if (answer.toLowerCase() === 'q') break;
      const b = buttons[Number(answer) - 1];
      if (!b) continue;
      await b.onPress(); await flush();
      if (b.key === 'close') break;
      await draw();
    }
  } finally { rl.close(); }
}
