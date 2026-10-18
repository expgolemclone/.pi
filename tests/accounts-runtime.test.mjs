import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { accountsManifest, accountsRuntimeDirectory, checkAccountsDestination, checkAccountsRuntime, publishAccountsRuntime, reuseUnchangedNativeModules, runCliProbe } from '../tools/accounts-runtime.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-deploy-test-'));
  const agent = join(directory, 'agent');
  const target = join(agent, 'extensions/accounts');
  const runtime = join(directory, 'shared/pi-accounts');
  await mkdir(target, { recursive: true });
  const staged = async (name = 'install') => {
    const path = join(directory, name, 'runtime');
    await mkdir(join(path, 'node_modules/@expgolemclone/pi-accounts/dist'), { recursive: true });
    await writeFile(join(path, 'node_modules/@expgolemclone/pi-accounts/dist/index.ts'), 'export default function(){}');
    await writeFile(join(path, 'marker'), name);
    return path;
  };
  try { await run({ directory, agent, target, runtime, staged }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const accepted = async () => {};

test('shared updates preserve exact credentials, cooldowns, recovery, settings and old local runtime bytes', async () => fixture(async ({ directory, agent, target, runtime, staged }) => {
  const protectedFiles = ['cooldowns.json', 'recovery.json', '../../pi-accounts.json', '../../credentials.json'];
  const settings = Buffer.from('\uFEFF{ "packages": [], "unknown": "keep whitespace and 日本語" }\n');
  await writeFile(join(agent, 'settings.json'), settings);
  await mkdir(join(target, 'runtime'));
  await writeFile(join(target, 'runtime/old'), 'old local runtime, retired only after acceptance');
  for (const path of protectedFiles) await writeFile(join(target, path), `private fixture ${path}\n`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stage = await staged(`install-${attempt}`);
    const calls = [];
    const verify = async (path, extension) => {
      calls.push([path, extension]);
      assert.equal(await readFile(join(path, 'marker'), 'utf8'), `install-${attempt}`);
    };
    assert.equal(await publishAccountsRuntime(stage, agent, runtime, verify), target);
    assert.deepEqual(calls, [[stage, join(stage, 'node_modules/@expgolemclone/pi-accounts')], [runtime, target]]);
    assert.equal(await checkAccountsRuntime(agent, runtime), runtime);
    assert.equal(await readFile(join(runtime, 'marker'), 'utf8'), `install-${attempt}`);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')), accountsManifest(target, runtime));
    for (const path of protectedFiles) assert.equal(await readFile(join(target, path), 'utf8'), `private fixture ${path}\n`);
    assert.deepEqual(await readFile(join(agent, 'settings.json')), settings);
    assert.equal(await readFile(join(target, 'runtime/old'), 'utf8'), 'old local runtime, retired only after acceptance');
    await assert.rejects(access(join(directory, `install-${attempt}/previous-runtime`)), { code: 'ENOENT' });
  }
}));

test('only byte-identical native modules share an inode and survive removal of the old installation', async () => fixture(async ({ runtime, staged }) => {
  const stage = await staged();
  const names = ['native.node', 'changed.node', 'new.node', 'ordinary.js'];
  for (const root of [runtime, stage]) await mkdir(join(root, 'node_modules/native'), { recursive: true });
  for (const name of names) {
    await writeFile(join(stage, 'node_modules/native', name), `new ${name}`);
    if (name !== 'new.node') await writeFile(join(runtime, 'node_modules/native', name),
      name === 'changed.node' ? 'previous binary' : `new ${name}`);
  }
  await reuseUnchangedNativeModules(stage, runtime);
  for (const name of names) {
    const candidate = join(stage, 'node_modules/native', name);
    assert.equal(await readFile(candidate, 'utf8'), `new ${name}`);
    assert.equal((await lstat(candidate)).nlink, name === 'native.node' ? 2 : 1);
    if (name === 'native.node') assert.equal((await lstat(candidate)).ino,
      (await lstat(join(runtime, 'node_modules/native', name))).ino);
  }
  await rm(runtime, { recursive: true });
  assert.equal(await readFile(join(stage, 'node_modules/native/native.node'), 'utf8'), 'new native.node');
  assert.deepEqual((await readdir(join(stage, 'node_modules/native'))).sort(), [...names].sort());
}));

for (const boundary of ['staged', 'installed']) test(`native reuse rejects ${boundary} reparse points without changing targets`, async () => fixture(async ({ directory, runtime, staged }) => {
  const stage = await staged();
  const outside = join(directory, 'native-outside');
  await mkdir(outside);
  await writeFile(join(outside, 'native.node'), 'unchanged native fixture');
  for (const root of [runtime, stage]) await mkdir(join(root, 'node_modules'), { recursive: true });
  const linkedRoot = boundary === 'staged' ? stage : runtime;
  const regularRoot = boundary === 'staged' ? runtime : stage;
  await symlink(outside, join(linkedRoot, 'node_modules/native'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(regularRoot, 'node_modules/native'));
  await writeFile(join(regularRoot, 'node_modules/native/native.node'), 'unchanged native fixture');
  await assert.rejects(reuseUnchangedNativeModules(stage, runtime), /deployment link/);
  assert.equal(await readFile(join(outside, 'native.node'), 'utf8'), 'unchanged native fixture');
  assert.equal((await lstat(join(outside, 'native.node'))).nlink, 1);
}));

test('invalid staged runtime is rejected without changing the existing installation', async () => fixture(async ({ directory, agent, runtime }) => {
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'marker'), 'original');
  const stage = join(directory, 'not-a-directory');
  await writeFile(stage, 'invalid');
  await assert.rejects(publishAccountsRuntime(stage, agent, runtime, accepted), /regular directory/);
  assert.equal(await readFile(join(runtime, 'marker'), 'utf8'), 'original');
}));

for (const failedBoundary of ['stage', 'installed']) test(`failed ${failedBoundary} verification preserves the exact previous manifest and runtime`, async () => fixture(async ({ directory, agent, target, runtime, staged }) => {
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'marker'), 'original');
  const manifest = Buffer.from('\uFEFF{ "private":true, "pi":{"extensions":["./runtime/old.ts"]} }\r\n');
  await writeFile(join(target, 'package.json'), manifest);
  await writeFile(join(target, 'recovery.json'), 'untouched recovery');
  let calls = 0;
  await assert.rejects(publishAccountsRuntime(await staged(), agent, runtime, async () => {
    if (++calls === (failedBoundary === 'stage' ? 1 : 2)) throw new Error('injected verification failure');
  }), /injected verification failure/);
  assert.equal(await readFile(join(runtime, 'marker'), 'utf8'), 'original');
  assert.deepEqual(await readFile(join(target, 'package.json')), manifest);
  assert.equal(await readFile(join(target, 'recovery.json'), 'utf8'), 'untouched recovery');
  await assert.rejects(access(join(directory, 'install/previous-runtime')), { code: 'ENOENT' });
}));

