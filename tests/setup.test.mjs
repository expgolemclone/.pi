import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import notifier, { notificationCommand } from '../agent/extensions/notify.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmRoot = execFileSync('pwsh', ['-NoProfile', '-Command', 'npm root --global'], { encoding: 'utf8' }).trim();
const packageRoot = join(npmRoot, '@earendil-works/pi-coding-agent');
const planPath = join(packageRoot, 'examples/extensions/plan-mode/index.ts');
const oldNotifyPath = join(packageRoot, 'examples/extensions/notify.ts');
const notifyPath = join(root, 'agent/extensions/notify.ts');
const soundPath = join(root, 'agent/sounds/ready.wav');
// Exercise setup in an isolated home, never in the live user configuration.
mkdirSync('C:/dev/tmp', { recursive: true });
const home = mkdtempSync('C:/dev/tmp/pi-setup-test-');
after(() => rmSync(home, { recursive: true, force: true }));
const setupRoot = join(home, '.pi');
mkdirSync(join(setupRoot, 'agent'), { recursive: true });
for (const path of ['setup.ps1', 'tools', 'agent/extensions', 'agent/mcp.json', 'agent/COMPACTION.md']) {
  cpSync(join(root, path), join(setupRoot, path), { recursive: true });
}
mkdirSync(join(home, '.agents/skills'), { recursive: true });
writeFileSync(join(home, '.agents/settings.json'), '{}');
writeFileSync(join(home, '.agents/AGENTS.md'), '# Test instructions\n');
const mapRoot = join(home, 'local-repository-map');
mkdirSync(join(mapRoot, 'profiles'), { recursive: true });
cpSync(join(homedir(), 'local-repository-map/RepositoryMap.psm1'), join(mapRoot, 'RepositoryMap.psm1'));
writeFileSync(join(mapRoot, 'profiles.json'), JSON.stringify({
  schemaVersion: 1, profiles: {
    company: { computerName: 'J250059A' },
    nucbox: { computerName: 'NUCBOX_K8_PLUS' },
  },
}));
const envxSkills = new Map();
for (const profile of ['company', 'nucbox']) {
  const envxRoot = join(home, profile, 'envx');
  const skill = join(envxRoot, 'skills/envx');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: envx\ndescription: Manage scoped environment variables.\n---\n');
  writeFileSync(join(mapRoot, `profiles/${profile}.json`), JSON.stringify({
    schemaVersion: 1, repositories: [{
      repository: 'expgolemclone/envx', path: envxRoot, remote: 'https://github.com/expgolemclone/envx.git',
    }],
  }));
  envxSkills.set(profile, skill);
}
const settingsPath = join(setupRoot, 'agent/settings.json');
writeFileSync(settingsPath, JSON.stringify({ extensions: [], defaultProjectTrust: 'never', lastChangelogVersion: 'test-metadata' }));
const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
const setup = (computer = 'J250059A') => execFileSync('pwsh', ['-NoProfile', '-File', join(setupRoot, 'setup.ps1')], {
  encoding: 'utf8', env: { ...process.env, USERPROFILE: home, COMPUTERNAME: computer },
});
const setupSoundPath = join(setupRoot, 'agent/sounds/ready.wav');

test('setup retires official plan mode and notifiers, generates one sound, and preserves runtime metadata', () => {
  const before = readSettings();
  const legacyRoot = 'C:/old/npm/@earendil-works/pi-coding-agent/examples/extensions';
  const legacy = [
    oldNotifyPath, `+${legacyRoot}/notify.ts`, planPath,
    `+${legacyRoot}/plan-mode/index.ts`, `${legacyRoot}/plan-mode/index.js`,
    `${legacyRoot}/plan-mode`, `${legacyRoot}/plan-mode/`,
    `${legacyRoot}/plan-mode/index.ts`.replaceAll('/', '\\'),
  ];
  writeFileSync(settingsPath, JSON.stringify({ ...before, extensions: [...(before.extensions ?? []), ...legacy] }));
  setup();
  const first = readSettings();
  assert.equal(first.defaultProjectTrust, 'always');
  const firstSound = readFileSync(setupSoundPath);
  setup();
  assert.deepEqual(readFileSync(join(setupRoot, 'agent/mcp.json')), readFileSync(join(root, 'agent/mcp.json')));
  assert.deepEqual(readSettings(), first);
  assert.deepEqual(readFileSync(setupSoundPath), firstSound);
  assert.ok(first.extensions.every((entry) => !legacy.includes(entry)));
  assert.deepEqual(first.extensions, [...new Set((before.extensions ?? []).filter((entry) =>
    !/\/examples\/extensions\/(notify\.ts|plan-mode(?:\/index\.(?:ts|js))?)\/?$/.test(entry.replaceAll('\\', '/'))
  ))]);
  assert.ok(first.extensions.every((entry) => !entry.replaceAll('\\', '/').endsWith('/examples/extensions/notify.ts')));
  assert.ok(!first.extensions.includes(notifyPath)); // loaded by discovery, not configured twice
  assert.equal(existsSync(join(setupRoot, 'agent/sounds/candidates')), false);
  for (const [key, value] of Object.entries(before)) {
    if (!['extensions', 'skills', 'defaultTools', 'defaultProjectTrust', 'defaultProvider', 'defaultModel', 'defaultThinkingLevel'].includes(key)) {
      assert.deepEqual(first[key], value);
    }
  }
});

