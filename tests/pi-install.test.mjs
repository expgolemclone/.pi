import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { piPackageRoot } from '../tools/pi-install.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-managed-sdk-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'install');
  const bin = join(directory, 'bin');
  await mkdir(root);
  await mkdir(bin);
  const marker = {
    kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1',
    entrypoint: { type: 'script', path: join(bin, 'pi.cmd') },
  };
  const mark = value => writeFile(join(root, 'managed-install.json'), JSON.stringify(value));
  const select = value => writeFile(join(root, 'current-version'), `${value}\r\n`);
  const release = async version => {
    const path = join(root, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent');
    await mkdir(join(path, 'dist'), { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
    await writeFile(join(path, 'dist/index.js'), 'export {};\n');
    return path;
  };
  await mark(marker);
  await select('1.3.0');
  return { root, bin, marker, mark, select, release, command: join(bin, 'pi.ps1') };
}

test('SDK selection follows the official current-version for every launcher', async t => {
  const f = await fixture(t);
  const initial = await f.release('1.3.0');
  for (const name of ['pi', 'pi.cmd', 'pi.ps1']) assert.equal(await piPackageRoot(join(f.bin, name)), initial);
  const next = await f.release('1.4.0');
  await f.select('1.4.0');
  assert.equal(await piPackageRoot(f.command), next);
});

for (const update of [
  { kind: 'unrecognized' }, { schemaVersion: 2 }, { layout: 'unknown' },
  { entrypoint: { type: 'script', path: 'elsewhere/pi.cmd' } }, { entrypoint: { type: 'script' } },
]) test(`rejects unsupported managed metadata ${JSON.stringify(update)}`, async t => {
  const f = await fixture(t);
  await f.mark({ ...f.marker, ...update });
  await assert.rejects(piPackageRoot(f.command), /official managed Pi/);
});

for (const version of ['', '.', '..', '../other', 'a/b', 'a\\b']) {
  test(`rejects unsafe current-version ${JSON.stringify(version)}`, async t => {
    const f = await fixture(t);
    await f.select(version);
    await assert.rejects(piPackageRoot(f.command), /Invalid managed Pi current-version/);
  });
}

test('legacy npm commands cannot silently use an unrelated SDK', async t => {
  const f = await fixture(t);
  await assert.rejects(piPackageRoot(join(f.bin, 'node.exe')), /official Pi launcher/);
  await rm(join(f.root, 'managed-install.json'));
  await assert.rejects(piPackageRoot(f.command), { code: 'ENOENT' });
});

test('selected release must contain the matching package and SDK', async t => {
  const f = await fixture(t);
  const root = await f.release('1.3.0');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.2.0' }));
  await assert.rejects(piPackageRoot(f.command), /does not match/);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0' }));
  await rm(join(root, 'dist/index.js'));
  await assert.rejects(piPackageRoot(f.command), { code: 'ENOENT' });
});
