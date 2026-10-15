import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseSettings } from '../agent/extensions/agents-settings/settings.ts';
import { requireOAuth } from '../agent/extensions/agents-settings/openai-oauth.ts';
import { activePiPackageRoot } from '../tools/pi-install.mjs';
import { findPackageJSON } from 'node:module';

const extensionDirectory = fileURLToPath(new URL('../agent/extensions/agents-settings/', import.meta.url));
const extensionPath = join(extensionDirectory, 'index.ts');
const packageRoot = await activePiPackageRoot();
const aiRoot = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(packageRoot, 'dist/index.js'))));
const moduleUrl = path => JSON.stringify(pathToFileURL(path).href);
const settings = { provider: 'openai', model: 'fixture', thinkingLevel: 'medium', serviceTier: 'priority' };

function fixture(t) {
  const home = mkdtempSync('C:/dev/tmp/pi-settings-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const shared = join(home, '.agents');
  const agentDir = join(home, '.pi/agent');
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  const settingsPath = join(shared, 'settings.json');
  const instructionsPath = join(shared, 'AGENTS.md');
  writeFileSync(settingsPath, JSON.stringify(settings));
  writeFileSync(instructionsPath, '# Fixture instructions\n');
  const env = { ...process.env, USERPROFILE: home, HOME: home, PI_CODING_AGENT_DIR: agentDir };
  for (const key of Object.keys(env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete env[key];
  const run = code => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: home, env, encoding: 'utf8', timeout: 30000,
  });
  return { home, shared, agentDir, settingsPath, instructionsPath, env, run };
}

function checked(result, status = 0) {
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return result;
}

const mockSession = `
  import assert from 'node:assert/strict';
  import extension from ${moduleUrl(extensionPath)};
  import { readFileSync, writeFileSync, rmSync } from 'node:fs';
  import { join } from 'node:path';
  import { homedir } from 'node:os';
  const shared = join(homedir(), '.agents');
  const handlers = new Map();
  let thinking, selected;
  const model = { provider: 'openai', id: 'fixture' };
  const pi = {
    events: { emit() {} },
    on: (event, handler) => handlers.set(event, handler),
    setModel: async value => { selected = value; return true; },
    setThinkingLevel: value => { thinking = value; },
    getThinkingLevel: () => thinking,
  };
  extension(pi);
  const notifications = [];
  const ctx = { model, modelRegistry: { find: () => model, isUsingOAuth: () => true },
    ui: { notify: (message, level) => notifications.push({ message, level }) } };
`;

test('parses BOM settings without application permission fields', () => {
  assert.deepEqual(parseSettings('\uFEFF' + JSON.stringify(settings)), settings);
  for (const field of ['approval_policy', 'sandbox_mode']) {
    assert.throws(() => parseSettings(JSON.stringify({ ...settings, [field]: 'never' })));
  }
});

test('rejects unknown, missing and invalid settings', () => {
  for (const input of [null, [], {}, { ...settings, thinkingLevel: 'invalid' },
    { ...settings, serviceTier: 'fast' }, { ...settings, provider: 'unknown' },
    { ...settings, model: '' }, { ...settings, extra: 'value' }]) {
    assert.throws(() => parseSettings(JSON.stringify(input)));
  }
});

test('syncs isolated settings and rereads instructions without duplicating context', t => {
  const f = fixture(t);
  for (const file of ['index.ts', 'settings.ts', 'openai-oauth.ts', 'instructions.ts']) {
    assert.doesNotMatch(readFileSync(join(extensionDirectory, file), 'utf8'), /\.codex/);
  }
  checked(f.run(mockSession + `
    await handlers.get('session_start')({}, ctx);
    assert.equal(selected, model);
    assert.equal(thinking, 'medium');
    assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'continue' });
    const event = { systemPromptOptions: { contextFiles: [] } };
    handlers.get('before_agent_start')(event);
    writeFileSync(join(shared, 'AGENTS.md'), '# Updated instructions');
    handlers.get('before_agent_start')(event);
    assert.deepEqual(event.systemPromptOptions.contextFiles, [{ path: join(shared, 'AGENTS.md'), content: '# Updated instructions' }]);
    assert.deepEqual(notifications, []);
  `));
});

test('OAuth readiness and verification finish before selecting the model and thinking level', t => {
  const f = fixture(t);
  checked(f.run(mockSession + `
    const calls = [];
    let release;
    pi.events.emit = (channel, request) => {
      assert.equal(channel, 'oauth:credential-readiness:v1');
      calls.push('readiness');
      request.waitUntil(new Promise(resolve => { release = resolve; }));
    };
    ctx.modelRegistry.isUsingOAuth = () => { calls.push('oauth'); return true; };
    pi.setModel = async value => { calls.push('model'); selected = value; return true; };
    pi.setThinkingLevel = value => { calls.push('thinking'); thinking = value; };
    const syncing = handlers.get('session_start')({}, ctx);
    assert.deepEqual(calls, ['readiness']);
    assert.equal(selected, undefined);
    assert.equal(thinking, undefined);
    release();
    await syncing;
    assert.deepEqual(calls, ['readiness', 'oauth', 'model', 'thinking']);
  `));
});

test('instruction helpers work without settings and preserve existing context identity and order', t => {
  const f = fixture(t);
  checked(f.run(`
    import assert from 'node:assert/strict';
    import { rmSync, writeFileSync } from 'node:fs';
    import { readInstructions, injectInstructions } from ${moduleUrl(join(extensionDirectory, 'instructions.ts'))};
    rmSync(${JSON.stringify(f.settingsPath)});
    const shared = readInstructions();
    const unrelated = { path: 'project/AGENTS.md', content: 'project instructions' };
    const existing = { path: shared.path.toUpperCase(), content: 'stale content' };
    const files = [unrelated, existing];
    injectInstructions(files);
    assert.equal(files.length, 2);
    assert.equal(files[0], unrelated);
    assert.equal(files[1], existing);
    assert.equal(existing.content, shared.content);
    writeFileSync(shared.path, '# Updated instructions');
    injectInstructions(files);
    assert.equal(existing.content, '# Updated instructions');
    rmSync(shared.path);
    assert.throws(() => readInstructions(), /ENOENT/);
    assert.throws(() => injectInstructions(files), /ENOENT/);
    assert.deepEqual(files, [unrelated, existing]);
  `));
});

const failures = [
  ['missing settings', "rmSync(join(shared, 'settings.json'));", /ENOENT/],
  ['malformed JSON', "writeFileSync(join(shared, 'settings.json'), '{');", /SyntaxError/],
  ['invalid schema', "writeFileSync(join(shared, 'settings.json'), '{}');", /must contain exactly/],
  ['invalid tier', "writeFileSync(join(shared, 'settings.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(shared, 'settings.json'))), serviceTier: 'fast' }));", /Unsupported service tier/],
  ['invalid thinking', "writeFileSync(join(shared, 'settings.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(shared, 'settings.json'))), thinkingLevel: 'invalid' }));", /Unsupported thinking level/],
  ['missing instructions', "rmSync(join(shared, 'AGENTS.md'));", /ENOENT/],
  ['unavailable model', 'ctx.modelRegistry.find = () => undefined;', /OAuth login/],
  ['non-OAuth auth', 'ctx.modelRegistry.isUsingOAuth = () => false;', /OAuth login/],
  ['setModel refusal', 'pi.setModel = async () => false;', /Could not select/],
  ['setModel exception', "pi.setModel = async () => { throw new Error('auth failed'); };", /auth failed/],
  ['clamped thinking', "pi.getThinkingLevel = () => 'low';", /cannot use the configured thinking/],
];
for (const [name, fail, pattern] of failures) {
  test(`print/JSON ${name} blocks input and marks failure`, t => {
    const f = fixture(t);
    for (const mode of ['print', 'json']) {
      writeFileSync(f.settingsPath, JSON.stringify(settings));
      writeFileSync(f.instructionsPath, '# Fixture instructions\n');
      const result = checked(f.run(mockSession + `
        ctx.mode = '${mode}';
        ${fail}
        assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'handled' });
        assert.equal(process.exitCode, 1);
        assert.deepEqual(notifications, []);
      `), 1);
      assert.match(result.stderr, pattern);
      assert.equal(result.stdout, '');
    }
  });
}

test('later valid input does not clear a one-shot failure exit code', t => {
  const f = fixture(t);
  for (const mode of ['print', 'json']) {
    const result = checked(f.run(mockSession + `
      ctx.mode = '${mode}';
      ctx.modelRegistry.isUsingOAuth = () => false;
      assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'handled' });
      ctx.modelRegistry.isUsingOAuth = () => true;
      assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'continue' });
      assert.equal(process.exitCode, 1);
    `), 1);
    assert.match(result.stderr, /OAuth login/);
  }
});

test('TUI/RPC validation and notification errors never continue input or change exit status', t => {
  const f = fixture(t);
  checked(f.run(mockSession + `
    for (const mode of ['tui', 'rpc']) {
      ctx.mode = mode;
      ctx.ui.notify = (message, level) => notifications.push({ message, level });
      ctx.modelRegistry.isUsingOAuth = () => false;
      assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'handled' });
      assert.equal(notifications.at(-1).level, 'error');
      ctx.ui.notify = () => { throw new Error('UI failed'); };
      assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'handled' });
      assert.equal(process.exitCode, undefined);
      ctx.modelRegistry.isUsingOAuth = () => true;
      assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'continue' });
    }
  `));
});

test('tier transformation preserves fields, rereads every allowed tier and ignores other providers', t => {
  const f = fixture(t);
  checked(f.run(mockSession + `
    const { applyServiceTier } = await import(${moduleUrl(join(extensionDirectory, 'settings.ts'))});
    for (const tier of ['priority', 'auto', 'default', 'flex']) {
      const config = JSON.parse(readFileSync(join(shared, 'settings.json')));
      writeFileSync(join(shared, 'settings.json'), JSON.stringify({ ...config, serviceTier: tier }));
      const payload = { model: 'fixture', stream: true, input: [], service_tier: 'old' };
      const expected = { ...payload, service_tier: tier };
      assert.deepEqual(applyServiceTier(payload, 'openai'), expected);
      assert.deepEqual(handlers.get('before_provider_request')({ payload }, ctx), expected);
      assert.equal(payload.service_tier, 'old');
    }
    writeFileSync(join(shared, 'settings.json'), '{}');
    assert.throws(() => applyServiceTier({}, 'openai'), /must contain exactly/);
    assert.equal(applyServiceTier({}, 'other'), undefined);
    assert.equal(handlers.get('before_provider_request')({ payload: {} }, { model: { provider: 'other' } }), undefined);
  `));
});

function oauthFixture({ offers = [], ready, auth, native = false } = {}) {
  const model = { provider: 'openai', id: 'fixture', baseUrl: 'https://api.openai.com/v1' };
  const sessionManager = {};
  const ctx = { model, sessionManager, modelRegistry: {
    isUsingOAuth: () => native,
    getApiKeyAndHeaders: async () => auth ?? { ok: true, apiKey: 'fixture-access' },
  } };
  const pi = { events: { emit(channel, request) {
    assert.equal(request.session, sessionManager);
    assert.equal(request.provider, 'openai');
    if (channel === 'oauth:credential-readiness:v1' && ready) request.waitUntil(ready());
    if (channel === 'oauth:credential-source:v1') for (const offer of offers) request.offer(offer);
  } } };
  return { pi, ctx, model };
}
const validOffer = () => ({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 60000 });
const validateOAuth = f => requireOAuth(f.pi, f.ctx, f.model);

test('accepts native OAuth and exactly matching named OAuth, including equivalent offers', async () => {
  await validateOAuth(oauthFixture({ native: true }));
  const credential = validOffer();
  await validateOAuth(oauthFixture({ offers: [credential, structuredClone(credential)] }));
});

test('readiness settles before checking runtime auth and collecting offers', async () => {
  let ready = false;
  const f = oauthFixture({ offers: [validOffer()], ready: async () => { await Promise.resolve(); ready = true; } });
  f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    assert.equal(ready, true);
    return { ok: true, apiKey: 'fixture-access' };
  };
  await validateOAuth(f);
});

