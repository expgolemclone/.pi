import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function piPackageRoot(command) {
  if (!['pi', 'pi.cmd', 'pi.ps1'].includes(basename(command))) throw new Error('Expected an official Pi launcher.');
  const root = resolve(dirname(command), '../install');
  const marker = JSON.parse(await readFile(join(root, 'managed-install.json'), 'utf8'));
  if (marker.kind !== 'pi-managed-install' || marker.schemaVersion !== 1 || marker.layout !== 'releases-v1' ||
      marker.entrypoint?.type !== 'script' || typeof marker.entrypoint.path !== 'string' ||
      resolve(marker.entrypoint.path) !== resolve(dirname(command), 'pi.cmd')) {
    throw new Error('Expected an official managed Pi installation.');
  }
  const version = (await readFile(join(root, 'current-version'), 'utf8')).trim();
  if (!/^[0-9A-Za-z._+-]+$/.test(version) || version === '.' || version === '..') {
    throw new Error('Invalid managed Pi current-version.');
  }
  const packageRoot = join(root, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== version) {
    throw new Error('Managed Pi package does not match current-version.');
  }
  await access(join(packageRoot, 'dist/index.js'));
  return packageRoot;
}

export async function activePiPackageRoot() {
  const command = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Command pi -ErrorAction Stop).Source'], { encoding: 'utf8', windowsHide: true }).trim();
  return piPackageRoot(command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(join(await activePiPackageRoot(), 'dist/index.js'));
}
