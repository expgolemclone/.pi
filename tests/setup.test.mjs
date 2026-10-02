import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmRoot = execFileSync('pwsh', ['-NoProfile', '-Command', 'npm root --global'], { encoding: 'utf8' }).trim();
const packageRoot = join(npmRoot, '@earendil-works/pi-coding-agent');
const planPath = join(packageRoot, 'examples/extensions/plan-mode/index.ts');
const notifyPath = join(packageRoot, 'examples/extensions/notify.ts');
const settingsPath = join(root, 'agent/settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));

// This checkout is the live ~/.pi configuration, as required by setup.ps1.
test('setup loads both official examples without duplicates and preserves runtime metadata', () => {
  const before = readSettings();
  const setup = () => execFileSync('pwsh', ['-NoProfile', '-File', join(root, 'setup.ps1')], { encoding: 'utf8' });
  setup();
  const first = readSettings();
  setup();
  assert.deepEqual(readSettings(), first);
  for (const path of [planPath, notifyPath]) {
    assert.equal(first.extensions.filter((entry) => entry === path).length, 1);
  }
  for (const [key, value] of Object.entries(before)) {
    if (!['extensions', 'defaultTools', 'defaultProjectTrust', 'defaultProvider', 'defaultModel', 'defaultThinkingLevel'].includes(key)) {
      assert.deepEqual(first[key], value);
    }
  }
});

test('Pi loads the unmodified official notifier and sends a Windows toast only on agent_settled', async (t) => {
  const { loadExtensions } = await import(pathToFileURL(join(packageRoot, 'dist/core/extensions/loader.js')).href);
  const result = await loadExtensions([notifyPath], root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.deepEqual([...extension.handlers.keys()], ['agent_settled']);

  const previous = process.env.WT_SESSION;
  process.env.WT_SESSION = 'pi-notify-test';
  t.after(() => {
    if (previous === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previous;
  });
  const exec = t.mock.method(childProcess, 'execFile', () => {});
  await extension.handlers.get('agent_settled')[0]({ type: 'agent_settled' }, {});
  assert.equal(exec.mock.callCount(), 1);
  const [command, args] = exec.mock.calls[0].arguments;
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-Command']);
  assert.match(args[2], /Ready for input/);
  assert.match(args[2], /CreateToastNotifier\('Pi'\)/);
});
