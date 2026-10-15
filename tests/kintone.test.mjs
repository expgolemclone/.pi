import assert from 'node:assert/strict';
import { findPackageJSON } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { activePiPackageRoot } from '../tools/pi-install.mjs';

const extensionPath = fileURLToPath(new URL('../agent/extensions/kintone.ts', import.meta.url));
const packageRoot = await activePiPackageRoot();
const aiRoot = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(packageRoot, 'dist/index.js'))));
const sdk = await import(pathToFileURL(join(packageRoot, 'dist/index.js')));
const { loadExtensions } = await import(pathToFileURL(join(packageRoot, 'dist/core/extensions/loader.js')));
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(
  join(aiRoot, 'dist/providers/faux.js')));

function fixture(t) {
  const directory = mkdtempSync('C:/dev/tmp/pi-kintone-test-');
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = directory;
  let cleanup = async () => {};
  t.after(async () => {
    try { await cleanup(); }
    finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const integrationPath = join(directory, 'kintone-workspace/integrations/pi.js');
  const configPath = join(directory, 'kintone-workspace/config.json');
  const journal = join(directory, 'server.jsonl');
  const serverPath = join(directory, 'server.mjs');
  mkdirSync(dirname(integrationPath), { recursive: true });
  const integration = `
    import { readFileSync } from 'node:fs';
    export default function (pi) {
      const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
      if (config.invalid) throw new Error('Invalid kintone runtime release identity');
      pi.registerMcpServer('kintone', config);
    }
  `;
  writeFileSync(integrationPath, integration);
  // Protocol-only local fixture. No kintone credentials, business operations, or network.
  writeFileSync(serverPath, `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const record = event => appendFileSync(process.argv[2], JSON.stringify({ event, pid: process.pid }) + '\\n');
    record('start');
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (!('id' in request)) continue;
      let result;
      switch (request.method) {
        case 'initialize':
          await new Promise(resolve => setTimeout(resolve, 50));
          result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1' } };
          break;
        case 'tools/list':
          result = { tools: [{ name: 'echo', description: 'Echo fixture text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
          break;
        case 'tools/call':
          record('call'); result = { content: [{ type: 'text', text: request.params.arguments.text }] }; break;
        case 'ping': result = {}; break;
        default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown fixture method' } }) + '\\n'); continue;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    }
  `);
  const config = { command: process.execPath, args: [serverPath, journal], cwd: directory, timeout: 10 };
  const writeConfig = value => writeFileSync(configPath, JSON.stringify(value));
  writeConfig(config);
  return {
    directory, integrationPath, integration, config, writeConfig,
    cleanup: fn => { cleanup = fn; },
    records: () => existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

async function unitFixture(t) {
  const f = fixture(t);
  const loaded = await loadExtensions([extensionPath], f.directory);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const tool = extension.tools.get('kintone_connect').definition;
  assert.equal(extension.handlers.size, 0); // Pi owns the MCP session lifecycle.
  return { ...f, loaded, tool, connect: signal => tool.execute('connect', {}, signal) };
}

test('loading exposes one sequential tool without registering or starting MCP', async t => {
  const f = await unitFixture(t);
  assert.equal(f.tool.executionMode, 'sequential');
  assert.match(f.tool.promptGuidelines.join(' '), /resumed sessions/);
  assert.deepEqual(f.loaded.runtime.mcpServers.list(), []);
  assert.deepEqual(f.records(), []);
});

test('activation reuses the installed factory and Pi registry; repeat activation is idempotent', async t => {
  const f = await unitFixture(t);
  const register = t.mock.method(f.loaded.runtime.mcpServers, 'register');
  const result = await f.connect();
  assert.match(result.content[0].text, /separate codemode call/);
  assert.equal(f.loaded.runtime.mcpServers.list().length, 1);
  assert.deepEqual(f.loaded.runtime.mcpServers.list()[0].config, f.config);
  await f.connect();
  assert.equal(register.mock.callCount(), 1);
});

test('missing installation and invalid activation fail visibly and can be repaired', async t => {
  const f = await unitFixture(t);
  rmSync(f.integrationPath);
  await assert.rejects(f.connect(), /Cannot find|not found|ENOENT/);
  assert.deepEqual(f.loaded.runtime.mcpServers.list(), []);
  writeFileSync(f.integrationPath, f.integration);
  f.writeConfig({ invalid: true });
  await assert.rejects(f.connect(), /Invalid kintone runtime release identity/);
  assert.deepEqual(f.loaded.runtime.mcpServers.list(), []);
  f.writeConfig(f.config);
  await f.connect();
  assert.equal(f.loaded.runtime.mcpServers.list().length, 1);
});

test('missing LOCALAPPDATA and aborted calls never register a server', async t => {
  const f = await unitFixture(t);
  delete process.env.LOCALAPPDATA;
  await assert.rejects(f.connect(), /LOCALAPPDATA is required/);
  process.env.LOCALAPPDATA = f.directory;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(f.connect(aborted.signal), { name: 'AbortError' });
  assert.deepEqual(f.loaded.runtime.mcpServers.list(), []);
});

test('cancellation during import cannot register a stale server and a later call can retry', async t => {
  const f = await unitFixture(t);
  writeFileSync(f.integrationPath, 'await new Promise(resolve => setTimeout(resolve, 30));\n' + f.integration);
  const controller = new AbortController();
  const pending = f.connect(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(f.loaded.runtime.mcpServers.list(), []);
  await f.connect();
  assert.equal(f.loaded.runtime.mcpServers.list().length, 1);
});

test('another extension owns its registration and activation cannot replace it', async t => {
  const f = await unitFixture(t);
  f.loaded.runtime.mcpServers.register({ name: 'kintone', config: f.config, extensionPath: '<other-extension>' });
  await assert.rejects(f.connect(), /already registered by another extension/);
  assert.equal(f.loaded.runtime.mcpServers.list()[0].extensionPath, '<other-extension>');
});

test('a broken installed factory cannot report successful activation', async t => {
  const f = await unitFixture(t);
  writeFileSync(f.integrationPath, 'export default function () {}');
  await assert.rejects(f.connect(), /did not register/);
  assert.deepEqual(f.loaded.runtime.mcpServers.list(), []);
});

async function runtimeFixture(t) {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in fixture'); });
  const faux = fauxProvider({ models: [{ id: 'kintone-fixture' }] });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(f.directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const errors = [];
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = sdk.SettingsManager.inMemory({
      defaultTools: ['codemode'], compaction: { enabled: false }, retry: { enabled: false },
      cacheWarming: 'off', defaultProjectTrust: 'never', enableInstallTelemetry: false,
    });
    const services = await sdk.createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [extensionPath], systemPrompt: 'Isolated kintone loader fixture',
        extensionFactories: [sdk.createCodemodeExtension(), sdk.createMcpExtension()],
      },
    });
    const result = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: modelRuntime.getModel(faux.provider.id, 'kintone-fixture'), thinkingLevel: 'off' });
    assert.deepEqual(result.extensionsResult.errors, []);
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: f.directory, agentDir: join(f.directory, 'agent'),
    sessionManager: sdk.SessionManager.create(f.directory, join(f.directory, 'sessions')),
  });
  const bind = session => session.bindExtensions({ onError: event => errors.push(event) });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  f.cleanup(async () => {
    await runtime.dispose();
    for (const row of f.records().filter(row => row.event === 'start')) {
      assert.throws(() => process.kill(row.pid, 0), /ESRCH/, `Leaked fixture process ${row.pid}`);
    }
  });
  async function prompt(responses) {
    faux.setResponses(responses);
    await runtime.session.prompt('Local fixture operation');
    assert.deepEqual(errors, []);
    return runtime.session.messages.filter(message => message.role === 'toolResult');
  }
  const connect = () => prompt([
    fauxAssistantMessage(fauxToolCall('kintone_connect', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Activated'),
  ]);
  const use = () => prompt([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'const found = await searchTools("echo", { namespace: "mcp__kintone" }); if (found.length !== 1) throw Error("Missing fixture tool"); const result = await tools.mcp__kintone__echo({ text: "fixture-ok" }); text(result);' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Used fixture'),
  ]);
  return { ...f, runtime, faux, errors, prompt, connect, use };
}

function noMcp(f) {
  assert.ok(f.runtime.session.getActiveToolNames().includes('kintone_connect'));
  assert.ok(f.runtime.session.getActiveToolNames().includes('codemode'));
  assert.ok(!f.runtime.session.getCallableToolNames().some(name => name.startsWith('mcp__kintone__')));
}

test('real Pi starts no server for unrelated work, then connects and discovers during one active run', { timeout: 30000 }, async t => {
  const f = await runtimeFixture(t);
  noMcp(f);
  await f.prompt([fauxAssistantMessage('Unrelated work')]);
  assert.deepEqual(f.records(), []);
  const results = await f.prompt([
    fauxAssistantMessage([
      fauxToolCall('kintone_connect', {}, { id: 'connect-1' }),
      fauxToolCall('kintone_connect', {}, { id: 'connect-2' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'const found = await searchTools("echo", { namespace: "mcp__kintone" }); text(found); const result = await tools.mcp__kintone__echo({ text: "fixture-ok" }); text(result);' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Finished'),
  ]);
  assert.ok(results.every(result => !result.isError), JSON.stringify(results));
  assert.ok(JSON.stringify(results).includes('fixture-ok'));
  assert.equal(f.records().filter(row => row.event === 'start').length, 1);
  assert.equal(f.records().filter(row => row.event === 'call').length, 1);
});

test('real Pi reports failed MCP discovery instead of claiming a ready connection', { timeout: 30000 }, async t => {
  const f = await runtimeFixture(t);
  f.writeConfig({ ...f.config, command: join(f.directory, 'missing-node.exe') });
  const connected = await f.connect();
  assert.match(connected.at(-1).content[0].text, /registered; connection is managed by Pi/);
  const results = await f.prompt([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'const found = await searchTools("echo", { namespace: "mcp__kintone" }); if (found.length === 0) throw Error("kintone connection unavailable");' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Connection failed'),
  ]);
  assert.equal(results.at(-1).isError, true);
  assert.match(JSON.stringify(results.at(-1)), /kintone connection unavailable/);
  assert.deepEqual(f.records(), []);
});

test('real Pi new, resume, reload, fork, and quit close children and never eagerly restore MCP', { timeout: 30000 }, async t => {
  const f = await runtimeFixture(t);
  await f.connect(); await f.use();
  const original = f.runtime.session.sessionFile;
  await f.runtime.newSession();
  noMcp(f);
  assert.throws(() => process.kill(f.records()[0].pid, 0), /ESRCH/);
  assert.equal(f.records().filter(row => row.event === 'start').length, 1);
  await f.connect(); await f.use();
  await f.runtime.switchSession(original);
  noMcp(f);
  assert.equal(f.records().filter(row => row.event === 'start').length, 2);
  await f.connect(); await f.use();
  await f.runtime.session.reload();
  noMcp(f);
  assert.equal(f.records().filter(row => row.event === 'start').length, 3);
  for (const row of f.records().filter(row => row.event === 'start')) {
    assert.throws(() => process.kill(row.pid, 0), /ESRCH/);
  }
  await f.connect(); await f.use();
  assert.equal(f.records().filter(row => row.event === 'start').length, 4);
  const user = f.runtime.session.sessionManager.getEntries().find(entry => entry.type === 'message' && entry.message.role === 'user');
  await f.runtime.fork(user.id);
  noMcp(f);
  for (const row of f.records().filter(row => row.event === 'start')) {
    assert.throws(() => process.kill(row.pid, 0), /ESRCH/);
  }
  await f.connect(); await f.use();
  assert.equal(f.records().filter(row => row.event === 'start').length, 5);
});
