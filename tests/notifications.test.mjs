import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import notifier, { soundCommand } from '../agent/extensions/notify.ts';
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
const originalColors = { foreground: { r: 170, g: 187, b: 204 }, background: { r: 17, g: 34, b: 51 } };
const readyWrite = '\x1b]10;#000000\x07\x1b]11;#ffffff\x07';
const restoredWrite = '\x1b]10;#aabbcc\x07\x1b]11;#112233\x07';

function terminalEnvironment(t, value = 'fixture-terminal') {
  const old = process.env.WT_SESSION;
  if (value === null) delete process.env.WT_SESSION;
  else process.env.WT_SESSION = value;
  t.after(() => { if (old === undefined) delete process.env.WT_SESSION; else process.env.WT_SESSION = old; });
}

function harness(t, exec = t.mock.fn(async () => success), extension = notifier) {
  const handlers = new Map();
  const writes = [];
  const minimizes = [];
  const restores = [];
  const windowWrites = [];
  const widgets = [];
  const appearances = [];
  let listener;
  let resolveColors;
  let removed = false;
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (value, ...args) => {
    if (String(value) === '\x1b[2t') { minimizes.push(String(value)); windowWrites.push(String(value)); return true; }
    if (String(value) === '\x1b[1t') { restores.push(String(value)); windowWrites.push(String(value)); return true; }
    if (/^\x1b\]1[01];/.test(String(value))) { writes.push(String(value)); return true; }
    return write(value, ...args);
  });
  const emit = process.stdin.emit.bind(process.stdin);
  t.mock.method(process.stdin, 'emit', (event, ...args) => {
    if (event === 'data' && /^\x1b\[\?997;[12]n$/.test(String(args[0]))) { appearances.push(args[0]); return true; }
    return emit(event, ...args);
  });
  const ctx = { mode: 'tui', ui: {
    theme: { name: 'system', appearance: 'dark' },
    onTerminalInput: handler => { listener = handler; return () => { removed = true; }; },
    setWidget: (key, value) => {
      if (typeof value === 'function') {
        const component = value({ queryTerminalColors: () => new Promise(resolve => { resolveColors = resolve; }) });
        value = component.render(80);
      }
      widgets.push([key, value]);
    },
  } };
  extension({ on: (name, handler) => handlers.set(name, handler), exec });
  assert.deepEqual([...handlers.keys()], ['session_start', 'input', 'agent_start', 'agent_settled', 'session_shutdown']);
  return { handlers, ctx, exec, writes, minimizes, restores, windowWrites, widgets, appearances, replyColors: colors => resolveColors(colors),
    input: value => listener?.(value), removed: () => removed };
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
  assert.deepEqual(handlers[join(piRoot, 'agent/extensions/notify.ts')], ['session_start', 'input', 'agent_start', 'agent_settled', 'session_shutdown']);
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
  assert.deepEqual(h.windowWrites, []);
  assert.deepEqual(h.widgets, []);
});

test('interactive submissions minimize their Windows Terminal without changing the prompt', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  for (const streamingBehavior of [undefined, 'steer', 'followUp']) {
    const event = { source: 'interactive', text: 'fixture prompt', streamingBehavior };
    assert.equal(await h.handlers.get('input')(event, h.ctx), undefined);
    assert.equal(event.text, 'fixture prompt');
  }
  assert.deepEqual(h.minimizes, ['\x1b[2t', '\x1b[2t', '\x1b[2t']);
  assert.equal(h.exec.mock.callCount(), 0);
  shutdown(h);
});

test('noninteractive and extension inputs do not minimize a window', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  for (const mode of ['print', 'json', 'rpc']) {
    await h.handlers.get('input')({ source: 'interactive', text: 'prompt' }, { ...h.ctx, mode });
  }
  for (const source of ['extension', 'rpc']) {
    await h.handlers.get('input')({ source, text: 'prompt' }, h.ctx);
  }
  assert.deepEqual(h.minimizes, []);
  assert.equal(h.exec.mock.callCount(), 0);
});

test('without Windows Terminal a prompt does not minimize a window', async t => {
  terminalEnvironment(t, null);
  const h = harness(t);
  await h.handlers.get('input')({ source: 'interactive', text: 'prompt' }, h.ctx);
  assert.deepEqual(h.minimizes, []);
});