test('setup supports absent or empty extension lists and preserves unrelated entries', () => {
  const before = readSettings();
  try {
    for (const extensions of [undefined, [], ['-builtin:mcp']]) {
      const settings = { ...before, extensions };
      writeFileSync(settingsPath, JSON.stringify(settings));
      setup();
      assert.deepEqual(readSettings().extensions, extensions ?? []);
    }
  } finally {
    writeFileSync(settingsPath, JSON.stringify(before, null, 2));
  }
});

test('setup references one canonical envx skill on each PC and preserves other selections', async () => {
  const before = readSettings();
  const { loadSkillsFromDir } = await import(pathToFileURL(join(packageRoot, 'dist/core/skills.js')).href);
  try {
    for (const [profile, computer] of [['company', 'J250059A'], ['nucbox', 'NUCBOX_K8_PLUS']]) {
      const skill = envxSkills.get(profile);
      writeFileSync(settingsPath, JSON.stringify({ ...before, skills: ['./custom-skills', 'Z:/retired envx/skills/envx', 'Y:\\moved\\skills\\envx\\SKILL.md', skill, skill] }));
      setup(computer);
      assert.deepEqual(readSettings().skills, ['./custom-skills', skill]);
      const found = loadSkillsFromDir({ dir: skill, source: 'user' });
      assert.deepEqual(found.diagnostics, []);
      assert.deepEqual(found.skills.map(({ name }) => name), ['envx']);
      setup(computer);
      assert.deepEqual(readSettings().skills, ['./custom-skills', skill]);
    }
  } finally {
    writeFileSync(settingsPath, JSON.stringify(before));
  }
});

test('setup rejects missing envx mappings or skills without changing settings', () => {
  const mapPath = join(mapRoot, 'profiles/company.json');
  const beforeMap = readFileSync(mapPath);
  const beforeSettings = readFileSync(settingsPath);
  const skillFile = join(envxSkills.get('company'), 'SKILL.md');
  const beforeSkill = readFileSync(skillFile);
  const rejectSetup = (computer, pattern) => {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', join(setupRoot, 'setup.ps1')], {
      encoding: 'utf8', env: { ...process.env, USERPROFILE: home, COMPUTERNAME: computer },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
  };
  try {
    writeFileSync(mapPath, JSON.stringify({ schemaVersion: 1, repositories: [] }));
    rejectSetup('J250059A', /Exactly one mapped repository is required/);
    assert.deepEqual(readFileSync(settingsPath), beforeSettings);
    writeFileSync(mapPath, beforeMap);
    rmSync(skillFile);
    rejectSetup('J250059A', /Mapped envx skill is missing/);
    assert.deepEqual(readFileSync(settingsPath), beforeSettings);
    rejectSetup('UNKNOWN_PC', /No repository profile is bound/);
    assert.deepEqual(readFileSync(settingsPath), beforeSettings);
  } finally {
    writeFileSync(mapPath, beforeMap);
    writeFileSync(skillFile, beforeSkill);
  }
});

