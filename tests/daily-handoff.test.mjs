import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import extension, { nextDeadline } from '../agent/extensions/daily-handoff.ts';
import { getPackageDir } from '@earendil-works/pi-coding-agent';

const extensionPath = fileURLToPath(new URL('../agent/extensions/daily-handoff.ts', import.meta.url));
const packageRoot = getPackageDir();
const aiRoot = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(packageRoot, 'dist/index.js'))));
const schedules = [
  { profile: 'company', time: [16, 30], at: '16:30:00' },
  { profile: 'nucbox', time: [20, 45], at: '20:45:00' },
];
const instant = (day, time) => new Date(`2026-10-${day}T${time}`).getTime();
const result = profile => ({ code: 0, killed: false, stdout: JSON.stringify(profile), stderr: '' });

function clock(t, now = instant('13', '16:29:00')) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const pending = new Set();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref: t.mock.fn() };
    pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => pending.delete(timer));
  return {
    pending,
    at: time => t.mock.timers.setTime(time),
    only() {
      assert.equal(pending.size, 1);
      const timer = [...pending][0];
      assert.equal(timer.unref.mock.callCount(), 1);
      return timer;
    },
    fire(time) {
      t.mock.timers.setTime(time);
      const timer = this.only();
      pending.delete(timer);
      timer.callback();
    },
  };
}

function register(t, { profile = 'company', entries = [], mode = 'tui', exec } = {}) {
  const handlers = new Map();
  const journal = [...entries];
  const api = {
    on: (event, handler) => handlers.set(event, handler),
    exec: t.mock.fn(exec ?? (async () => result(profile))),
    appendEntry: t.mock.fn((customType, data) => journal.push({ type: 'custom', customType, data })),
    sendUserMessage: t.mock.fn(() => assert.equal(journal.at(-1).customType, 'daily-handoff-attempt')),
  };
  const ctx = {
    mode, hasUI: mode === 'tui' || mode === 'rpc',
    sessionManager: { getEntries: () => journal },
    ui: { notify: t.mock.fn(), setEditorText: t.mock.fn(), getEditorText: () => 'unfinished user draft' },
  };
  extension(api);
  assert.equal(api.exec.mock.callCount(), 0);
  return {
    api, ctx, journal, handlers,
    start: (reason = 'startup') => handlers.get('session_start')({ reason }, ctx),
    stop: (reason = 'quit') => handlers.get('session_shutdown')({ reason }, ctx),
  };
}

function sent(f, count = 1) {
  assert.equal(f.api.sendUserMessage.mock.callCount(), count);
  for (const call of f.api.sendUserMessage.mock.calls) {
    assert.deepEqual(call.arguments, ['handoff', { deliverAs: 'steer' }]);
  }
  assert.equal(f.ctx.ui.setEditorText.mock.callCount(), 0);
}

for (const { profile, time, at } of schedules) {
  test(`${profile} next deadline includes weekends and never catches up on startup`, () => {
    for (const [now, expected] of [
      [new Date(instant('16', at) - 1), `2026-10-16T${at}`], // Friday
      [new Date(instant('16', at)), `2026-10-17T${at}`],     // Saturday
      [new Date('2026-10-17T23:59:00'), `2026-10-18T${at}`], // Sunday
      [new Date('2026-10-31T23:59:00'), `2026-11-01T${at}`],
    ]) {
      const original = now.getTime();
      assert.equal(nextDeadline(now, time).getTime(), new Date(expected).getTime());
      assert.equal(now.getTime(), original);
    }
  });

  for (const mode of ['tui', 'rpc', 'print', 'json']) {
    test(`${profile} ${mode} sends only at ${at}, keeps drafts, and rearms daily`, async t => {
      const c = clock(t);
      const f = register(t, { profile, mode });
      await f.start();
      assert.equal(c.only().delay, 60000);
      sent(f, 0);
      c.fire(instant('13', '16:30:00'));
      sent(f, profile === 'company' ? 1 : 0);
      c.fire(instant('13', '20:45:00'));
      sent(f);
      assert.deepEqual(f.journal, [{ type: 'custom', customType: 'daily-handoff-attempt', data: { date: '2026-10-13' } }]);
      assert.equal(c.only().delay, 60000);
      c.fire(instant('14', at));
      sent(f, 2);
      f.stop();
      assert.equal(c.pending.size, 0);
    });
  }

  test(`${profile} retains a deadline crossed during profile resolution`, async t => {
    const c = clock(t);
    let resolve;
    const f = register(t, { exec: () => new Promise(done => { resolve = done; }) });
    const start = f.start();
    c.at(instant('13', at) + 1000);
    resolve(result(profile));
    await start;
    assert.equal(c.only().delay, 0);
    c.fire(instant('13', at) + 1000);
    sent(f);
  });
}

