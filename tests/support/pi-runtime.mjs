import { execFileSync } from 'node:child_process';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const installation = execFileSync('mise.exe', ['where', 'npm:@earendil-works/pi-coding-agent'], { encoding: 'utf8' }).trim();
const manifest = findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(join(installation, 'package.json')));
export const sdk = await import(pathToFileURL(join(dirname(manifest), 'dist/index.js')));
export const packageRoot = sdk.getPackageDir();
export const aiRoot = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(packageRoot, 'dist/index.js'))));