test('Pi discovers the local notifier once without official plan mode or notifier capabilities', async () => {
  const { discoverAndLoadExtensions } = await import(pathToFileURL(join(packageRoot, 'dist/core/extensions/loader.js')).href);
  const result = await discoverAndLoadExtensions(readSettings().extensions, setupRoot, join(setupRoot, 'agent'));
  assert.deepEqual(result.errors, []);
  const notifications = result.extensions.filter(({ path }) => path === join(setupRoot, 'agent/extensions/notify.ts'));
  assert.equal(notifications.length, 1);
  assert.deepEqual([...notifications[0].handlers.keys()], ['agent_settled']);
  const compactions = result.extensions.filter(({ path }) => path === join(setupRoot, 'agent/extensions/custom-compaction.ts'));
  assert.equal(compactions.length, 1);
  assert.deepEqual([...compactions[0].handlers.keys()], ['session_before_compact']);
  assert.equal(readFileSync(join(setupRoot, 'agent/COMPACTION.md'), 'utf8'), readFileSync(join(root, 'agent/COMPACTION.md'), 'utf8'));
  assert.ok(result.extensions.every(({ path }) => path !== oldNotifyPath && path !== planPath));
  for (const extension of result.extensions) {
    assert.ok(!extension.commands.has('plan'));
    assert.ok(!extension.commands.has('todos'));
    assert.ok(!extension.flags.has('plan'));
    assert.ok(!extension.shortcuts.has('ctrl+alt+p'));
  }
});

function register(exec) {
  const handlers = new Map();
  notifier({ on: (event, handler) => handlers.set(event, handler), exec });
  assert.deepEqual([...handlers.keys()], ['agent_settled']);
  return handlers.get('agent_settled');
}

test('notifier executes once at settlement only in interactive mode', async (t) => {
  const exec = t.mock.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }));
  const settled = register(exec);
  assert.equal(exec.mock.callCount(), 0); // no side effects while loading
  for (const mode of ['print', 'json', 'rpc']) {
    await settled({ type: 'agent_settled' }, { mode });
  }
  assert.equal(exec.mock.callCount(), 0);
  await settled({ type: 'agent_settled' }, { mode: 'tui' });
  assert.equal(exec.mock.callCount(), 1);
  const [command, args, options] = exec.mock.calls[0].arguments;
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(script.includes(`$SoundPath = '${soundPath}'`));
  assert.doesNotMatch(script, /Set-ExecutionPolicy|Bypass/i);
  assert.ok(!args.includes('-ExecutionPolicy'));
  assert.ok(!args.includes('-File'));
  assert.deepEqual(options, { timeout: 10000 });
});

test('notification failures are visible and never invoke a fallback sound', async (t) => {
  for (const failure of [{ code: 1, killed: false }, { code: 0, killed: true }]) {
    const exec = t.mock.fn(async () => ({ ...failure, stderr: 'test failure', stdout: '' }));
    await assert.rejects(register(exec)({}, { mode: 'tui' }), /Pi notification failed.*test failure/);
    assert.equal(exec.mock.callCount(), 1);
  }
});

test('Windows command silences toast audio, explicitly loads WAV, and plays once', () => {
  const { args } = notificationCommand();
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.match(script, /<audio silent="true"\s*\/>/);
  assert.match(script, /\$xml\.LoadXml\(/);
  assert.doesNotMatch(script, /AppendChild|GetElementsByTagName|SystemSounds/);
  assert.ok(script.indexOf('$player.Load()') < script.indexOf('$player.PlaySync()'));
  assert.equal(script.match(/\.PlaySync\(/g).length, 1);
  assert.equal(script.match(/\.Show\(/g).length, 1);
  assert.match(script, /finally\s*\{\s*\$player\.Dispose\(\)/);
});

test('command encoding preserves apostrophes and Unicode in the audio path', () => {
  const path = "C:\\音\\O'Brien\\ready.wav";
  const { args } = notificationCommand(path);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(script.includes(`$SoundPath = '${path.replaceAll("'", "''")}'`));
});

test('real notification plays under Restricted without a .ps1 or policy relaxation', async (t) => {
  // Make the child stricter than the harness (which may inherit Process=Bypass).
  // Prove that files are blocked rather than relying on Get-ExecutionPolicy's
  // module autoload (PowerShell 7's inherited module path can break it in 5.1).
  // No persistent user/machine policy is changed.
  mkdirSync('C:/dev/tmp', { recursive: true });
  const directory = mkdtempSync('C:/dev/tmp/pi-notify-policy-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'blocked.ps1');
  writeFileSync(file, "Write-Output 'This script must not execute'\n");
  const blocked = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-File', file,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(blocked.error);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /running scripts is disabled/i);
  const settled = register(async (command, args, options) => {
    assert.ok(!args.includes('-File'));
    assert.ok(!args.includes('-ExecutionPolicy'));
    const stdout = execFileSync(command, ['-ExecutionPolicy', 'Restricted', ...args], { ...options, encoding: 'utf8' });
    return { code: 0, killed: false, stdout, stderr: '' };
  });
  await settled({ type: 'agent_settled' }, { mode: 'tui' });
});