for (const profile of ['another-profile', '__proto__', 'constructor']) {
  test(`${profile} never schedules or submits`, async t => {
    const c = clock(t);
    const f = register(t, { profile });
    await f.start();
    assert.equal(c.pending.size, 0);
    sent(f, 0);
  });
}

test('separate running Pi sessions each receive handoff rather than sharing a machine-wide dedup key', async t => {
  const c = clock(t);
  const instances = [register(t, { profile: 'nucbox' }), register(t, { profile: 'nucbox' })];
  for (const f of instances) await f.start();
  assert.equal(c.pending.size, 2);
  c.at(instant('13', '20:45:00'));
  for (const timer of [...c.pending]) { c.pending.delete(timer); timer.callback(); }
  for (const f of instances) { sent(f); f.stop(); }
  assert.equal(c.pending.size, 0);
});

test('timer rechecks wall clock without firing early and notices a same-day forward jump', async t => {
  const c = clock(t, instant('13', '15:00:00'));
  const f = register(t);
  await f.start();
  c.fire(instant('13', '14:00:00'));
  sent(f, 0);
  assert.equal(c.only().delay, 60000);
  c.fire(instant('13', '16:29:59.500'));
  sent(f, 0);
  assert.equal(c.only().delay, 500);
  c.fire(instant('13', '16:45:00'));
  sent(f);
});

test('starting after deadline does not send immediately or replay the previous day', async t => {
  const c = clock(t, instant('13', '21:00:00'));
  const f = register(t, { profile: 'nucbox' });
  await f.start();
  c.fire(instant('13', '21:01:00'));
  sent(f, 0);
  c.fire(instant('14', '20:45:00'));
  sent(f);
});

test('sleep across calendar days skips stale deadlines rather than replaying them', async t => {
  const c = clock(t);
  const f = register(t, { profile: 'nucbox' });
  await f.start();
  c.fire(instant('15', '21:00:00'));
  sent(f, 0);
  c.fire(instant('16', '20:45:00'));
  sent(f);
  assert.equal(f.journal[0].data.date, '2026-10-16');
});

test('all session entries suppress duplicate attempts, including after a backward clock and reload', async t => {
  const c = clock(t);
  const f = register(t, { profile: 'nucbox', entries: [
    { type: 'custom', customType: 'other', data: { date: '2026-10-13' } },
    { type: 'custom', customType: 'daily-handoff-attempt', data: null },
    { type: 'custom', customType: 'daily-handoff-attempt', data: { date: '2026-10-12' } },
    { type: 'custom', customType: 'daily-handoff-attempt', data: { date: '2026-10-13' } },
  ] });
  await f.start();
  c.fire(instant('13', '20:45:00'));
  sent(f, 0);
  f.stop('reload');
  c.at(instant('13', '20:44:00'));
  const resumed = register(t, { profile: 'nucbox', entries: f.journal });
  await resumed.start('reload');
  c.fire(instant('13', '20:45:00'));
  sent(resumed, 0);
  c.fire(instant('14', '20:45:00'));
  sent(resumed);
});

for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
  test(`shutdown ${reason} is idempotent and cancels stale callbacks`, async t => {
    const c = clock(t);
    const f = register(t, { profile: 'nucbox' });
    await f.start();
    const stale = c.only();
    f.stop(reason);
    f.stop(reason);
    assert.equal(c.pending.size, 0);
    c.at(instant('13', '20:45:00'));
    stale.callback();
    sent(f, 0);
    assert.equal(c.pending.size, 0);
  });
}

test('repeated start keeps one timer and old callbacks cannot detach the new timer', async t => {
  const c = clock(t);
  const f = register(t);
  await f.start();
  const old = c.only();
  await f.start('new');
  const current = c.only();
  old.callback();
  assert.equal(c.only(), current);
  f.stop();
  assert.equal(c.pending.size, 0);
});

