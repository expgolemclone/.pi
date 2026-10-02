import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension, { parseSettings } from '../agent/extensions/agents-settings.ts';

const settings = { provider: 'openai', model: 'test-model', thinkingLevel: 'medium', serviceTier: 'priority' };

test('parses Pi settings without application permission fields', () => {
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

test('loads live Pi settings, instructions and priority tier without a legacy home directory', async () => {
  assert.equal(existsSync(join(homedir(), '.codex')), false);
  const live = parseSettings(readFileSync(join(homedir(), '.agents/settings.json'), 'utf8'));
  const handlers = new Map();
  let thinking;
  let selected;
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    setModel: async (model) => { selected = model; return true; },
    setThinkingLevel: (level) => { thinking = level; },
    getThinkingLevel: () => thinking,
  };
  extension(pi);
  const model = { provider: live.provider, id: live.model };
  const ctx = {
    model,
    modelRegistry: {
      find: (provider, id) => { assert.equal(provider, live.provider); assert.equal(id, live.model); return model; },
      isUsingOAuth: () => true,
    },
    ui: { notify: (message) => assert.fail(message) },
  };
  await handlers.get('session_start')({}, ctx);
  assert.equal(selected, model);
  assert.equal(thinking, live.thinkingLevel);
  assert.deepEqual(await handlers.get('input')({}, ctx), { action: 'continue' });
  const event = { systemPromptOptions: { contextFiles: [] } };
  handlers.get('before_agent_start')(event);
  handlers.get('before_agent_start')(event);
  assert.equal(event.systemPromptOptions.contextFiles.length, 1);
  assert.equal(event.systemPromptOptions.contextFiles[0].content, readFileSync(join(homedir(), '.agents/AGENTS.md'), 'utf8'));
  assert.deepEqual(handlers.get('before_provider_request')({ payload: { model: live.model } }, ctx),
    { model: live.model, service_tier: live.serviceTier });
  assert.equal(handlers.get('before_provider_request')({ payload: {} }, { model: { provider: 'other' } }), undefined);
  const result = await handlers.get('input')({}, {
    ...ctx, modelRegistry: { ...ctx.modelRegistry, isUsingOAuth: () => false }, ui: { notify: () => {} },
  });
  assert.deepEqual(result, { action: 'handled' });
});