test('failed first deployment removes only its new runtime and discovery file', async () => fixture(async ({ agent, target, runtime, staged }) => {
  await writeFile(join(target, 'recovery.json'), 'unchanged');
  let calls = 0;
  await assert.rejects(publishAccountsRuntime(await staged(), agent, runtime, async () => {
    if (++calls === 2) throw new Error('injected installed failure');
  }), /injected installed failure/);
  await assert.rejects(access(runtime), { code: 'ENOENT' });
  await assert.rejects(access(join(target, 'package.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(target, 'recovery.json'), 'utf8'), 'unchanged');
}));

test('concurrent discovery edits during staged verification are not overwritten', async () => fixture(async ({ agent, target, runtime, staged }) => {
  await writeFile(join(target, 'package.json'), 'original discovery');
  await assert.rejects(publishAccountsRuntime(await staged(), agent, runtime, async () => {
    await writeFile(join(target, 'package.json'), 'concurrent author');
  }), /discovery changed/);
  assert.equal(await readFile(join(target, 'package.json'), 'utf8'), 'concurrent author');
  await assert.rejects(access(runtime), { code: 'ENOENT' });
}));

test('a concurrent discovery edit after publication retains recovery rather than clobbering another author', async () => fixture(async ({ directory, agent, target, runtime, staged }) => {
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'marker'), 'original');
  await writeFile(join(target, 'package.json'), 'original discovery');
  let calls = 0;
  await assert.rejects(publishAccountsRuntime(await staged(), agent, runtime, async () => {
    if (++calls === 2) {
      await writeFile(join(target, 'package.json'), 'concurrent author');
      throw new Error('injected installed failure');
    }
  }), /rollback failed/);
  assert.equal(await readFile(join(target, 'package.json'), 'utf8'), 'concurrent author');
  assert.equal(await readFile(join(directory, 'install/previous-runtime/marker'), 'utf8'), 'original');
  assert.equal(await readFile(join(runtime, 'marker'), 'utf8'), 'install');
}));

test('a successful installed verifier cannot hide concurrent discovery changes', async () => fixture(async ({ directory, agent, target, runtime, staged }) => {
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'marker'), 'previous runtime');
  let calls = 0;
  await assert.rejects(publishAccountsRuntime(await staged(), agent, runtime, async () => {
    if (++calls === 2) await writeFile(join(target, 'package.json'), 'concurrent author');
  }), /rollback failed/);
  assert.equal(await readFile(join(target, 'package.json'), 'utf8'), 'concurrent author');
  assert.equal(await readFile(join(directory, 'install/previous-runtime/marker'), 'utf8'), 'previous runtime');
}));