test('shutdown during profile resolution cannot arm a timer', async t => {
  const c = clock(t);
  let resolve;
  const f = register(t, { exec: () => new Promise(done => { resolve = done; }) });
  const start = f.start();
  f.stop();
  resolve(result('company'));
  await start;
  assert.equal(c.pending.size, 0);
  sent(f, 0);
});

test('late profile lookup cannot replace the new session schedule', async t => {
  const c = clock(t);
  const resolve = [];
  const f = register(t, { exec: () => new Promise(done => resolve.push(done)) });
  const old = f.start();
  const current = f.start('resume');
  resolve[1](result('nucbox'));
  await current;
  resolve[0](result('company'));
  await old;
  c.fire(instant('13', '16:30:00'));
  sent(f, 0);
  c.fire(instant('13', '20:45:00'));
  sent(f);
});

test('profile failures are visible to Pi, do not arm a timer, and never retry', async t => {
  const c = clock(t);
  for (const response of [
    { ...result('company'), code: 1, stderr: 'no binding' },
    { ...result('company'), killed: true },
    { ...result('company'), stdout: '{' }, result({ Name: 'company' }), result(''),
  ]) {
    const f = register(t, { exec: async () => response });
    await assert.rejects(f.start());
    assert.equal(c.pending.size, 0);
    assert.equal(f.api.exec.mock.callCount(), 1);
    sent(f, 0);
  }
});

test('synchronous timer failures stop automation visibly without another submission', async t => {
  const c = clock(t);
  const f = register(t);
  f.api.appendEntry.mock.mockImplementation(() => { throw new Error('journal failure'); });
  await f.start();
  c.fire(instant('13', '16:30:00'));
  sent(f, 0);
  assert.equal(c.pending.size, 0);
  assert.match(f.ctx.ui.notify.mock.calls[0].arguments[0], /journal failure/);
});

test('print/JSON timer failures remain visible on stderr without protocol output or retry', async t => {
  const c = clock(t);
  const log = t.mock.method(console, 'error', () => {});
  for (const mode of ['print', 'json']) {
    c.at(instant('13', '16:29:00'));
    const f = register(t, { mode });
    f.api.appendEntry.mock.mockImplementation(() => { throw new Error('journal failure'); });
    await f.start();
    c.fire(instant('13', '16:30:00'));
    assert.equal(c.pending.size, 0);
    assert.equal(f.ctx.ui.notify.mock.callCount(), 0);
    sent(f, 0);
  }
  assert.equal(log.mock.callCount(), 2);
  assert.ok(log.mock.calls.every(call => /journal failure/.test(call.arguments[0])));
});

