import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseSettings } from '../agent/extensions/agents-settings.ts';

const extensionPath = fileURLToPath(new URL('../agent/extensions/agents-settings.ts', import.meta.url));
const npmRoot = execFileSync('pwsh', ['-NoProfile', '-Command', 'npm root --global'], { encoding: 'utf8' }).trim();
const packageRoot = join(npmRoot, '@earendil-works/pi-coding-agent');
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
  assert.doesNotMatch(readFileSync(extensionPath, 'utf8'), /\.codex/);
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
    const { applyServiceTier } = await import(${moduleUrl(extensionPath)});
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

// Real CLI, fake OAuth/provider. No live credentials, model requests or network.
function cliFixture(t) {
  const f = fixture(t);
  cpSync(extensionPath, join(f.agentDir, 'extensions/agents-settings.ts'));
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, cacheWarming: 'off', defaultProjectTrust: 'never' }));
  writeFileSync(join(f.agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'fixture', refresh: 'fixture', expires: 9999999999999 } }));
  writeFileSync(join(f.agentDir, 'extensions/fixture.ts'), `
    import { fauxProvider, fauxAssistantMessage } from ${moduleUrl(join(packageRoot, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js'))};
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