test('API keys, absent, malformed, stale, mismatched and ambiguous offers fail closed', async () => {
  const valid = validOffer();
  for (const offers of [[], [null], [{}], [{ ...valid, type: 'api_key' }],
    [{ ...valid, refresh: undefined }], [{ ...valid, expires: NaN }],
    [{ ...valid, expires: 0 }], [{ ...valid, access: 'different' }],
    [valid, { ...valid, refresh: 'conflicting' }], [{ ...valid, refresh: 'conflicting' }, valid]]) {
    await assert.rejects(validateOAuth(oauthFixture({ offers })), /OAuth login/);
  }
  for (const auth of [{ ok: false }, { ok: true },
    { ok: true, apiKey: 'fixture-access', baseUrl: 'https://untrusted.example/v1' },
    { ok: true, apiKey: 'fixture-access', headers: { Authorization: 'Bearer another-key' } }]) {
    await assert.rejects(validateOAuth(oauthFixture({ offers: [valid], auth })), /OAuth login/);
  }
});

test('credential-owner failures remain redacted and cannot authorize input', async () => {
  const f = oauthFixture({ ready: async () => { throw new Error('fixture-secret'); } });
  await assert.rejects(validateOAuth(f), error => /OAuth login/.test(error.message) && !error.message.includes('fixture-secret'));
  f.pi.events.emit = () => { throw new Error('fixture-secret'); };
  await assert.rejects(validateOAuth(f), error => !error.message.includes('fixture-secret'));
});