function homeFixture(t) {
  const directory = mkdtempSync('C:/dev/tmp/pi-handoff-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const map = join(directory, 'local-repository-map');
  mkdirSync(map);
  cpSync(join(homedir(), 'local-repository-map/repository-map.psm1'), join(map, 'repository-map.psm1'));
  writeFileSync(join(map, 'profiles.json'), JSON.stringify({ schemaVersion: 1, profiles: {
    company: { computerName: 'FIXTURE_COMPANY' }, nucbox: { computerName: 'FIXTURE_HOME' },
    another: { computerName: 'FIXTURE_OTHER' },
  } }));
  return { directory, env: { ...process.env, USERPROFILE: directory, HOME: directory } };
}

test('canonical machine bindings select company and nucbox times without duplicated host names', async t => {
  const c = clock(t);
  const home = homeFixture(t);
  for (const [computer, profile] of [
    ['FIXTURE_COMPANY', 'company'], ['FIXTURE_HOME', 'nucbox'], ['FIXTURE_OTHER', 'another'], ['UNKNOWN', null],
  ]) {
    c.at(instant('13', '16:29:00'));
    const f = register(t, { exec: async (command, args, options) => {
      assert.equal(command, 'pwsh');
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
      assert.deepEqual(options, { timeout: 10000 });
      const child = spawnSync(command, args, { encoding: 'utf8', timeout: 15000,
        env: { ...home.env, COMPUTERNAME: computer } });
      assert.ifError(child.error);
      return { code: child.status, killed: false, stdout: child.stdout, stderr: child.stderr };
    } });
    if (profile === null) await assert.rejects(f.start(), /No repository profile is bound/);
    else await f.start();
    assert.equal(c.pending.size, profile === 'company' || profile === 'nucbox' ? 1 : 0);
    if (c.pending.size) {
      c.fire(instant('13', '16:30:00'));
      sent(f, profile === 'company' ? 1 : 0);
      c.fire(instant('13', '20:45:00'));
      sent(f);
    }
    f.stop();
  }
});

test('both local deadlines span DST transitions without adding a fixed 24 hours', t => {
  const home = homeFixture(t);
  const code = `
    import assert from 'node:assert/strict';
    import { nextDeadline } from ${JSON.stringify(pathToFileURL(extensionPath).href)};
    for (const time of [[16, 30], [20, 45]]) {
      for (const [date, hours] of [['2026-10-31', 25], ['2026-03-07', 23]]) {
        const now = new Date(date + 'T00:00:00');
        now.setHours(...time, 0, 0);
        const next = nextDeadline(now, time);
        assert.equal(next.getHours(), time[0]);
        assert.equal(next.getMinutes(), time[1]);
        assert.equal((next - now) / 3600000, hours);
      }
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...home.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('real unref timers do not keep otherwise idle one-shot processes alive', t => {
  const home = homeFixture(t);
  for (const { profile } of schedules) {
    const code = `
      import extension from ${JSON.stringify(pathToFileURL(extensionPath).href)};
      let start;
      extension({ on: (event, handler) => { if(event === 'session_start') start = handler; },
        exec: async () => ({ code: 0, killed: false, stdout: JSON.stringify(${JSON.stringify(profile)}), stderr: '' }) });
      await start({}, {});
      console.log('scheduled');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: home.env, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'scheduled');
  }
});

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(join(packageRoot, 'dist/index.js')));
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(
  join(aiRoot, 'dist/providers/faux.js')));

async function sdkFixture(t, { profile = 'nucbox', input, beforeStart, beforeCompact, tool } = {}) {
  const home = homeFixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in fixture'); });
  const faux = fauxProvider({ models: [{ id: 'handoff-fixture' }] });
  const runtime = await ModelRuntime.create({
    authPath: join(home.directory, 'auth.json'), modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 100 }, retry: { enabled: false }, cacheWarming: 'off',
    defaultProjectTrust: 'never', enableInstallTelemetry: false,
  });
  const inputs = [];
  const errors = [];
  const loader = new DefaultResourceLoader({
    cwd: home.directory, agentDir: join(home.directory, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: 'Isolated handoff test',
    extensionFactories: [pi => {
      // Mock only the profile lookup, not Pi's message, journal or lifecycle APIs.
      pi.exec = async () => result(profile);
      extension(pi);
      pi.on('input', event => { inputs.push(event); return input?.(event); });
      if (beforeStart) pi.on('before_agent_start', beforeStart);
      if (beforeCompact) pi.on('session_before_compact', beforeCompact);
      if (tool) pi.registerTool({ name: 'fixture_tool', label: 'Fixture', description: 'Isolated test tool',
        parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: tool });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: home.directory, agentDir: join(home.directory, 'agent'), resourceLoader: loader,
    modelRuntime: runtime, model: runtime.getModel(faux.provider.id, 'handoff-fixture'),
    thinkingLevel: 'off', tools: tool ? ['fixture_tool'] : [], settingsManager,
    sessionManager: SessionManager.inMemory(home.directory),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ onError: event => errors.push(event) });
  return { session, faux, inputs, errors };
}

const userTexts = session => session.messages.filter(message => message.role === 'user').map(message =>
  typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
const turnOfEventLoop = () => new Promise(resolve => setImmediate(resolve));
function settled(session) {
  return new Promise(resolve => {
    const off = session.subscribe(event => { if (event.type === 'agent_settled') { off(); resolve(); } });
  });
}

for (const { profile, at } of schedules) {
  test(`real Pi ${profile} starts an idle run with exactly handoff`, async t => {
    const c = clock(t);
    const f = await sdkFixture(t, { profile });
    f.faux.setResponses([fauxAssistantMessage('fixture acknowledgment')]);
    const done = settled(f.session);
    c.fire(instant('13', at));
    await done;
    assert.deepEqual(userTexts(f.session), ['handoff']);
    assert.equal(f.inputs[0].source, 'extension');
    assert.equal(f.session.sessionManager.getEntries().filter(entry => entry.customType === 'daily-handoff-attempt').length, 1);
    assert.deepEqual(f.errors, []);
  });
}

for (const boundary of ['model', 'starting']) {
  test(`real Pi queues handoff at ${boundary} boundary without aborting active work`, async t => {
    const c = clock(t);
    let release, announce;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { announce = resolve; });
    const f = await sdkFixture(t, { beforeStart: boundary === 'starting' ? async event => {
      if (event.prompt === 'fixture task') { announce(); await gate; }
    } : undefined });
    f.faux.setResponses([
      async () => { if (boundary === 'model') { announce(); await gate; } return fauxAssistantMessage('first answer'); },
      fauxAssistantMessage('handoff acknowledgment'),
    ]);
    const run = f.session.prompt('fixture task');
    await entered;
    c.fire(instant('13', '20:45:00'));
    await turnOfEventLoop();
    release();
    await run;
    await f.session.waitForIdle();
    assert.deepEqual(userTexts(f.session), ['fixture task', 'handoff']);
    assert.deepEqual(f.errors, []);
  });
}

test('real Pi input validation can consume the automatic message without a model call or retry', async t => {
  const c = clock(t);
  const f = await sdkFixture(t, { input: () => ({ action: 'handled' }) });
  c.fire(instant('13', '20:45:00'));
  await turnOfEventLoop();
  assert.equal(f.inputs[0].text, 'handoff');
  assert.deepEqual(userTexts(f.session), []);
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(f.errors, []);
});

test('real Pi reports asynchronous submission failures without retrying or claiming completion', async t => {
  const c = clock(t);
  const f = await sdkFixture(t);
  f.session.agent.state.model = undefined;
  c.fire(instant('13', '20:45:00'));
  await turnOfEventLoop();
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(userTexts(f.session), []);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].event, 'send_user_message');
  assert.match(f.errors[0].error, /No model/);
  c.fire(instant('13', '20:46:00'));
  await turnOfEventLoop();
  assert.equal(f.inputs.length, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.session.sessionManager.getEntries().filter(entry => entry.customType === 'daily-handoff-attempt').length, 1);
});

