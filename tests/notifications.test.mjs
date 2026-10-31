import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import notifier, { soundCommand, windowCommand } from '../agent/extensions/notify.ts';
import { aiRoot, packageRoot, sdk } from './support/pi-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const soundPath = join(root, 'agent/sounds/ready.wav');
mkdirSync('C:/dev/tmp', { recursive: true });
const home = mkdtempSync('C:/dev/tmp/pi-notifications-test-');
after(() => rmSync(home, { recursive: true, force: true }));
const piRoot = join(home, '.pi');
for (const path of ['agent/AGENTS.md', 'agent/mcp.json', 'agent/settings.json', 'agent/models.json',
  'agent/sounds', 'agent/extensions/custom-compaction', 'agent/extensions/notify.ts']) {
  mkdirSync(dirname(join(piRoot, path)), { recursive: true });
  cpSync(join(root, path), join(piRoot, path), { recursive: true });
}
const integrationPath = join(home, 'AppData/Local/kintone-workspace/integrations/pi.js');
mkdirSync(dirname(integrationPath), { recursive: true });
writeFileSync(integrationPath, "export default function (pi) { pi.registerMcpServer('kintone', { command: process.execPath }); }\n");

const success = { code: 0, killed: false, stdout: '', stderr: '' };
const decode = args => Buffer.from(args[6], 'base64').toString('utf16le');
const originalColor = 'rgb:1111/2222/3333';
const reply = `\x1b]11;${originalColor}\x07`;

function terminalEnvironment(t, value = 'fixture-terminal') {
  const old = process.env.WT_SESSION;
  if (value === null) delete process.env.WT_SESSION;
  else process.env.WT_SESSION = value;
  t.after(() => { if (old === undefined) delete process.env.WT_SESSION; else process.env.WT_SESSION = old; });
}

function harness(t, exec = t.mock.fn(async () => success), extension = notifier) {
  const handlers = new Map();
  const writes = [];
  const widgets = [];
  let listener;
  let removed = false;
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (value, ...args) => {
    if (String(value).startsWith('\x1b]11;')) { writes.push(String(value)); return true; }
    return write(value, ...args);
  });
  const ctx = { mode: 'tui', ui: {
    onTerminalInput: handler => { listener = handler; return () => { removed = true; }; },
    setWidget: (key, value) => widgets.push([key, value]),
  } };
  extension({ on: (name, handler) => handlers.set(name, handler), exec });
  assert.deepEqual([...handlers.keys()], ['session_start', 'agent_start', 'agent_settled', 'session_shutdown']);
  return { handlers, ctx, exec, writes, widgets, input: value => listener?.(value), removed: () => removed };
}

function start(h) { h.handlers.get('session_start')({}, h.ctx); }
function settle(h) { return h.handlers.get('agent_settled')({}, h.ctx); }
function shutdown(h) { h.handlers.get('session_shutdown')({}, h.ctx); }

test('bundled sound is the unchanged installed chime and retains its license', () => {
  const wav = readFileSync(soundPath);
  assert.equal(createHash('sha256').update(wav).digest('hex'), 'e5efb3b64c4abfc6b315530b737e89cebe6e11cb2a5b6e4b6958e2a007072039');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.match(readFileSync(join(root, 'agent/sounds/LICENSE.zzfx'), 'utf8'), /Copyright \(c\) 2019 Frank Force/);
});

test('desktop toasts and their dependency are absent', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['node-notifier'], undefined);
  assert.doesNotMatch(readFileSync(join(root, 'agent/extensions/notify.ts'), 'utf8'), /node-notifier|toast/i);
});

