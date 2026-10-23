import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const directory = fileURLToPath(new URL('../agent/extensions/shared-instructions/', import.meta.url));
const moduleUrl = file => JSON.stringify(pathToFileURL(join(directory, file)).href);
function run(t, code, status = 0) {
  const home = mkdtempSync('C:/dev/tmp/pi-instructions-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.agents'));
  writeFileSync(join(home, '.agents/AGENTS.md'), '# Shared instructions\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    import extension from ${moduleUrl('index.ts')};
    import { readInstructions, injectInstructions } from ${moduleUrl('instructions.ts')};
    const shared = join(homedir(), '.agents');
    const handlers = new Map();
    extension({ on: (name, handler) => handlers.set(name, handler) });
    assert.deepEqual([...handlers.keys()], ['input', 'before_agent_start']);
    assert.equal(existsSync(join(shared, 'settings.json')), false);
    const notifications = [];
    const ctx = { mode: 'tui', ui: { notify: (message, level) => notifications.push({ message, level }) } };
    ${code}
  `], { cwd: home, env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return result;
}

test('shared instructions update without reload, settings dependencies or model-selection methods', t => {
  run(t, `
    assert.deepEqual(handlers.get('input')({}, ctx), { action: 'continue' });
    const event = { systemPromptOptions: { contextFiles: [] } };
    handlers.get('before_agent_start')(event);
    writeFileSync(join(shared, 'AGENTS.md'), '# Updated instructions');
    assert.deepEqual(handlers.get('input')({}, ctx), { action: 'continue' });
    handlers.get('before_agent_start')(event);
    assert.deepEqual(event.systemPromptOptions.contextFiles, [{ path: join(shared, 'AGENTS.md'), content: '# Updated instructions' }]);
    assert.deepEqual(notifications, []);
  `);
});

test('instruction injection preserves existing context identity and order without duplication', t => {
  run(t, `
    const sharedFile = readInstructions();
    const unrelated = { path: 'project/AGENTS.md', content: 'project instructions' };
    const existing = { path: sharedFile.path.toUpperCase(), content: 'stale' };
    const files = [unrelated, existing];
    injectInstructions(files);
    assert.deepEqual(files, [unrelated, existing]);
    assert.equal(existing.content, sharedFile.content);
    rmSync(sharedFile.path);
    assert.throws(() => readInstructions(), /ENOENT/);
    assert.throws(() => injectInstructions(files), /ENOENT/);
    assert.deepEqual(files, [unrelated, existing]);
  `);
});

for (const mode of ['print', 'json']) {
  test(`missing instructions block ${mode} input and report a failure exit status`, t => {
    const result = run(t, `
      ctx.mode = '${mode}';
      rmSync(join(shared, 'AGENTS.md'));
      assert.deepEqual(handlers.get('input')({}, ctx), { action: 'handled' });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(notifications, []);
    `, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(result.stdout, '');
  });
}

test('TUI/RPC failures block input even if notification fails, without changing process exit status', t => {
  run(t, `
    rmSync(join(shared, 'AGENTS.md'));
    for (const mode of ['tui', 'rpc']) {
      ctx.mode = mode;
      assert.deepEqual(handlers.get('input')({}, ctx), { action: 'handled' });
      assert.equal(notifications.at(-1).level, 'error');
    }
    ctx.ui.notify = () => { throw new Error('UI failed'); };
    assert.deepEqual(handlers.get('input')({}, ctx), { action: 'handled' });
    assert.equal(process.exitCode, undefined);
  `);
});
