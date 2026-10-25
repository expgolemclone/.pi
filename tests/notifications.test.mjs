import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import notifier, { notificationCommand } from '../agent/extensions/notify.ts';
import WindowsToaster from 'node-notifier/notifiers/toaster.js';
import { sdk } from './support/pi-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const notifyPath = join(root, 'agent/extensions/notify.ts');
const soundPath = join(root, 'agent/sounds/ready.wav');
mkdirSync('C:/dev/tmp', { recursive: true });
const home = mkdtempSync('C:/dev/tmp/pi-notifications-test-');
after(() => rmSync(home, { recursive: true, force: true }));
const piRoot = join(home, '.pi');
mkdirSync(join(piRoot, 'agent'), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(piRoot, 'node_modules'), 'junction');
for (const path of ['agent/AGENTS.md', 'agent/mcp.json', 'agent/settings.json', 'agent/models.json',
  'agent/sounds', 'agent/extensions/custom-compaction',
  'agent/extensions/notify.ts']) {
  mkdirSync(dirname(join(piRoot, path)), { recursive: true });
  cpSync(join(root, path), join(piRoot, path), { recursive: true });
}
const localAppData = join(home, 'AppData/Local');
const integrationPath = join(localAppData, 'kintone-workspace/integrations/pi.js');
mkdirSync(dirname(integrationPath), { recursive: true });
const integrationFixture = "export default function (pi) { pi.registerMcpServer('kintone', { command: process.execPath }); }\n";
writeFileSync(integrationPath, integrationFixture);
const fixtureSoundPath = join(piRoot, 'agent/sounds/ready.wav');

test('bundled sound is the unchanged installed chime and retains its license', () => {
  const wav = readFileSync(soundPath);
  assert.equal(createHash('sha256').update(wav).digest('hex'), 'e5efb3b64c4abfc6b315530b737e89cebe6e11cb2a5b6e4b6958e2a007072039');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.match(readFileSync(join(root, 'agent/sounds/LICENSE.zzfx'), 'utf8'), /Copyright \(c\) 2019 Frank Force/);
});

test('Pi discovers each extension once without a model-selection controller or connection wrapper', async () => {
  const { discoverAndLoadExtensions } = sdk;
  const result = await discoverAndLoadExtensions([integrationPath], piRoot, join(piRoot, 'agent'));
  assert.deepEqual(result.errors, []);
  const paths = result.extensions.map(extension => extension.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(result.extensions.filter(({ path }) => path === integrationPath).length, 1);
  assert.ok(result.extensions.every(extension => !extension.tools.has('kintone_connect')));
  assert.equal(result.runtime.mcpServers.list().length, 1);
  const handlers = Object.fromEntries(result.extensions.map(extension => [extension.path, [...extension.handlers.keys()]]));
  assert.deepEqual(handlers[join(piRoot, 'agent/extensions/notify.ts')], ['agent_settled']);
  assert.deepEqual(handlers[join(piRoot, 'agent/extensions/custom-compaction/index.ts')], ['session_before_compact']);
});

function register(exec, extension = notifier, toast = { notify: (_options, done) => done(null) }) {
  const handlers = new Map();
  extension({ on: (event, handler) => handlers.set(event, handler), exec }, toast);
  assert.deepEqual([...handlers.keys()], ['agent_settled']);
  return handlers.get('agent_settled');
}

test('notifier executes once at settlement only in interactive mode', async (t) => {
  const exec = t.mock.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }));
  const toast = { notify: t.mock.fn((_options, done) => done(null)) };
  const settled = register(exec, notifier, toast);
  assert.equal(exec.mock.callCount(), 0); // no side effects while loading
  for (const mode of ['print', 'json', 'rpc']) {
    await settled({ type: 'agent_settled' }, { mode });
  }
  assert.equal(exec.mock.callCount(), 0);
  assert.equal(toast.notify.mock.callCount(), 0);
  await settled({ type: 'agent_settled' }, { mode: 'tui' });
  assert.equal(exec.mock.callCount(), 1);
  assert.equal(toast.notify.mock.callCount(), 1);
  assert.deepEqual(toast.notify.mock.calls[0].arguments[0], { title: 'Pi', message: 'Ready for input', sound: false });
  const [command, args, options] = exec.mock.calls[0].arguments;
  assert.equal(command, 'mise.exe');
  assert.deepEqual(args.slice(0, 6), ['exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[6], 'base64').toString('utf16le');
  assert.ok(script.includes(`$SoundPath = '${soundPath}'`));
  assert.doesNotMatch(script, /Set-ExecutionPolicy|Bypass/i);
  assert.ok(!args.includes('-ExecutionPolicy'));
  assert.ok(!args.includes('-File'));
  assert.deepEqual(options, { timeout: 10000 });
});