test('Pi discovers each extension once without a model-selection controller or connection wrapper', async () => {
  const result = await sdk.discoverAndLoadExtensions([integrationPath], piRoot, join(piRoot, 'agent'));
  assert.deepEqual(result.errors, []);
  const paths = result.extensions.map(extension => extension.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(result.extensions.filter(({ path }) => path === integrationPath).length, 1);
  assert.ok(result.extensions.every(extension => !extension.tools.has('kintone_connect')));
  assert.equal(result.runtime.mcpServers.list().length, 1);
  const handlers = Object.fromEntries(result.extensions.map(extension => [extension.path, [...extension.handlers.keys()]]));
  assert.deepEqual(handlers[join(piRoot, 'agent/extensions/notify.ts')], ['session_start', 'agent_start', 'agent_settled', 'session_shutdown']);
  assert.deepEqual(handlers[join(piRoot, 'agent/extensions/custom-compaction/index.ts')], ['session_before_compact']);
});

test('settlement is interactive-only and does not start work while loading', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  assert.equal(h.exec.mock.callCount(), 0);
  for (const mode of ['print', 'json', 'rpc']) {
    const ctx = { ...h.ctx, mode };
    h.handlers.get('session_start')({}, ctx);
    await h.handlers.get('agent_settled')({}, ctx);
  }
  assert.equal(h.exec.mock.callCount(), 0);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.widgets, []);
});

test('without Windows Terminal only the sound is played', async t => {
  terminalEnvironment(t, null);
  const h = harness(t);
  start(h);
  await settle(h);
  assert.equal(h.exec.mock.callCount(), 1);
  const [command, args, options] = h.exec.mock.calls[0].arguments;
  assert.equal(command, 'mise.exe');
  assert.deepEqual(args.slice(0, 6), ['exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.ok(decode(args).includes(`$SoundPath = '${soundPath}'`));
  assert.deepEqual(options, { timeout: 10000 });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.widgets, []);
});

test('settlement starts sound and window lookup and restores the exact color on input', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  const pending = settle(h);
  assert.equal(h.writes[0], '\x1b]11;?\x07');
  const marker = h.widgets[0][1][0].match(/^Pi ready ([0-9a-f]{16})$/)[1];
  assert.deepEqual(h.input(reply), { consume: true });
  await pending;
  assert.equal(h.exec.mock.callCount(), 2);
  const calls = h.exec.mock.calls.map(call => decode(call.arguments[1]));
  assert.ok(calls.some(script => script.includes('$player.PlaySync()')));
  assert.ok(calls.some(script => script.includes(`$marker = '${marker}'`)));
  assert.ok(h.writes.includes('\x1b]11;#06402b\x07'));
  assert.deepEqual(h.widgets.at(-1), ['ready-window', undefined]);
  assert.equal(h.input(reply), undefined); // replies to other clients are not consumed
  h.input('\x1b[I');
  assert.ok(!h.writes.includes(`\x1b]11;${originalColor}\x07`));
  assert.equal(h.input('あ'), undefined);
  assert.ok(h.writes.includes(`\x1b]11;${originalColor}\x07`));
  shutdown(h);
  assert.equal(h.removed(), true);
});

test('shutdown and a programmatic new run restore the background exactly once', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  for (const event of ['agent_start', 'session_shutdown']) {
    const pending = settle(h);
    h.input(reply);
    await pending;
    h.handlers.get(event)({}, h.ctx);
  }
  assert.equal(h.writes.filter(value => value === `\x1b]11;${originalColor}\x07`).length, 2);
  shutdown(h);
  assert.equal(h.writes.filter(value => value === `\x1b]11;${originalColor}\x07`).length, 2);
});

test('input during settlement cancels pending visual work without consuming the key or cancelling sound', async t => {
  terminalEnvironment(t);
  let windowAborted = false;
  const exec = t.mock.fn((_command, _args, options) => {
    if (!options.signal) return Promise.resolve(success);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      windowAborted = true;
      reject(new Error('aborted'));
    }, { once: true }));
  });
  const h = harness(t, exec);
  start(h);
  const pending = settle(h);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.input('x'), undefined);
  await pending;
  assert.equal(windowAborted, true);
  assert.equal(exec.mock.callCount(), 2);
  assert.ok(!h.writes.includes('\x1b]11;#06402b\x07'));
  shutdown(h);
});

