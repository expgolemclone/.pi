import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { aiRoot, sdk } from './support/pi-runtime.mjs';

const config = JSON.parse(readFileSync(new URL('../agent/mcp.json', import.meta.url), 'utf8'));
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(
  join(aiRoot, 'dist/providers/faux.js')));

test('Pi does not duplicate the workspace-owned MCP server configuration', () => {
  assert.deepEqual(config, { mcpServers: {} });
});

async function fixture(t, { failConnection = false } = {}) {
  const directory = mkdtempSync('C:/dev/tmp/pi-native-mcp-test-');
  const journal = join(directory, 'server.jsonl');
  const serverPath = join(directory, 'server.mjs');
  const integrationPath = join(directory, 'integration.mjs');
  const records = () => existsSync(journal)
    ? readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  let runtime;
  t.after(async () => {
    try {
      await runtime?.dispose();
      for (const row of records().filter(row => row.event === 'start')) {
        assert.throws(() => process.kill(row.pid, 0), /ESRCH/, `Leaked fixture process ${row.pid}`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
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
  const serverConfig = {
    command: failConnection ? join(directory, 'missing-node.exe') : process.execPath,
    args: [serverPath, journal], cwd: directory, timeout: 10,
  };
  writeFileSync(integrationPath, `export default function (pi) { pi.registerMcpServer('kintone', ${JSON.stringify(serverConfig)}); }`);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in fixture'); });
  const faux = fauxProvider({ models: [{ id: 'native-mcp-fixture' }] });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
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
        additionalExtensionPaths: [integrationPath],
        extensionFactories: [sdk.createCodemodeExtension(), sdk.createMcpExtension()],
      },
    });
    const result = await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: modelRuntime.getModel(faux.provider.id, 'native-mcp-fixture'), thinkingLevel: 'off' });
    assert.deepEqual(result.extensionsResult.errors, []);
    return { ...result, services, diagnostics: services.diagnostics };
  };
  runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: directory, agentDir: join(directory, 'agent'),
    sessionManager: sdk.SessionManager.create(directory, join(directory, 'sessions')),
  });
  const bind = session => session.bindExtensions({ onError: event => errors.push(event) });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  async function prompt(responses) {
    faux.setResponses(responses);
    await runtime.session.prompt('Local fixture operation');
    assert.deepEqual(errors, []);
    return runtime.session.messages.filter(message => message.role === 'toolResult');
  }
  const use = () => prompt([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'const found = await searchTools("echo", { namespace: "mcp__kintone" }); if (found.length !== 1) throw Error("Missing fixture tool"); const result = await tools.mcp__kintone__echo({ text: "fixture-ok" }); text(result);' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Used fixture'),
  ]);
  return { runtime, records, prompt, use };
}

function assertNativeTools(f) {
  const names = f.runtime.session.getActiveToolNames();
  assert.ok(names.includes('codemode'));
  assert.ok(!names.includes('kintone_connect'));
  assert.ok(!names.some(name => name.startsWith('mcp__kintone__')));
  assert.ok(!f.runtime.session.systemPrompt.includes('kintone_connect'));
  assert.ok(!f.runtime.session.systemPrompt.includes('Echo fixture text'));
}

test('native Pi connects and discovers MCP without a connection tool or eager tool declarations', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assertNativeTools(f);
  const results = await f.use();
  assert.ok(results.every(result => !result.isError), JSON.stringify(results));
  assert.ok(JSON.stringify(results).includes('fixture-ok'));
  assert.equal(f.records().filter(row => row.event === 'start').length, 1);
  assert.equal(f.records().filter(row => row.event === 'call').length, 1);
  assertNativeTools(f);
});

test('native Pi reports failed discovery without claiming a ready connection', { timeout: 30000 }, async t => {
  const f = await fixture(t, { failConnection: true });
  const results = await f.prompt([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'const found = await searchTools("echo", { namespace: "mcp__kintone" }); if (found.length === 0) throw Error("kintone connection unavailable");' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Connection failed'),
  ]);
  assert.equal(results.at(-1).isError, true);
  assert.match(JSON.stringify(results.at(-1)), /kintone connection unavailable/);
  assert.deepEqual(f.records(), []);
});

test('native Pi reconnects across new, resume, reload and fork, and closes every child', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.use();
  const original = f.runtime.session.sessionFile;
  const transitions = [
    () => f.runtime.newSession(),
    () => f.runtime.switchSession(original),
    () => f.runtime.session.reload(),
    () => f.runtime.fork(f.runtime.session.sessionManager.getEntries().find(entry =>
      entry.type === 'message' && entry.message.role === 'user').id),
  ];
  let starts = 1;
  for (const transition of transitions) {
    const previous = f.records().filter(row => row.event === 'start');
    await transition();
    for (const row of previous) assert.throws(() => process.kill(row.pid, 0), /ESRCH/);
    assertNativeTools(f);
    await f.use();
    assert.equal(f.records().filter(row => row.event === 'start').length, ++starts);
  }
});