test('model changes during readiness or runtime resolution fail closed', async () => {
  for (const stage of ['ready', 'auth']) {
    const f = oauthFixture({ offers: [validOffer()] });
    const change = () => { f.ctx.model = { ...f.model }; };
    if (stage === 'ready') f.pi.events.emit = (channel, request) => {
      if (channel === 'oauth:credential-readiness:v1') request.waitUntil(Promise.resolve().then(change));
    };
    else f.ctx.modelRegistry.getApiKeyAndHeaders = async () => { change(); return { ok: true, apiKey: 'fixture-access' }; };
    await assert.rejects(validateOAuth(f), /OAuth login/);
  }
});

test('unresponsive credential readiness has a bounded wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const check = assert.rejects(validateOAuth(oauthFixture({ ready: () => new Promise(() => {}) })), /OAuth login/);
  t.mock.timers.tick(10000);
  await check;
});

// Real CLI, fake OAuth/provider. No live credentials, model requests or network.
function cliFixture(t) {
  const f = fixture(t);
  cpSync(extensionDirectory, join(f.agentDir, 'extensions/agents-settings'), { recursive: true });
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, cacheWarming: 'off', defaultProjectTrust: 'never' }));
  writeFileSync(join(f.agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'fixture', refresh: 'fixture', expires: 9999999999999 } }));
  writeFileSync(join(f.agentDir, 'extensions/fixture.ts'), `
    import { fauxProvider, fauxAssistantMessage } from ${moduleUrl(join(aiRoot, 'dist/providers/faux.js'))};
    export default function(pi) {
      const faux = fauxProvider({ provider: 'openai', models: [{ id: 'fixture', reasoning: true }] });
      pi.registerProvider({ ...faux.provider, auth: { oauth: { name: 'Fixture',
        login: async () => { throw new Error('No login in tests'); },
        refresh: async () => { throw new Error('No refresh in tests'); },
        toAuth: async () => ({ apiKey: 'fixture' }),
      } } });
      faux.setResponses([() => { console.error('fixture-provider-called'); return fauxAssistantMessage('fixture answer'); }]);
      pi.on('agent_start', () => console.error('fixture-agent-start'));
      pi.on('session_shutdown', () => console.error('fixture-cleanup'));
    }
  `);
  f.cli = mode => spawnSync(process.execPath, [
    '--import', 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("Network forbidden in fixture")}',
    join(packageRoot, 'dist/bundle/cli.js'), '--no-mcp', '--no-tools', '--no-session', '--no-skills', '--no-prompt-templates',
    '--provider', 'openai', '--model', 'fixture', ...(mode === 'print' ? ['-p'] : ['--mode', 'json']), 'fixture request',
  ], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 30000 });
  return f;
}

for (const mode of ['print', 'json']) {
  test(`real CLI ${mode} rejects settings and cleans up instead of succeeding`, t => {
    const f = cliFixture(t);
    writeFileSync(f.settingsPath, '{}');
    const result = checked(f.cli(mode), 1);
    assert.match(result.stderr, /must contain exactly/);
    assert.match(result.stderr, /fixture-cleanup/);
    assert.doesNotMatch(result.stderr, /fixture-agent-start|fixture-provider-called|Network forbidden/);
    if (mode === 'print') assert.equal(result.stdout, '');
    else result.stdout.trim().split('\n').forEach(line => JSON.parse(line));
  });
  test(`real CLI ${mode} accepts valid settings and keeps success exit status`, t => {
    const f = cliFixture(t);
    const result = checked(f.cli(mode));
    assert.match(result.stderr, /fixture-provider-called/);
    assert.match(result.stderr, /fixture-cleanup/);
    assert.doesNotMatch(result.stderr, /Extension error|Network forbidden/);
    if (mode === 'print') assert.equal(result.stdout.trim(), 'fixture answer');
    else {
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.ok(events.some(event => event.type === 'message_end' && event.message.role === 'assistant'));
    }
  });
}