test('sound and window errors remain visible without suppressing either action', async t => {
  terminalEnvironment(t);
  const exec = t.mock.fn(async (_command, _args, options) => options.signal
    ? { ...success, code: 1, stderr: 'window failure' }
    : { ...success, code: 1, stderr: 'sound failure' });
  const h = harness(t, exec);
  start(h);
  const pending = settle(h);
  h.input(reply);
  await assert.rejects(pending, error => /sound failure/.test(error.message) && /window failure/.test(error.message));
  assert.equal(exec.mock.callCount(), 2);
  assert.ok(h.writes.includes('\x1b]11;#06402b\x07'));
  shutdown(h);
});

test('a missing color reply is reported without suppressing sound or window lookup', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  await assert.rejects(settle(h), /Could not query the terminal background color/);
  assert.equal(h.exec.mock.callCount(), 2);
  assert.ok(!h.writes.includes('\x1b]11;#06402b\x07'));
  shutdown(h);
});

test('PowerShell commands use encoded input and sound loads the WAV once', () => {
  for (const cmd of [soundCommand(), windowCommand('0123456789abcdef')]) {
    assert.equal(cmd.command, 'mise.exe');
    assert.deepEqual(cmd.args.slice(0, 6), ['exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.doesNotMatch(decode(cmd.args), /Set-ExecutionPolicy|Bypass/i);
    assert.ok(!cmd.args.includes('-ExecutionPolicy'));
    assert.ok(!cmd.args.includes('-File'));
  }
  const script = decode(soundCommand().args);
  assert.doesNotMatch(script, /WindowsRuntime|SystemSounds/);
  assert.ok(script.indexOf('$player.Load()') < script.indexOf('$player.PlaySync()'));
  assert.equal(script.match(/\.PlaySync\(/g).length, 1);
  assert.match(script, /finally\s*\{\s*\$player\.Dispose\(\)/);
  const path = "C:\\音\\O'Brien\\ready.wav";
  assert.ok(decode(soundCommand(path).args).includes(`$SoundPath = '${path.replaceAll("'", "''")}'`));
  assert.throws(() => windowCommand("'; exit"), /Invalid window marker/);
});

test('an unmatched marker fails instead of restoring another window', { timeout: 20000 }, async () => {
  const { command, args, options } = windowCommand(randomBytes(8).toString('hex'));
  await assert.rejects(promisify(execFile)(command, args, { ...options, encoding: 'utf8' }),
    error => /Could not identify the Pi window/.test(error.stderr));
});

test('real audio plays under Restricted without a .ps1 or policy relaxation', async t => {
  const directory = mkdtempSync('C:/dev/tmp/pi-notify-policy-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'blocked.ps1');
  writeFileSync(file, "Write-Output 'This script must not execute'\n");
  const blocked = spawnSync('mise.exe', [
    'exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-File', file,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(blocked.error);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /about_Execution_Policies/);
  const { args, options, command } = soundCommand(join(piRoot, 'agent/sounds/ready.wav'));
  const { stdout } = await promisify(execFile)(command, [...args.slice(0, 3), '-ExecutionPolicy', 'Restricted', ...args.slice(3)], { ...options, encoding: 'utf8' });
  assert.equal(stdout, '');
});

test('real Pi in Windows Terminal restores only its own minimized window without focus theft', { timeout: 100000 }, async t => {
  const directory = mkdtempSync('C:/dev/tmp/pi-notify-terminal-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentDir = join(directory, '.pi/agent');
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  cpSync(join(root, 'agent/extensions/notify.ts'), join(agentDir, 'extensions/notify.ts'));
  cpSync(join(root, 'agent/sounds'), join(agentDir, 'sounds'), { recursive: true });
  cpSync(join(root, 'agent/models.json'), join(agentDir, 'models.json'));
  const config = JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8'));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ ...config, extensions: [],
    enableInstallTelemetry: false, cacheWarming: 'off', defaultProjectTrust: 'never' }));
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ openai: {
    type: 'oauth', access: 'fixture-oauth-access', refresh: 'fixture-refresh', expires: 9999999999999,
  } }));
  writeFileSync(join(agentDir, 'AGENTS.md'), '# Fixture instructions\n');
  const paths = Object.fromEntries(['ready', 'go', 'done', 'query', 'color', 'input', 'key', 'quit'].map(name => [name, join(directory, name)]));
  const moduleUrl = path => JSON.stringify(pathToFileURL(path).href);
  const fixture = String.raw`
    import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
    import { fauxProvider, fauxAssistantMessage } from ${moduleUrl(join(aiRoot, 'dist/providers/faux.js'))};
    import { createProvider } from ${moduleUrl(join(aiRoot, 'dist/models.js'))};
    const paths = ${JSON.stringify(paths)};
    export default function(pi) {
      const thinkingLevelMap = { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
      const faux = fauxProvider({ provider: 'openai', models: [{ id: ${JSON.stringify(config.defaultModel)}, reasoning: true }] });
      const models = faux.provider.getModels().map(model => ({ ...model, thinkingLevelMap }));
      pi.registerProvider(createProvider({ id: 'openai', models, api: faux.provider, auth: { oauth: { name: 'Fixture',
        login: async () => { throw new Error('No login in tests'); },
        refresh: async () => { throw new Error('No refresh in tests'); },
        toAuth: async () => ({ apiKey: 'fixture-oauth-access' }),
      } } }));
      faux.setResponses([fauxAssistantMessage('fixture answer'), fauxAssistantMessage('second fixture answer')]);
      let timer;
      let unsubscribe;
      let waitingForColor = false;
      pi.on('session_start', (_event, ctx) => {
        unsubscribe = ctx.ui.onTerminalInput(data => {
          const match = data.match(/^\x1b\]11;([^\x07\x1b]+)(?:\x07|\x1b\\)$/);
          if (waitingForColor && match) {
            waitingForColor = false;
            writeFileSync(paths.color, match[1]);
            return { consume: true };
          }
        });
        process.stdout.write('\x1b]11;#1a2b3c\x07');
        writeFileSync(paths.ready, String(process.pid));
        timer = setInterval(() => {
          if (existsSync(paths.go) && ctx.isIdle()) { unlinkSync(paths.go); pi.sendUserMessage('fixture request'); }
          if (existsSync(paths.query)) { unlinkSync(paths.query); waitingForColor = true; process.stdout.write('\x1b]11;?\x07'); }
          if (existsSync(paths.input)) {
            unlinkSync(paths.input);
            process.stdin.emit('data', Buffer.from('x'));
            setTimeout(() => writeFileSync(paths.key, ctx.ui.getEditorText()), 50);
          }
          if (existsSync(paths.quit)) { clearInterval(timer); ctx.shutdown(); }
        }, 100);
      });
      pi.on('agent_settled', () => writeFileSync(paths.done, 'settled'));
      pi.on('session_shutdown', () => { clearInterval(timer); unsubscribe?.(); });
    }
  `;
  writeFileSync(join(agentDir, 'extensions/fixture.ts'), fixture);
  const pwsh = execFileSync('mise.exe', ['which', 'pwsh'], { encoding: 'utf8' }).trim();
  const assignments = { homePath: directory, agentDir, nodePath: process.execPath,
    cliPath: join(packageRoot, 'dist/bundle/cli.js'), pwshPath: pwsh,
    windowTitle: `pi-notify-test-${Date.now()}-${process.pid}`,
    readyPath: paths.ready, goPath: paths.go, donePath: paths.done, queryPath: paths.query,
    colorPath: paths.color, inputPath: paths.input, keyPath: paths.key, quitPath: paths.quit };
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const prefix = Object.entries(assignments).map(([name, value]) => `$${name} = ${literal(value)};`).join('\n');
  const driver = prefix + '\n' + readFileSync(join(root, 'tests/support/notification-window.ps1'), 'utf8');
  const encoded = Buffer.from(driver, 'utf16le').toString('base64');
  let result;
  try {
    result = await promisify(execFile)('mise.exe', ['exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 90000 });
  } catch (error) {
    assert.fail(`driver failed: code=${error.code} killed=${error.killed} signal=${error.signal}\nstdout=${error.stdout}\nstderr=${error.stderr}`);
  }
  assert.match(result.stdout, /restored only its own minimized window, did not activate it, and changed its background/);
});
