import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../tools/restore-pi-sessions.ps1', import.meta.url));
const powerShell = execFileSync('mise.exe', ['which', 'pwsh'], { encoding: 'utf8' }).trim();
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const encode = command => Buffer.from(command, 'utf16le').toString('base64');

function fixture(t) {
  const root = resolve(mkdtempSync('C:/dev/tmp/pi-restore-sessions-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  const capture = join(root, 'terminal.jsonl');
  function project(name = 'project') {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  }
  function session(name, cwd, minute) {
    const path = join(sessions, name + '.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: 'session', version: 3, id: name, cwd }) + '\nnot parsed: conversation history\n');
    const modified = new Date(Date.UTC(2026, 0, 1) + minute * 60000);
    utimesSync(path, modified, modified);
    return path;
  }
  function run({ exitCode = 0, env = {} } = {}) {
    const command = `function wt.exe {
      [IO.File]::AppendAllText(${literal(capture)}, (ConvertTo-Json -InputObject @($args) -Compress) + "\n")
      $global:LASTEXITCODE = ${exitCode}
    }
    & ${literal(script)} -SessionDirectory ${literal(sessions)}`;
    const result = spawnSync(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(command)], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env },
    });
    assert.ifError(result.error);
    const calls = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    return { ...result, calls };
  }
  return { root, sessions, project, session, run };
}

function commands(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.calls.length, 1);
  const args = result.calls[0];
  assert.deepEqual(args.slice(0, 2), ['-w', 'new']);
  const decoded = [];
  for (let offset = 2; offset < args.length;) {
    if (offset !== 2) assert.equal(args[offset++], ';');
    assert.deepEqual(args.slice(offset, offset + 6), ['new-tab', powerShell, '-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand']);
    decoded.push(Buffer.from(args[offset + 6], 'base64').toString('utf16le'));
    offset += 7;
  }
  return decoded;
}

function assertSession(command, cwd, path) {
  assert.ok(command.startsWith("$ErrorActionPreference = 'Stop'; "));
  assert.ok(command.includes('Set-Location -LiteralPath ' + literal(cwd) + ';'), command);
  assert.ok(command.endsWith(' exec -- pi --session ' + literal(path)), command);
  assert.ok(!command.includes('--continue'));
}

test('restores exactly the five most recently modified sessions, including two from one directory', t => {
  const f = fixture(t);
  const cwd = f.project();
  const paths = Array.from({ length: 7 }, (_, index) => f.session('group/' + (7 - index), cwd, index));
  const selected = commands(f.run());
  assert.equal(selected.length, 5);
  selected.forEach((command, index) => assertSession(command, cwd, paths[6 - index]));
});

test('skips missing working directories without consuming the five slots', t => {
  const f = fixture(t);
  const cwd = f.project();
  f.session('newest-but-missing', join(f.root, 'deleted-project'), 100);
  const paths = Array.from({ length: 6 }, (_, index) => f.session(String(index), cwd, index));
  const result = f.run();
  const selected = commands(result);
  assert.equal(selected.length, 5);
  selected.forEach((command, index) => assertSession(command, cwd, paths[5 - index]));
  assert.match(result.stdout, /Skipping missing working directory/);
});

test('restores fewer than five sessions without parsing conversation history', t => {
  const f = fixture(t);
  const a = f.project('a');
  const b = f.project('b');
  const older = f.session('older', a, 1);
  const newer = f.session('newer', b, 2);
  const selected = commands(f.run());
  assert.equal(selected.length, 2);
  assertSession(selected[0], b, newer);
  assertSession(selected[1], a, older);
});

test('does not inspect older files once five usable sessions have been selected', t => {
  const f = fixture(t);
  const cwd = f.project();
  const older = f.session('corrupt-old-session', cwd, 0);
  writeFileSync(older, '{invalid');
  utimesSync(older, new Date(0), new Date(0));
  for (let index = 1; index <= 5; index++) f.session(String(index), cwd, index);
  assert.equal(commands(f.run()).length, 5);
});

test('keeps spaces, apostrophes, Unicode, brackets and semicolons inside encoded literals', t => {
  const f = fixture(t);
  const cwd = f.project("person's project [x]; $value 日本語");
  const path = f.session("group with spaces/person's [x]; $value 日本語", cwd, 0);
  const result = f.run();
  const [command] = commands(result);
  assertSession(command, cwd, path);
  assert.ok(result.calls[0].every(argument => !argument.includes(cwd) && !argument.includes(path)));
});

test('breaks equal modification times deterministically by full path', t => {
  const f = fixture(t);
  const cwd = f.project();
  const b = f.session('b', cwd, 1);
  const a = f.session('a', cwd, 1);
  const selected = commands(f.run());
  assertSession(selected[0], cwd, a);
  assertSession(selected[1], cwd, b);
});

test('does not launch Terminal when storage is absent, empty, or has only missing directories', async t => {
  for (const kind of ['absent', 'empty', 'missing-project']) await t.test(kind, t => {
    const f = fixture(t);
    if (kind === 'empty') mkdirSync(f.sessions);
    if (kind === 'missing-project') f.session('missing', join(f.root, 'missing'), 1);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /No (saved|resumable) Pi sessions/);
  });
});

test('fails with the file path instead of silently ignoring an invalid session header', async t => {
  for (const header of ['{invalid', '{}', '{"type":"other","cwd":"C:/dev"}', '{"type":"session","cwd":"relative"}']) {
    await t.test(header, t => {
      const f = fixture(t);
      const path = f.session('invalid', f.project(), 1);
      writeFileSync(path, header);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(path));
      assert.match(result.stderr, /Cannot read Pi session/);
      assert.deepEqual(result.calls, []);
    });
  }
});

test('propagates Terminal failure without retrying the launch', t => {
  const f = fixture(t);
  f.session('session', f.project(), 1);
  const result = f.run({ exitCode: 23 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Windows Terminal failed with exit code 23/);
  assert.equal(result.calls.length, 1);
});

test('requires mise instead of falling back to system PowerShell', t => {
  const f = fixture(t);
  f.session('session', f.project(), 1);
  const result = f.run({ env: { PATH: f.root } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mise.exe/);
  assert.deepEqual(result.calls, []);
});