test('toast and audio start together and settlement waits for both', async (t) => {
  for (const first of ['toast', 'audio']) {
    await t.test(`${first} completes first`, async (t) => {
      const audio = Promise.withResolvers();
      const dismissal = Promise.withResolvers();
      const exec = t.mock.fn(() => audio.promise);
      const toast = { notify: t.mock.fn((_options, done) => { dismissal.promise.then(() => done(null), done); }) };
      let finished = false;
      const pending = register(exec, notifier, toast)({}, { mode: 'tui' }).then(() => { finished = true; });
      const result = { code: 0, killed: false, stdout: '', stderr: '' };
      try {
        assert.equal(toast.notify.mock.callCount(), 1);
        assert.equal(exec.mock.callCount(), 1);
        if (first === 'toast') dismissal.resolve();
        else audio.resolve(result);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finished, false);
      } finally {
        dismissal.resolve();
        audio.resolve(result);
        await pending;
      }
      assert.equal(finished, true);
      assert.equal(toast.notify.mock.callCount(), 1);
      assert.equal(exec.mock.callCount(), 1);
    });
  }
});

test('notification failures are visible and never invoke a fallback sound', async (t) => {
  for (const failure of [{ code: 1, killed: false }, { code: 0, killed: true }]) {
    const exec = t.mock.fn(async () => ({ ...failure, stderr: 'test failure', stdout: '' }));
    await assert.rejects(register(exec)({}, { mode: 'tui' }), /Pi notification failed.*test failure/);
    assert.equal(exec.mock.callCount(), 1);
  }
});

test('audio execution rejections remain visible without suppressing the toast', async (t) => {
  const exec = t.mock.fn(async () => { throw new Error('audio test failure'); });
  const toast = { notify: t.mock.fn((_options, done) => done(null)) };
  await assert.rejects(register(exec, notifier, toast)({}, { mode: 'tui' }), /audio test failure/);
  assert.equal(exec.mock.callCount(), 1);
  assert.equal(toast.notify.mock.callCount(), 1);
});

test('native toast errors remain visible without suppressing audio or invoking a fallback', async (t) => {
  const exec = t.mock.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }));
  const toast = { notify: t.mock.fn((_options, done) => done(new Error('toast test failure'))) };
  await assert.rejects(register(exec, notifier, toast)({}, { mode: 'tui' }), /toast test failure/);
  assert.equal(toast.notify.mock.callCount(), 1);
  assert.equal(exec.mock.callCount(), 1);
  assert.match(readFileSync(notifyPath, 'utf8'), /new WindowsToaster\(\{ withFallback: false \}\)/);
});

test('PowerShell command explicitly loads WAV, plays once, and needs no legacy WinRT projection', () => {
  const { args } = notificationCommand();
  const script = Buffer.from(args[6], 'base64').toString('utf16le');
  assert.doesNotMatch(script, /WindowsRuntime|SystemSounds/);
  assert.ok(script.indexOf('$player.Load()') < script.indexOf('$player.PlaySync()'));
  assert.equal(script.match(/\.PlaySync\(/g).length, 1);
  assert.match(script, /finally\s*\{\s*\$player\.Dispose\(\)/);
});

test('command encoding preserves apostrophes and Unicode in the audio path', () => {
  const path = "C:\\音\\O'Brien\\ready.wav";
  const { args } = notificationCommand(path);
  const script = Buffer.from(args[6], 'base64').toString('utf16le');
  assert.ok(script.includes(`$SoundPath = '${path.replaceAll("'", "''")}'`));
});

test('real notification plays under Restricted without a .ps1 or policy relaxation', async (t) => {
  // Restrict only the managed child process; never change user/machine policy.
  mkdirSync('C:/dev/tmp', { recursive: true });
  const directory = mkdtempSync('C:/dev/tmp/pi-notify-policy-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'blocked.ps1');
  writeFileSync(file, "Write-Output 'This script must not execute'\n");
  const blocked = spawnSync('mise.exe', [
    'exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-File', file,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(blocked.error);
  assert.equal(blocked.status, 1);
  assert.ok(blocked.stderr.includes(file));
  assert.match(blocked.stderr, /about_Execution_Policies/);
  const { default: isolatedNotifier } = await import(pathToFileURL(join(piRoot, 'agent/extensions/notify.ts')));
  const settled = register(async (command, args, options) => {
    const script = Buffer.from(args[6], 'base64').toString('utf16le');
    assert.ok(script.includes(`$SoundPath = '${fixtureSoundPath}'`));
    assert.ok(!args.includes('-File'));
    assert.ok(!args.includes('-ExecutionPolicy'));
    const { stdout } = await promisify(execFile)(command, [...args.slice(0, 3), '-ExecutionPolicy', 'Restricted', ...args.slice(3)], { ...options, encoding: 'utf8' });
    return { code: 0, killed: false, stdout, stderr: '' };
  }, isolatedNotifier, new WindowsToaster({ withFallback: false }));
  await settled({ type: 'agent_settled' }, { mode: 'tui' });
});
