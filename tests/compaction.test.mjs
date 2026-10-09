import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmRoot = execFileSync('pwsh', ['-NoProfile', '-Command', 'npm root --global'], { encoding: 'utf8' }).trim();
const packageRoot = join(npmRoot, '@earendil-works/pi-coding-agent');
const { loadExtensions, discoverAndLoadExtensions } = await import(pathToFileURL(join(packageRoot, 'dist/core/extensions/loader.js')));
const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(join(packageRoot, 'dist/index.js')));
const { prepareCompaction } = await import(pathToFileURL(join(packageRoot, 'dist/core/compaction/compaction.js')));
const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(
  join(packageRoot, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js'),
));
const { loadPromptTemplates } = await import(pathToFileURL(join(packageRoot, 'dist/core/prompt-templates.js')));
const bundlePath = 'agent/extensions/custom-compaction';
const systemPrompt = readFileSync(join(root, bundlePath, 'COMPACTION.md'), 'utf8').trim();

async function fixture(t) {
  const directory = mkdtempSync(join('C:/dev/tmp/', 'pi-compaction-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentDir = join(directory, 'agent');
  const bundle = join(agentDir, 'extensions/custom-compaction');
  cpSync(join(root, bundlePath), bundle, { recursive: true });
  const extensionPath = join(bundle, 'index.ts');
  const promptPath = join(bundle, 'COMPACTION.md');
  const loaded = await loadExtensions([extensionPath], directory);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const [extension] = loaded.extensions;
  assert.deepEqual([...extension.handlers.keys()], ['session_before_compact']);
  assert.equal(extension.handlers.get('session_before_compact').length, 1);
  loaded.runtime.getThinkingLevel = () => 'medium';
  const handler = extension.handlers.get('session_before_compact')[0];
  const signal = new AbortController().signal;
  const preparation = {
    messagesToSummarize: [{ role: 'user', content: 'old request', timestamp: 1 }],
    turnPrefixMessages: [],
    previousSummary: 'old checkpoint',
    firstKeptEntryId: 'keep-this-entry',
    tokensBefore: 12345,
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  const event = { type: 'session_before_compact', reason: 'manual', willRetry: false, signal, preparation };
  const requests = [];
  const notifications = [];
  let response = {
    stopReason: 'stop', content: [{ type: 'text', text: 'new checkpoint' }], usage: { totalTokens: 30 },
  };
  const ctx = {
    model: { provider: 'test', id: 'test', maxTokens: 8192 },
    modelRegistry: {
      streamSimple: (model, context, options) => {
        requests.push({ model, context, options });
        return { result: async () => response };
      },
    },
    ui: { notify: (text, level) => notifications.push({ text, level }) },
  };
  return { directory, agentDir, promptPath, loaded, handler, event, requests, notifications, ctx,
    setResponse: (value) => { response = value; } };
}

for (const reason of ['manual', 'threshold', 'overflow']) {
  test(`${reason} uses only the custom prompt and preserves Pi's boundary and usage`, async (t) => {
    const f = await fixture(t);
    f.event.reason = reason;
    f.event.customInstructions = 'keep permission scope exactly';
    const result = await f.handler(f.event, f.ctx);
    assert.deepEqual(result, { compaction: {
      summary: 'new checkpoint', firstKeptEntryId: 'keep-this-entry', tokensBefore: 12345,
      usage: { totalTokens: 30 },
    } });
    assert.equal(f.requests.length, 1);
    const { model, context, options } = f.requests[0];
    assert.equal(model, f.ctx.model);
    assert.equal(context.systemPrompt, systemPrompt);
    assert.equal(context.messages.length, 1);
    assert.deepEqual(JSON.parse(context.messages[0].content[0].text), {
      previousSummary: 'old checkpoint', conversation: '[User]: old request',
      customInstructions: 'keep permission scope exactly',
    });
    assert.equal(context.tools, undefined);
    assert.equal(options.signal, f.event.signal);
    assert.equal(options.maxTokens, 8192);
    assert.equal(options.reasoning, 'medium');
    assert.equal(options.cacheRetention, 'none');
    assert.match(options.sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(f.notifications, []);
  });
}

test('split turns combine history and prefix once and keep custom instructions', async (t) => {
  const f = await fixture(t);
  f.event.preparation.isSplitTurn = true;
  f.event.preparation.turnPrefixMessages = [{ role: 'user', content: 'prefix request', timestamp: 2 }];
  f.event.customInstructions = 'include unresolved errors';
  await f.handler(f.event, f.ctx);
  const input = JSON.parse(f.requests[0].context.messages[0].content[0].text);
  assert.equal(input.conversation, '[User]: old request\n\n[User]: prefix request');
  assert.equal(input.customInstructions, 'include unresolved errors');
  assert.equal(f.requests.length, 1);
});

test('initial compaction, resolved token budgets and prompt edits need no reload', async (t) => {
  const f = await fixture(t);
  delete f.event.preparation.previousSummary;
  f.event.preparation.settings.reserveTokens = 1000;
  await f.handler(f.event, f.ctx);
  assert.equal(f.requests[0].options.maxTokens, 800);
  assert.equal(JSON.parse(f.requests[0].context.messages[0].content[0].text).previousSummary, null);
  writeFileSync(f.promptPath, 'replacement instructions\n');
  await f.handler(f.event, f.ctx);
  assert.equal(f.requests[1].context.systemPrompt, 'replacement instructions');
  assert.notEqual(f.requests[0].options.sessionId, f.requests[1].options.sessionId);
});

for (const stopReason of ['length', 'error', 'aborted', 'toolUse', 'pending']) {
  test(`rejects ${stopReason} output instead of falling back or storing a partial summary`, async (t) => {
    const f = await fixture(t);
    f.setResponse({ stopReason, content: [{ type: 'text', text: 'partial summary' }], errorMessage: 'test error' });
    assert.deepEqual(await f.handler(f.event, f.ctx), { cancel: true });
    assert.equal(f.requests.length, 1);
    assert.equal(f.notifications[0].level, 'error');
    assert.match(f.notifications[0].text, /Summary did not complete/);
  });
}

for (const content of [[], [{ type: 'text', text: '  ' }], [{ type: 'thinking', thinking: 'not a summary' }],
  [{ type: 'text', text: 'summary' }, { type: 'toolCall', name: 'write', arguments: {} }]]) {
  test('rejects empty, thinking-only or tool-calling summaries', async (t) => {
    const f = await fixture(t);
    f.setResponse({ stopReason: 'stop', content });
    assert.deepEqual(await f.handler(f.event, f.ctx), { cancel: true });
    assert.equal(f.notifications.length, 1);
  });
}

test('missing/empty prompt, absent model and zero budget cancel before a provider call', async (t) => {
  const f = await fixture(t);
  rmSync(f.promptPath);
  assert.deepEqual(await f.handler(f.event, f.ctx), { cancel: true });
  writeFileSync(f.promptPath, '  \n');
  assert.deepEqual(await f.handler(f.event, f.ctx), { cancel: true });
  writeFileSync(f.promptPath, systemPrompt);
  assert.deepEqual(await f.handler(f.event, { ...f.ctx, model: undefined }), { cancel: true });
  f.event.preparation.settings.reserveTokens = 0;
  assert.deepEqual(await f.handler(f.event, f.ctx), { cancel: true });
  assert.equal(f.requests.length, 0);
});

test('provider exceptions and cancellation before/after generation cancel without fallback', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await f.handler({ ...f.event, signal: controller.signal }, f.ctx), { cancel: true });
  assert.equal(f.requests.length, 0);
  f.ctx.modelRegistry.streamSimple = () => { throw new Error('provider failed'); };
  assert.deepEqual(await f.handler(f.event, f.ctx), { cancel: true });
  const late = new AbortController();
  f.ctx.modelRegistry.streamSimple = () => ({ result: async () => {
    late.abort();
    return { stopReason: 'stop', content: [{ type: 'text', text: 'must not persist' }] };
  } });
  assert.deepEqual(await f.handler({ ...f.event, signal: late.signal }, f.ctx), { cancel: true });
});

test('UI failure cannot cause a native prompt fallback', async (t) => {
  const f = await fixture(t);
  rmSync(f.promptPath);
  f.ctx.ui.notify = () => { throw new Error('UI failed'); };
  assert.deepEqual(await f.handler(f.event, f.ctx), { cancel: true });
  assert.equal(f.requests.length, 0);
});

test('standard discovery loads one bundled extension and no prompt command', async (t) => {
  const f = await fixture(t);
  const discovered = await discoverAndLoadExtensions([], f.directory, f.agentDir);
  assert.deepEqual(discovered.errors, []);
  assert.equal(discovered.extensions.length, 1);
  assert.deepEqual([...discovered.extensions[0].handlers.keys()], ['session_before_compact']);
  assert.equal(discovered.extensions[0].path, join(f.agentDir, 'extensions/custom-compaction/index.ts'));
  const prompts = loadPromptTemplates({
    cwd: f.directory, agentDir: f.agentDir, promptPaths: [], includeDefaults: true,
  });
  assert.deepEqual(prompts, { templates: [], diagnostics: [] });
  assert.equal(existsSync(join(root, 'agent/COMPACTION.md')), false);
  assert.equal(existsSync(join(root, 'agent/extensions/custom-compaction.ts')), false);
});

for (const scenario of ['manual', 'threshold', 'incomplete']) {
  test(`SDK ${scenario} compaction respects the custom prompt and checkpoint contract`, async (t) => {
    const automatic = scenario === 'threshold';
    const f = await fixture(t);
    const faux = fauxProvider({ models: [{ id: 'compaction-test', contextWindow: 30000, maxTokens: 4096 }] });
    const runtime = await ModelRuntime.create({
      authPath: join(f.directory, 'auth.json'), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const model = runtime.getModel(faux.provider.id, 'compaction-test');
    assert.ok(model);
    const settings = { enabled: true, reserveTokens: 29000, keepRecentTokens: 100 };
    const settingsManager = SettingsManager.inMemory({ compaction: settings, retry: { enabled: false } });
    const manager = SessionManager.inMemory(f.directory);
    manager.appendMessage({ role: 'user', content: 'old task '.repeat(1000), timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage('old answer '.repeat(100)));
    const recent = manager.appendMessage({ role: 'user', content: 'latest task', timestamp: 3 });
    manager.appendMessage(fauxAssistantMessage('recent answer'));
    const expected = prepareCompaction(manager.getBranch(), settings);
    assert.ok(expected);
    const resourceLoader = {
      getExtensions: () => f.loaded,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'test agent',
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    const { session } = await createAgentSession({
      cwd: f.directory, agentDir: f.agentDir, modelRuntime: runtime, model,
      thinkingLevel: 'off', tools: [], resourceLoader, settingsManager, sessionManager: manager,
    });
    t.after(() => session.dispose());
    const notices = [];
    await session.bindExtensions({ uiContext: { notify: (message) => notices.push(message) } });
    const compactionEvents = [];
    session.subscribe((event) => { if (event.type === 'compaction_end') compactionEvents.push(event); });
    const requests = [];
    faux.setResponses([
      (context, options) => {
        requests.push({ context, options });
        assert.equal(context.messages[0].role, 'system');
        assert.equal(context.messages[0].content, systemPrompt);
        assert.equal(context.messages.length, 2);
        return fauxAssistantMessage('verified custom checkpoint', {
          stopReason: scenario === 'incomplete' ? 'length' : 'stop',
        });
      },
      fauxAssistantMessage('continued normally'),
    ]);
    if (scenario === 'incomplete') {
      const before = manager.getEntries();
      await assert.rejects(session.compact(), /Compaction cancelled/);
      assert.deepEqual(manager.getEntries(), before);
      assert.equal(faux.state.callCount, 1); // No native summarizer fallback.
      assert.equal(compactionEvents.length, 1);
      assert.equal(compactionEvents[0].result, undefined);
      assert.match(notices[0], /Summary did not complete \(length\)/);
      return;
    }
    try {
      if (automatic) await session.prompt('continue');
      else await session.compact('keep deployment permission');
    } catch (error) {
      assert.fail(`${error}\n${notices.join('\n')}`);
    }
    assert.deepEqual(notices, []);
    assert.equal(requests.length, 1);
    assert.equal(compactionEvents.length, 1);
    assert.equal(compactionEvents[0].reason, automatic ? 'threshold' : 'manual');
    const entries = manager.getEntries().filter((entry) => entry.type === 'compaction');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].fromHook, true);
    assert.equal(entries[0].summary, 'verified custom checkpoint');
    assert.equal(entries[0].firstKeptEntryId, expected.firstKeptEntryId);
    assert.ok(entries[0].usage.totalTokens > 0);
    assert.ok(manager.buildSessionProjection().entries.some((entry) => entry.sourceEntry.id === recent));
    assert.doesNotMatch(entries[0].summary, /<read-files>|<modified-files>|Turn Context|## Goal/);
  });
}