test('real Pi finishes an active tool before consuming handoff without aborting its signal', async t => {
  const c = clock(t);
  let release, announce, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { announce = resolve; });
  const f = await sdkFixture(t, { tool: async (_id, _params, activeSignal) => {
    signal = activeSignal;
    announce();
    await gate;
    assert.equal(signal.aborted, false);
    return { content: [{ type: 'text', text: 'tool completed' }], details: undefined };
  } });
  f.session.setActiveToolsByName(['fixture_tool']);
  assert.deepEqual(f.session.getActiveToolNames(), ['fixture_tool']);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('fixture_tool', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('handoff acknowledgment'),
  ]);
  const run = f.session.prompt('fixture task');
  await Promise.race([entered, run.then(() => assert.fail(`Tool was not invoked: ${JSON.stringify(f.session.messages)}`))]);
  c.fire(instant('13', '20:45:00'));
  await turnOfEventLoop();
  assert.equal(signal.aborted, false);
  release();
  await run;
  assert.deepEqual(userTexts(f.session), ['fixture task', 'handoff']);
  assert.deepEqual(f.errors, []);
});

test('manual compaction rejection is visible and never bypassed or retried', async t => {
  const c = clock(t);
  let release, announce;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { announce = resolve; });
  const f = await sdkFixture(t, { beforeCompact: async () => {
    announce();
    await gate;
    return { cancel: true };
  } });
  const manager = f.session.sessionManager;
  manager.appendMessage({ role: 'user', content: 'old task '.repeat(4000), timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage('old response '.repeat(4000)));
  manager.appendMessage({ role: 'user', content: 'recent task', timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage('recent response'));
  const compact = assert.rejects(f.session.compact(), /Compaction cancelled/);
  await entered;
  c.fire(instant('13', '20:45:00'));
  await turnOfEventLoop();
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].event, 'send_user_message');
  assert.match(f.errors[0].error, /compaction is in progress/);
  assert.equal(f.faux.state.callCount, 0);
  release();
  await compact;
  c.fire(instant('13', '20:46:00'));
  await turnOfEventLoop();
  assert.equal(f.errors.length, 1);
  assert.equal(f.inputs.length, 0);
});
