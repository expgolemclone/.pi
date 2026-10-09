import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../agent/mcp.json', import.meta.url), 'utf8'));
test('kintone resolves the mapped repository at each process launch without credentials or frozen roots', () => {
  const server = config.mcpServers.kintone;
  assert.deepEqual(Object.keys(config), ['mcpServers']);
  assert.deepEqual(Object.keys(config.mcpServers), ['kintone']);
  assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'timeout']);
  assert.equal(server.command, 'pwsh');
  assert.deepEqual(server.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.match(server.args[4], /Get-LocalRepositoryPath 'kintone-workspace'/);
  assert.match(server.args[4], /envx\/runtimes\/node\/node_modules\/@expgolemclone\/envx-runtime\/cli.mjs/);
  assert.match(server.args[4], /dist\/server\/main.js/);
  assert.equal(server.timeout, 1800);
  assert.doesNotMatch(JSON.stringify(config), /C:[\\/]dev|\.codex|authorization|api[_-]?token|password/i);
});

test('the actual bootstrap follows moved local-only mappings and preserves child exit status', (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-mcp-map-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'fixture home');
  const map = join(home, 'local-repository-map');
  mkdirSync(join(map, 'profiles'), { recursive: true });
  cpSync(join(homedir(), 'local-repository-map/RepositoryMap.psm1'), join(map, 'RepositoryMap.psm1'));
  writeFileSync(join(map, 'profiles.json'), JSON.stringify({ schemaVersion: 1, profiles: { fixture: { computerName: process.env.COMPUTERNAME } } }));
  for (const location of ['first separate location', 'moved again']) {
    const repository = join(root, location, 'kintone-workspace');
    mkdirSync(join(repository, 'dist/server'), { recursive: true });
    writeFileSync(join(repository, 'dist/server/main.js'), 'console.log(JSON.stringify({entry:process.argv[1],cwd:process.cwd()}));');
    writeFileSync(join(map, 'profiles/fixture.json'), JSON.stringify({ schemaVersion: 1, repositories: [{repository:null,path:repository,remote:null}] }));
    const quote = value => value.replaceAll("'", "''");
    const script = "Set-Variable HOME -Force -Value '" + quote(home) + "'; " + config.mcpServers.kintone.args[4];
    const output = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });
    assert.deepEqual(JSON.parse(output), { entry: join(repository, 'dist/server/main.js'), cwd: join(root, location) });
  }
});
