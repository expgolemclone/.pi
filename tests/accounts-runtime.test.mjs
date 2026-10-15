import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { manifest, publishAccountsRuntime } from '../tools/accounts-runtime.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-deploy-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('runtime updates preserve exact cooldown, recovery, credential and settings bytes', async () => fixture(async (directory) => {
  const agent = join(directory, 'agent');
  const target = join(agent, 'extensions/accounts');
  const protectedFiles = ['cooldowns.json', 'recovery.json', '../../pi-accounts.json', '../../settings.json'];
  await mkdir(join(target, 'runtime'), { recursive: true });
  await writeFile(join(target, 'runtime/old'), 'previous runtime');
  for (const path of protectedFiles) await writeFile(join(target, path), `private fixture ${path}\n`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stage = join(directory, `install-${attempt}/runtime`);
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, 'built-entry'), `runtime ${attempt}`);
    assert.equal(await publishAccountsRuntime(stage, agent), target);
    assert.equal(await readFile(join(target, 'runtime/built-entry'), 'utf8'), `runtime ${attempt}`);
    for (const path of protectedFiles) assert.equal(await readFile(join(target, path), 'utf8'), `private fixture ${path}\n`);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')), manifest);
    await assert.rejects(access(join(directory, `install-${attempt}/previous-runtime`)), { code: 'ENOENT' });
  }
  await assert.rejects(access(join(target, 'runtime/old')), { code: 'ENOENT' });
}));

test('invalid staged runtime is rejected without touching an existing installation', async () => fixture(async (directory) => {
  const agent = join(directory, 'agent');
  const runtime = join(agent, 'extensions/accounts/runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'entry'), 'original');
  const stage = join(directory, 'not-a-directory');
  await writeFile(stage, 'invalid');
  await assert.rejects(publishAccountsRuntime(stage, agent), /regular directory/);
  assert.equal(await readFile(join(runtime, 'entry'), 'utf8'), 'original');
}));

test('failed manifest publication restores the previous runtime without touching state', async () => fixture(async (directory) => {
  const agent = join(directory, 'agent');
  const target = join(agent, 'extensions/accounts');
  await mkdir(join(target, 'runtime'), { recursive: true });
  await mkdir(join(target, 'package.json')); // Deliberate atomic-rename failure.
  await writeFile(join(target, 'runtime/entry'), 'original');
  await writeFile(join(target, 'cooldowns.json'), 'untouched');
  const staged = join(directory, 'install/runtime');
  await mkdir(staged, { recursive: true });
  await writeFile(join(staged, 'entry'), 'replacement');
  await assert.rejects(publishAccountsRuntime(staged, agent));
  assert.equal(await readFile(join(target, 'runtime/entry'), 'utf8'), 'original');
  assert.equal(await readFile(join(target, 'cooldowns.json'), 'utf8'), 'untouched');
}));

test('deployment owns only the synchronized accounts fork and production dependencies', async () => {
  const script = await readFile(new URL('../tools/deploy-accounts.ps1', import.meta.url), 'utf8');
  assert.match(script, /Get-LocalRepositoryPath 'expgolemclone\/pi-extensions'/);
  assert.match(script, /main@origin/);
  assert.match(script, /--from main --to '@'/);
  assert.match(script, /--omit=peer --ignore-scripts/);
  assert.match(script, /pi remove 'npm:@narumitw\/pi-accounts'/);
  assert.ok(script.indexOf('verify $stage') < script.indexOf("pi remove 'npm:@narumitw/pi-accounts'"));
  assert.ok(script.indexOf("pi remove 'npm:@narumitw/pi-accounts'") < script.indexOf('publish $runtime'));
  assert.doesNotMatch(script, /npm publish|pi-accounts\.json.*(?:Set-Content|Remove-Item)/);
});