for (const linkBoundary of ['destination', 'manifest', 'stage']) test(`rejects linked ${linkBoundary} without modifying its target`, async () => fixture(async ({ directory, agent, target, runtime, staged }) => {
  const stage = await staged();
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'marker'), 'untouched');
  if (linkBoundary === 'destination') {
    await mkdir(dirname(runtime), { recursive: true });
    await symlink(outside, runtime, process.platform === 'win32' ? 'junction' : 'dir');
  } else if (linkBoundary === 'manifest') await symlink(process.platform === 'win32' ? outside : join(outside, 'marker'),
    join(target, 'package.json'), process.platform === 'win32' ? 'junction' : 'file');
  else {
    await rm(stage, { recursive: true });
    await symlink(outside, stage, process.platform === 'win32' ? 'junction' : 'dir');
  }
  let verified = false;
  await assert.rejects(publishAccountsRuntime(stage, agent, runtime, async () => { verified = true; }), /deployment link/);
  assert.equal(verified, false);
  assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'untouched');
  assert.deepEqual(await readdir(outside), ['marker']);
}));

test('refuses dependency placement in or around agent data and overlapping stage/runtime paths', async () => fixture(async ({ directory, agent, runtime, staged }) => {
  const stage = await staged();
  for (const invalid of [agent, join(agent, 'runtime'), directory]) {
    await assert.rejects(publishAccountsRuntime(stage, agent, invalid, accepted), /must be disjoint/);
  }
  await assert.rejects(publishAccountsRuntime(stage, agent, stage, accepted), /must be disjoint/);
  await assert.rejects(publishAccountsRuntime(stage, agent, dirname(stage), accepted), /must be disjoint/);
  const protectedPath = join(agent, 'credentials.json');
  await writeFile(protectedPath, 'exact protected fixture');
  for (const invalidStage of [agent, join(agent, 'extensions/accounts')]) {
    await assert.rejects(publishAccountsRuntime(invalidStage, agent, runtime, accepted), /must be disjoint/);
    assert.equal(await readFile(protectedPath, 'utf8'), 'exact protected fixture');
  }
  await assert.rejects(publishAccountsRuntime(stage, agent, runtime), /verifier/);
}));

test('conflicting npm declarations or invalid settings fail before deployment without rewriting settings', async () => fixture(async ({ agent, runtime, staged }) => {
  for (const settings of ['invalid JSON', '{"packages":{}}', '{"packages":["npm:@narumitw/pi-accounts"]}', '{"packages":[{"source":"npm:@narumitw/pi-accounts@0.53.1"}]}', '{"packages":["npm:@expgolemclone/pi-accounts"]}', '{"packages":[{"source":"npm:@expgolemclone/pi-accounts@0.53.1"}]}']) {
    const path = join(agent, 'settings.json');
    await writeFile(path, settings);
    await assert.rejects(publishAccountsRuntime(await staged(`install-${Math.random()}`), agent, runtime, accepted));
    assert.equal(await readFile(path, 'utf8'), settings);
    await assert.rejects(access(runtime), { code: 'ENOENT' });
  }
}));

test('settings and backup ownership are revalidated after staged verification', async () => fixture(async ({ directory, agent, runtime, staged }) => {
  await assert.rejects(publishAccountsRuntime(await staged(), agent, runtime, async () => {
    await mkdir(join(directory, 'install/previous-runtime'));
  }), /backup appeared/);
  await assert.rejects(access(runtime), { code: 'ENOENT' });
  await assert.rejects(publishAccountsRuntime(await staged('next'), agent, runtime, async () => {
    await writeFile(join(agent, 'settings.json'), '{"packages":["npm:@narumitw/pi-accounts"]}');
  }), /Remove the original accounts package/);
  await assert.rejects(access(runtime), { code: 'ENOENT' });
}));

