import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import notifier, { notificationCommand } from '../agent/extensions/notify.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmRoot = execFileSync('pwsh', ['-NoProfile', '-Command', 'npm root --global'], { encoding: 'utf8' }).trim();
const packageRoot = join(npmRoot, '@earendil-works/pi-coding-agent');
const planPath = join(packageRoot, 'examples/extensions/plan-mode/index.ts');
const oldNotifyPath = join(packageRoot, 'examples/extensions/notify.ts');
const notifyPath = join(root, 'agent/extensions/notify.ts');
const soundPath = join(root, 'agent/sounds/ready.wav');
const settingsPath = join(root, 'agent/settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));

// This checkout is the live ~/.pi configuration, as required by setup.ps1.
test('setup retires official notifiers, generates one sound, and preserves runtime metadata', () => {
  const before = readSettings();
  const legacy = [oldNotifyPath, '+C:/old/npm/@earendil-works/pi-coding-agent/examples/extensions/notify.ts'];
  writeFileSync(settingsPath, JSON.stringify({ ...before, extensions: [...before.extensions, ...legacy] }));
  const setup = () => execFileSync('pwsh', ['-NoProfile', '-File', join(root, 'setup.ps1')], { encoding: 'utf8' });
  setup();
  const first = readSettings();
  const firstSound = readFileSync(soundPath);
  setup();
  assert.deepEqual(readSettings(), first);
  assert.deepEqual(readFileSync(soundPath), firstSound);
  assert.equal(first.extensions.filter((entry) => entry === planPath).length, 1);
  assert.ok(first.extensions.every((entry) => !entry.replaceAll('\\', '/').endsWith('/examples/extensions/notify.ts')));
  assert.ok(!first.extensions.includes(notifyPath)); // loaded by discovery, not configured twice
  assert.equal(existsSync(join(root, 'agent/sounds/candidates')), false);
  for (const [key, value] of Object.entries(before)) {
    if (!['extensions', 'defaultTools', 'defaultProjectTrust', 'defaultProvider', 'defaultModel', 'defaultThinkingLevel'].includes(key)) {
      assert.deepEqual(first[key], value);
    }
  }
});

test('Pi discovers the local notifier once and no longer loads the official notifier', async () => {
  const { discoverAndLoadExtensions } = await import(pathToFileURL(join(packageRoot, 'dist/core/extensions/loader.js')).href);
  const result = await discoverAndLoadExtensions(readSettings().extensions, root, join(root, 'agent'));
  assert.deepEqual(result.errors, []);
  const notifications = result.extensions.filter(({ path }) => path === notifyPath);
  assert.equal(notifications.length, 1);
  assert.deepEqual([...notifications[0].handlers.keys()], ['agent_settled']);
  assert.ok(result.extensions.every(({ path }) => path !== oldNotifyPath));
});

function register(exec) {
  const handlers = new Map();
  notifier({ on: (event, handler) => handlers.set(event, handler), exec });
  assert.deepEqual([...handlers.keys()], ['agent_settled']);
  return handlers.get('agent_settled');
}

test('notifier executes once at settlement only in interactive mode', async (t) => {
  const exec = t.mock.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }));
  const settled = register(exec);
  assert.equal(exec.mock.callCount(), 0); // no side effects while loading
  for (const mode of ['print', 'json', 'rpc']) {
    await settled({ type: 'agent_settled' }, { mode });
  }
  assert.equal(exec.mock.callCount(), 0);
  await settled({ type: 'agent_settled' }, { mode: 'tui' });
  assert.equal(exec.mock.callCount(), 1);
  const [command, args, options] = exec.mock.calls[0].arguments;
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(script.includes(`$SoundPath = '${soundPath}'`));
  assert.doesNotMatch(script, /Set-ExecutionPolicy|Bypass/i);
  assert.ok(!args.includes('-ExecutionPolicy'));
  assert.ok(!args.includes('-File'));
  assert.deepEqual(options, { timeout: 10000 });
});

test('notification failures are visible and never invoke a fallback sound', async (t) => {
  for (const failure of [{ code: 1, killed: false }, { code: 0, killed: true }]) {
    const exec = t.mock.fn(async () => ({ ...failure, stderr: 'test failure', stdout: '' }));
    await assert.rejects(register(exec)({}, { mode: 'tui' }), /Pi notification failed.*test failure/);
    assert.equal(exec.mock.callCount(), 1);
  }
});

test('Windows command silences toast audio, explicitly loads WAV, and plays once', () => {
  const { args } = notificationCommand();
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.match(script, /<audio silent="true"\s*\/>/);
  assert.match(script, /\$xml\.LoadXml\(/);
  assert.doesNotMatch(script, /AppendChild|GetElementsByTagName|SystemSounds/);
  assert.ok(script.indexOf('$player.Load()') < script.indexOf('$player.PlaySync()'));
  assert.equal(script.match(/\.PlaySync\(/g).length, 1);
  assert.equal(script.match(/\.Show\(/g).length, 1);
  assert.match(script, /finally\s*\{\s*\$player\.Dispose\(\)/);
});

test('command encoding preserves apostrophes and Unicode in the audio path', () => {
  const path = "C:\\音\\O'Brien\\ready.wav";
  const { args } = notificationCommand(path);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(script.includes(`$SoundPath = '${path.replaceAll("'", "''")}'`));
});

test('real notification plays under Restricted without a .ps1 or policy relaxation', async (t) => {
  // Make the child stricter than the harness (which may inherit Process=Bypass).
  // Prove that files are blocked rather than relying on Get-ExecutionPolicy's
  // module autoload (PowerShell 7's inherited module path can break it in 5.1).
  // No persistent user/machine policy is changed.
  mkdirSync('C:/dev/tmp', { recursive: true });
  const directory = mkdtempSync('C:/dev/tmp/pi-notify-policy-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'blocked.ps1');
  writeFileSync(file, "Write-Output 'This script must not execute'\n");
  const blocked = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-File', file,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(blocked.error);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /running scripts is disabled/i);
  const settled = register(async (command, args, options) => {
    assert.ok(!args.includes('-File'));
    assert.ok(!args.includes('-ExecutionPolicy'));
    const stdout = execFileSync(command, ['-ExecutionPolicy', 'Restricted', ...args], { ...options, encoding: 'utf8' });
    return { code: 0, killed: false, stdout, stderr: '' };
  });
  await settled({ type: 'agent_settled' }, { mode: 'tui' });
});
