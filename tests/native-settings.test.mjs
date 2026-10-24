import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { aiRoot, packageRoot, sdk } from './support/pi-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { ModelRegistry, ModelRuntime, SessionManager, SettingsManager } = sdk;
const { loadExtensions } = await import(pathToFileURL(join(packageRoot, 'dist/core/extensions/loader.js')));
const config = JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8'));
const moduleUrl = path => JSON.stringify(pathToFileURL(path).href);

test('tests use mise-managed Pi without a project-local installation', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], undefined);
  assert.equal(manifest.devDependencies?.['@earendil-works/pi-coding-agent'], undefined);
  assert.equal(existsSync(join(root, 'node_modules/@earendil-works/pi-coding-agent')), false);
});

function fixture(t) {
  const home = mkdtempSync('C:/dev/tmp/pi-native-settings-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agentDir = join(home, '.pi/agent');
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), '# Fixture instructions\n');
  for (const file of ['settings.json', 'models.json']) cpSync(join(root, 'agent', file), join(agentDir, file));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ ...config, extensions: [],
    enableInstallTelemetry: false, cacheWarming: 'off', defaultProjectTrust: 'never' }));
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ openai: {
    type: 'oauth', access: 'fixture-oauth-access', refresh: 'fixture-refresh', expires: 9999999999999,
  } }));
  return { home, agentDir };
}

function cliFixture(t) {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, 'extensions/fixture.ts'), `
    import { fauxProvider, fauxAssistantMessage } from ${moduleUrl(join(aiRoot, 'dist/providers/faux.js'))};
    import { createProvider } from ${moduleUrl(join(aiRoot, 'dist/models.js'))};
    export default function(pi) {
      const thinkingLevelMap = { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
      const faux = fauxProvider({ provider: 'openai', models: [${JSON.stringify(config.defaultModel)}, 'alternate'].map(id => ({ id, reasoning: true })) });
      const models = faux.provider.getModels().map(model => ({ ...model, thinkingLevelMap }));
      pi.registerProvider(createProvider({ id: 'openai', models, api: faux.provider, auth: { oauth: { name: 'Fixture',
        login: async () => { throw new Error('No login in tests'); },
        refresh: async () => { throw new Error('No refresh in tests'); },
        toAuth: async () => ({ apiKey: 'fixture-oauth-access' }),
      } } }));
      faux.setResponses([fauxAssistantMessage('fixture answer')]);
      pi.on('agent_start', (_event, ctx) => console.error('selection:' + ctx.model.id + ':' + pi.getThinkingLevel()));
      pi.on('session_shutdown', () => console.error('fixture-cleanup'));
    }
  `);
  f.run = (args = [], sessionFile) => {
    const env = { ...process.env, USERPROFILE: f.home, HOME: f.home, PI_CODING_AGENT_DIR: f.agentDir,
      PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' };
    for (const key of Object.keys(env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete env[key];
    const result = spawnSync(process.execPath, [
      '--import', 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("Network forbidden in fixture")}',
      join(packageRoot, 'dist/bundle/cli.js'), '--no-mcp', '--no-tools', '--no-skills', '--no-prompt-templates',
      ...(sessionFile ? ['--session', sessionFile] : ['--no-session']), '-p', ...args, 'fixture request',
    ], { cwd: f.home, env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'fixture answer');
    assert.match(result.stderr, /fixture-cleanup/);
    assert.doesNotMatch(result.stderr, /Extension error|Network forbidden/);
    return result;
  };
  return f;
}

test('real CLI uses the native model and thinking defaults without shared settings or an OAuth gate', t => {
  const f = cliFixture(t);
  const settings = SettingsManager.create(f.home, f.agentDir);
  assert.equal(settings.getDefaultProvider(), config.defaultProvider);
  assert.equal(settings.getDefaultModel(), config.defaultModel);
  assert.equal(settings.getDefaultThinkingLevel(), config.defaultThinkingLevel);
  assert.match(f.run().stderr, new RegExp(`selection:${config.defaultModel}:${config.defaultThinkingLevel}`));
});

test('real CLI explicit model and thinking choices are not reset before input', t => {
  const f = cliFixture(t);
  assert.match(f.run(['--model', 'openai/alternate', '--thinking', 'low']).stderr, /selection:alternate:low/);
});

test('real CLI preserves the model and thinking restored from a session', t => {
  const f = cliFixture(t);
  const manager = SessionManager.create(f.home, join(f.home, 'sessions'));
  manager.appendModelChange('openai', 'alternate');
  manager.appendThinkingLevelChange('low');
  manager.appendMessage({ role: 'user', content: 'previous task', timestamp: 1 });
  assert.match(f.run([], manager.getSessionFile()).stderr, /selection:alternate:low/);
});

test('native model sampling parameters keep priority for normal and custom-compaction OAuth requests', async t => {
  const f = fixture(t);
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(String(url).startsWith('https://api.openai.com/v1/responses'), `Unexpected network request: ${url}`);
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-oauth-access');
    const body = JSON.parse(options.body);
    bodies.push(body);
    const item = { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'fixture checkpoint', annotations: [] }] };
    const events = [
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', service_tier: body.service_tier,
        output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const runtime = await ModelRuntime.create({ authPath: join(f.agentDir, 'auth.json'),
    modelsPath: join(f.agentDir, 'models.json'), refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const model = registry.find(config.defaultProvider, config.defaultModel);
  assert.ok(model);
  assert.equal((await registry.getApiKeyAndHeaders(model)).apiKey, 'fixture-oauth-access');
  assert.equal(model.samplingParams.service_tier, 'priority');
  const response = await registry.streamSimple(model, {
    systemPrompt: 'Normal agent prompt', messages: [{ role: 'user', content: 'fixture request', timestamp: 1 }],
  }, { reasoning: 'off', maxRetries: 0 }).result();
  assert.equal(response.stopReason, 'stop', response.errorMessage);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].service_tier, 'priority');

  const loaded = await loadExtensions([join(root, 'agent/extensions/custom-compaction/index.ts')], f.home);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.getThinkingLevel = () => 'off';
  const handler = loaded.extensions[0].handlers.get('session_before_compact')[0];
  const preparation = { messagesToSummarize: [{ role: 'user', content: 'old task', timestamp: 1 }],
    turnPrefixMessages: [], firstKeptEntryId: 'keep', tokensBefore: 5000, settings: { reserveTokens: 0 } };
  const ctx = { model, modelRegistry: registry, ui: { notify: message => assert.fail(message) } };
  const prompt = readFileSync(join(root, 'agent/extensions/custom-compaction/COMPACTION.md'), 'utf8').trim();
  for (const reason of ['manual', 'threshold', 'overflow']) {
    const result = await handler({ preparation, reason, signal: new AbortController().signal }, ctx);
    assert.equal(result.compaction.summary, 'fixture checkpoint');
    assert.equal(result.compaction.usage.totalTokens, 30);
    assert.equal(bodies.at(-1).service_tier, 'priority');
    const instruction = bodies.at(-1).input.find(item => item.role === 'developer' || item.role === 'system');
    assert.equal(instruction.content, prompt);
  }
  assert.equal(bodies.length, 4);
});
