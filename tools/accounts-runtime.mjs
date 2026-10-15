import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const manifest = {
  private: true,
  pi: { extensions: ['./runtime/node_modules/@narumitw/pi-accounts/dist/index.ts'] },
};

async function regularDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a regular directory: ${path}`);
}

export async function publishAccountsRuntime(stagedRuntime, agentDirectory) {
  const target = join(resolve(agentDirectory), 'extensions/accounts');
  await mkdir(target, { recursive: true });
  await regularDirectory(target);
  await regularDirectory(stagedRuntime);
  const runtime = join(target, 'runtime');
  const backup = join(dirname(stagedRuntime), 'previous-runtime');
  let previous = false;
  try { await access(runtime); previous = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) { await regularDirectory(runtime); await rename(runtime, backup); }
  try {
    await rename(stagedRuntime, runtime);
    const temporary = join(target, `package-${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    try { await rename(temporary, join(target, 'package.json')); }
    finally { await rm(temporary, { force: true }); }
  } catch (error) {
    await rm(runtime, { recursive: true, force: true });
    if (previous) await rename(backup, runtime);
    throw error;
  }
  // cooldowns.json and recovery.json live outside runtime and are never copied,
  // replaced, parsed or removed by deployment. Credential storage is untouched.
  if (previous) await rm(backup, { recursive: true });
  return target;
}

export async function verifyAccountsRuntime(extensionDirectory, sdkEntry) {
  const sdk = await import(pathToFileURL(resolve(sdkEntry)).href);
  const directory = await mkdtemp(join(tmpdir(), 'pi-accounts-install-check-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { type: 'message', id: 'offline', role: 'assistant', content: [{ type: 'output_text', text: 'pong', annotations: [] }] };
    for (const event of [
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { status: 'completed', output: [item] } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  try {
    const runtime = join(extensionDirectory, 'runtime');
    for (const peer of ['pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-tui']) {
      await assert.rejects(access(join(runtime, 'node_modules/@earendil-works', peer)), { code: 'ENOENT' });
    }
    const makeLoader = (path) => new sdk.DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager: sdk.SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [path],
    });
    const loader = makeLoader(extensionDirectory);
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.ok(loader.getExtensions().extensions[0].commands.has('accounts'));
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const chunks = join(runtime, 'node_modules/@narumitw/pi-accounts/dist/chunks');
    const chunk = (await readdir(chunks)).find((name) => /^quota-probe-.*\.ts$/.test(name));
    assert.ok(chunk, 'Missing built quota-probe boundary');
    const fixture = join(directory, 'probe-fixture.ts');
    const model = {
      id: 'offline', name: 'Offline', api: 'openai-responses', provider: 'openai',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 32,
    };
    await writeFile(fixture, `import {runProbeProcess} from ${JSON.stringify(pathToFileURL(join(chunks, chunk)).href)};\nexport default function(pi){pi.registerCommand('accounts-probe-fixture',{description:'Offline install check',handler:async()=>{await runProbeProcess(${JSON.stringify(model)},{apiKey:'offline-install-fixture'},new AbortController().signal)}})}`);
    const probeLoader = makeLoader(fixture);
    await probeLoader.reload();
    assert.deepEqual(probeLoader.getExtensions().errors, []);
    await probeLoader.getExtensions().extensions[0].commands.get('accounts-probe-fixture').handler('', {});
    return JSON.parse(await readFile(join(runtime, 'source.json'), 'utf8'));
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, path, argument] = process.argv.slice(2);
  if (command === 'verify') {
    const source = await verifyAccountsRuntime(resolve(path), argument);
    console.log(`Verified one accounts extension and its isolated fresh-Pi probe, source ${source.commit}.`);
  } else if (command === 'publish') {
    console.log(await publishAccountsRuntime(resolve(path), argument));
  } else throw new Error('Expected verify <extension-directory> <sdk-entry> or publish <staged-runtime> <agent-directory>.');
}