test('settlement restores immediately on the same stream after minimize', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  await h.handlers.get('input')({ source: 'interactive', text: 'first' }, h.ctx);
  const first = settle(h);
  assert.deepEqual(h.windowWrites, ['\x1b[2t', '\x1b[1t']);
  h.input('x');
  await first;
  await h.handlers.get('input')({ source: 'interactive', text: 'second', streamingBehavior: 'steer' }, h.ctx);
  const second = settle(h);
  h.replyColors(originalColors);
  await second;
  assert.deepEqual(h.windowWrites, ['\x1b[2t', '\x1b[1t', '\x1b[2t', '\x1b[1t']);
  assert.equal(h.exec.mock.callCount(), 2);
  shutdown(h);
});

test('programmatic runs restore the terminal even without an interactive submission', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  const pending = settle(h);
  h.replyColors(originalColors);
  await pending;
  assert.deepEqual(h.windowWrites, ['\x1b[1t']);
  shutdown(h);
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
  assert.deepEqual(h.windowWrites, []);
  assert.deepEqual(h.widgets, []);
});

test('settlement switches to readable white and restores both colors on input', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  const pending = settle(h);
  h.replyColors(originalColors);
  await pending;
  assert.equal(h.exec.mock.callCount(), 1);
  assert.ok(decode(h.exec.mock.calls[0].arguments[1]).includes('$player.PlaySync()'));
  assert.deepEqual(h.restores, ['\x1b[1t']);
  assert.ok(h.writes.includes(readyWrite));
  assert.deepEqual(h.appearances, ['\x1b[?997;2n']);
  assert.deepEqual(h.widgets.at(-1), ['ready-window', undefined]);
  assert.equal(h.input('\x1b]11;rgb:1111/2222/3333\x07'), undefined);
  h.input('\x1b[I');
  assert.ok(!h.writes.includes(restoredWrite));
  assert.equal(h.input('x'), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.writes.includes(restoredWrite));
  assert.deepEqual(h.appearances, ['\x1b[?997;2n', '\x1b[?997;1n']);
  shutdown(h);
  assert.equal(h.removed(), true);
});

test('shutdown and a programmatic new run restore the background exactly once', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  for (const event of ['agent_start', 'session_shutdown']) {
    const pending = settle(h);
    h.replyColors(originalColors);
    await pending;
    h.handlers.get(event)({}, h.ctx);
  }
  assert.equal(h.writes.filter(value => value === restoredWrite).length, 2);
  shutdown(h);
  assert.equal(h.writes.filter(value => value === restoredWrite).length, 2);
});

test('input during settlement cancels pending visual work without consuming the key or cancelling sound', async t => {
  terminalEnvironment(t);
  let finishSound;
  const exec = t.mock.fn(() => new Promise(resolve => { finishSound = resolve; }));
  const h = harness(t, exec);
  start(h);
  const pending = settle(h);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.input('x'), undefined);
  h.replyColors(originalColors);
  finishSound(success);
  await pending;
  assert.equal(exec.mock.callCount(), 1);
  assert.deepEqual(h.restores, ['\x1b[1t']);
  assert.ok(!h.writes.includes(readyWrite));
  shutdown(h);
});

test('immediate input after the white change restores colors in order', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  const pending = settle(h);
  h.replyColors(originalColors);
  await Promise.resolve();
  assert.ok(h.writes.includes(readyWrite));
  assert.equal(h.input('x'), undefined);
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.writes, [readyWrite, restoredWrite]);
  assert.deepEqual(h.appearances, ['\x1b[?997;2n', '\x1b[?997;1n']);
  shutdown(h);
});

test('sound and color errors remain visible without suppressing restoration', async t => {
  terminalEnvironment(t);
  const exec = t.mock.fn(async () => ({ ...success, code: 1, stderr: 'sound failure' }));
  const h = harness(t, exec);
  start(h);
  const pending = settle(h);
  h.replyColors({});
  await assert.rejects(pending, error => /sound failure/.test(error.message) && /Could not query/.test(error.message));
  assert.equal(exec.mock.callCount(), 1);
  assert.deepEqual(h.restores, ['\x1b[1t']);
  shutdown(h);
});

test('a missing color reply is reported without suppressing sound or window restoration', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  start(h);
  const pending = settle(h);
  h.replyColors({});
  await assert.rejects(pending, /Could not query the terminal foreground and background colors/);
  assert.equal(h.exec.mock.callCount(), 1);
  assert.deepEqual(h.restores, ['\x1b[1t']);
  assert.ok(!h.writes.includes(readyWrite));
  shutdown(h);
});

test('an existing light appearance is restored as light', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  h.ctx.ui.theme = { name: 'light', appearance: 'light' };
  start(h);
  const pending = settle(h);
  h.replyColors(originalColors);
  await pending;
  h.input('x');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.appearances, ['\x1b[?997;2n', '\x1b[?997;2n']);
  assert.ok(h.writes.includes(restoredWrite));
  shutdown(h);
});