for (const [name, worker, expected] of [
  ['verified pong', "process.send({kind:'ready'}); process.send({kind:'pong'},()=>process.disconnect());", null],
  ['no-op CLI', 'process.disconnect();', /without verified pong/],
  ['failed probe', "process.send({kind:'ready'}); process.send({kind:'failed'},()=>process.disconnect());", /invalid result/],
  ['out-of-order pong', "process.send({kind:'pong'},()=>process.disconnect());", /invalid result/],
  ['nonzero exit after pong', "process.send({kind:'ready'}); process.send({kind:'pong'},()=>{process.disconnect();process.exitCode=1;});", /without verified pong/],
]) test(`deployment CLI verification requires ${name}`, async () => fixture(async ({ directory }) => {
  const cli = join(directory, 'cli.mjs');
  await writeFile(cli, worker);
  const operation = runCliProbe(cli, join(directory, 'unused-fixture.ts'), directory);
  if (expected) await assert.rejects(operation, expected);
  else await operation;
}));

test('a rejected CLI probe drains its owned native descendant before returning', async () => fixture(async ({ directory }) => {
  const cli = join(directory, 'cli.mjs');
  await writeFile(cli, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const helper=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
helper.once('message',()=>{writeFileSync('helper.pid',String(helper.pid));process.send({kind:'failed'});});`);
  await assert.rejects(runCliProbe(cli, 'unused.ts', directory), /invalid result/);
  const pid = Number(await readFile(join(directory, 'helper.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));

test('CLI probe uses synthetic home and strips credential/proxy/preload variables', async () => fixture(async ({ directory }) => {
  const cli = join(directory, 'cli.mjs');
  await writeFile(cli, `import assert from 'node:assert/strict';import {join} from 'node:path';
assert.equal(process.env.HOME,process.cwd());assert.equal(process.env.USERPROFILE,process.cwd());
assert.equal(process.env.PI_CODING_AGENT_DIR,join(process.cwd(),'agent'));
for(const key of ['OPENAI_API_KEY','PI_ACCOUNT','HTTPS_PROXY','NODE_OPTIONS'])assert.equal(process.env[key],undefined);
process.send({kind:'ready'});process.send({kind:'pong'},()=>process.disconnect());`);
  const before = process.env.OPENAI_API_KEY;
  try { process.env.OPENAI_API_KEY = 'synthetic-parent-secret'; await runCliProbe(cli, 'unused.ts', directory); }
  finally { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; }
}));

test('deployment uses synchronized source, native shared workspaces, strict policy and published Kit contracts', async () => {
  const script = await readFile(new URL('../tools/deploy-accounts.ps1', import.meta.url), 'utf8');
  assert.match(script, /Get-LocalRepositoryPath 'expgolemclone\/pi-accounts'/);
  assert.match(script, /Get-LocalRepositoryPath 'expgolemclone\/envx'/);
  assert.match(script, /main@origin/);
  assert.match(script, /--from main --to '@'/);
  assert.match(script, /Invoke-NativeNodeWorkspace -Operation Run/);
  assert.match(script, /'--workspaces', '--include-workspace-root'/);
  assert.match(script, /\$artifacts = Join-Path \$runtime 'artifacts'/);
  assert.doesNotMatch(script, /pi-extensions|check-install-policy/);
  assert.match(script, /--omit=dev', '--legacy-peer-deps'/);
  assert.match(script, /allowScripts = \$policy/);
  assert.match(script, /Copy-Item.*'\.npmrc'/);
  assert.match(script, /publish \$runtime \$AgentDirectory \$sdkEntry/);
  assert.match(script, /previous-runtime/);
  assert.doesNotMatch(script, /npm ci|--ignore-scripts|npm publish|pi remove|npm root --global|@narumitw\/pi-tui-kit/);
  assert.doesNotMatch(script, /Join-Path \$AgentDirectory.*install/);
  const local = resolve('synthetic-local');
  assert.equal(accountsRuntimeDirectory(local), join(local, 'envx/runtimes/pi-accounts'));
  assert.throws(() => accountsRuntimeDirectory('relative'), /absolute LOCALAPPDATA/);
  await assert.rejects(checkAccountsDestination(join(local, 'agent'), join(local, 'agent/runtime')), /disjoint/);
});