test('a dark fixed theme is not made unreadable', async t => {
  terminalEnvironment(t);
  const h = harness(t);
  h.ctx.ui.theme = { name: 'dark', appearance: 'dark' };
  start(h);
  const pending = settle(h);
  h.replyColors(originalColors);
  await assert.rejects(pending, /requires Pi's system or a light theme/);
  assert.equal(h.exec.mock.callCount(), 1);
  assert.deepEqual(h.restores, ['\x1b[1t']);
  assert.deepEqual(h.writes, []);
  shutdown(h);
});

test('PowerShell sound command uses encoded input and loads the WAV once', () => {
  const cmd = soundCommand();
  assert.equal(cmd.command, 'mise.exe');
  assert.deepEqual(cmd.args.slice(0, 6), ['exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.doesNotMatch(decode(cmd.args), /Set-ExecutionPolicy|Bypass/i);
  assert.ok(!cmd.args.includes('-ExecutionPolicy'));
  assert.ok(!cmd.args.includes('-File'));
  const script = decode(cmd.args);
  assert.doesNotMatch(script, /WindowsRuntime|SystemSounds/);
  assert.ok(script.indexOf('$player.Load()') < script.indexOf('$player.PlaySync()'));
  assert.equal(script.match(/\.PlaySync\(/g).length, 1);
  assert.match(script, /finally\s*\{\s*\$player\.Dispose\(\)/);
  const path = "C:\\音\\O'Brien\\ready.wav";
  assert.ok(decode(soundCommand(path).args).includes(`$SoundPath = '${path.replaceAll("'", "''")}'`));
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

test('real Pi restores the correct Windows Terminal even from an inactive tab', { timeout: 120000 }, async t => {
  const directory = mkdtempSync('C:/dev/tmp/pi-notify-terminal-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentDir = join(directory, '.pi/agent');
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  cpSync(join(root, 'agent/extensions/notify.ts'), join(agentDir, 'extensions/notify.ts'));
  cpSync(join(root, 'agent/sounds'), join(agentDir, 'sounds'), { recursive: true });
  cpSync(join(root, 'agent/models.json'), join(agentDir, 'models.json'));
  const config = JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8'));
  const fixturePath = join(directory, 'fixture.ts');
  const settings = JSON.stringify({ ...config, extensions: [fixturePath],
    enableInstallTelemetry: false, cacheWarming: 'off', defaultProjectTrust: 'never' });
  writeFileSync(join(agentDir, 'settings.json'), settings);
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ openai: {
    type: 'oauth', access: 'fixture-oauth-access', refresh: 'fixture-refresh', expires: 9999999999999,
  } }));
  writeFileSync(join(agentDir, 'AGENTS.md'), '# Fixture instructions\n');
  const paths = Object.fromEntries(['ready', 'go', 'done', 'query', 'color', 'theme', 'input', 'key', 'command',
    'commandDone', 'submit', 'running', 'stream', 'followUp', 'release', 'quick', 'events', 'quit'].map(name => [name, join(directory, name)]));
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
      faux.setResponses(['first', 'second', 'interactive', 'steering', 'follow-up', 'quick'].map(text => fauxAssistantMessage(text + ' fixture answer')));
      let timer;
      let tui;
      let lastInput = '';
      const inputs = [];
      function consume(path) {
        try { unlinkSync(path); return true; }
        catch (error) {
          if (['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) return false;
          throw error;
        }
      }
      pi.on('input', event => {
        lastInput = event.text;
        inputs.push({ source: event.source, text: event.text, streamingBehavior: event.streamingBehavior ?? null });
        writeFileSync(paths.events, JSON.stringify(inputs));
      });
      pi.on('session_start', (_event, ctx) => {
        ctx.ui.setWidget('fixture-query', instance => {
          tui = instance;
          return { render: () => [], invalidate: () => {} };
        });
        process.stdout.write('\x1b]10;#aabbcc\x07\x1b]11;#1a2b3c\x07');
        writeFileSync(paths.ready, String(process.pid));
        timer = setInterval(() => {
          if (ctx.isIdle() && consume(paths.go)) pi.sendUserMessage('fixture request');
          if (ctx.isIdle() && consume(paths.command)) {
            ctx.ui.setEditorText('/session');
            process.stdin.emit('data', Buffer.from('\r'));
            setTimeout(() => writeFileSync(paths.commandDone, ctx.ui.getEditorText()), 100);
          }
          if (ctx.isIdle() && consume(paths.submit)) {
            ctx.ui.setEditorText('interactive fixture request');
            process.stdin.emit('data', Buffer.from('\r'));
          }
          if (consume(paths.stream)) {
            ctx.ui.setEditorText('steering fixture request');
            process.stdin.emit('data', Buffer.from('\r'));
          }
          if (consume(paths.followUp)) {
            ctx.ui.setEditorText('follow-up fixture request');
            process.stdin.emit('data', Buffer.from('\x11'));
          }
          if (ctx.isIdle() && consume(paths.quick)) {
            ctx.ui.setEditorText('quick fixture request');
            process.stdin.emit('data', Buffer.from('\r'));
          }
          if (consume(paths.query)) {
            void tui.queryTerminalColors({ timeoutMs: 1000 }).then(colors => {
              writeFileSync(paths.theme, JSON.stringify({ appearance: ctx.ui.theme.appearance, text: ctx.ui.theme.colors.text, userMessageBg: ctx.ui.theme.colors.userMessageBg }));
              writeFileSync(paths.color, JSON.stringify(colors));
            });
          }
          if (consume(paths.input)) {
            process.stdin.emit('data', Buffer.from('x'));
            setTimeout(() => writeFileSync(paths.key, ctx.ui.getEditorText()), 50);
          }
          if (existsSync(paths.quit)) { clearInterval(timer); ctx.shutdown(); }
        }, 100);
      });
      pi.on('before_agent_start', async event => {
        if (event.messageType !== 'user' || event.prompt !== 'interactive fixture request') return;
        writeFileSync(paths.running, 'running');
        while (!consume(paths.release)) await new Promise(resolve => setTimeout(resolve, 50));
      });
      pi.on('agent_settled', () => writeFileSync(paths.done, lastInput));
      pi.on('session_shutdown', () => { clearInterval(timer); });
    }
  `;
  writeFileSync(fixturePath, fixture);
  const notifyPath = join(agentDir, 'extensions/notify.ts');
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir,
    settingsManager: sdk.SettingsManager.create(root, agentDir), additionalExtensionPaths: [notifyPath],
    noSkills: true, noPromptTemplates: true });
  await loader.reload();
  const extensionPaths = loader.getExtensions().extensions.map(extension => extension.path);
  assert.equal(extensionPaths.filter(path => path === notifyPath).length, 1);
  assert.ok(extensionPaths.indexOf(notifyPath) < extensionPaths.indexOf(fixturePath));
  const pwsh = execFileSync('mise.exe', ['which', 'pwsh'], { encoding: 'utf8' }).trim();
  const assignments = { homePath: directory, agentDir, nodePath: process.execPath,
    cliPath: join(packageRoot, 'dist/bundle/cli.js'), pwshPath: pwsh,
    windowTitle: `pi-notify-test-${Date.now()}-${process.pid}`,
    readyPath: paths.ready, goPath: paths.go, donePath: paths.done, queryPath: paths.query,
    colorPath: paths.color, themePath: paths.theme, inputPath: paths.input, keyPath: paths.key,
    commandPath: paths.command, commandDonePath: paths.commandDone, submitPath: paths.submit,
    runningPath: paths.running, streamPath: paths.stream, followUpPath: paths.followUp,
    releasePath: paths.release, quickPath: paths.quick, eventsPath: paths.events, quitPath: paths.quit };
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const prefix = Object.entries(assignments).map(([name, value]) => `$${name} = ${literal(value)};`).join('\n');
  const driver = prefix + `\n& ([scriptblock]::Create([IO.File]::ReadAllText(${literal(join(root, 'tests/support/notification-window.ps1'))})))`;
  const encoded = Buffer.from(driver, 'utf16le').toString('base64');
  let result;
  try {
    result = await promisify(execFile)('mise.exe', ['exec', '--', 'pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 110000 });
  } catch (error) {
    assert.fail(`driver failed in ${directory}: code=${error.code} killed=${error.killed} signal=${error.signal}\nstdout=${error.stdout}\nstderr=${error.stderr}`);
  }
  assert.match(result.stdout, /minimized interactive prompts, preserved other windows, and restored on completion/);
  assert.deepEqual(JSON.parse(readFileSync(paths.events, 'utf8')), [
    { source: 'extension', text: 'fixture request', streamingBehavior: null },
    { source: 'extension', text: 'fixture request', streamingBehavior: null },
    { source: 'interactive', text: 'interactive fixture request', streamingBehavior: null },
    { source: 'interactive', text: 'steering fixture request', streamingBehavior: 'steer' },
    { source: 'interactive', text: 'follow-up fixture request', streamingBehavior: 'followUp' },
    { source: 'interactive', text: 'quick fixture request', streamingBehavior: null },
  ]);
  assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), settings);
});
