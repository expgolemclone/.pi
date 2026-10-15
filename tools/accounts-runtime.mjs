import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

export async function runCliProbe(cli, fixture, directory) {
  const env = { PI_CODING_AGENT_DIR: join(directory, 'agent'), PI_OFFLINE: '1' };
  for (const name of ['PATH', 'SystemRoot', 'USERPROFILE', 'HOME', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli,
      '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-mcp', '--no-session', '--no-tools', '--no-approve',
      '-e', fixture, '-p', '/accounts-probe-fixture',
    ], { cwd: directory, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let ready = false, verified = false, failure;
    const stop = (message) => { failure ??= new Error(message); child.kill(); };
    let timer = setTimeout(() => stop('Accounts CLI did not become ready.'), 30_000);
    child.on('message', value => {
      if (!ready && value?.kind === 'ready') {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => stop('Accounts CLI probe timed out.'), 60_000);
      } else if (ready && !verified && value?.kind === 'pong') verified = true;
      else stop('Accounts CLI probe returned an invalid result.');
    });
    child.on('error', () => stop('Accounts CLI could not be launched.'));
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || !verified) reject(failure ?? new Error('Accounts CLI exited without verified pong.'));
      else resolveResult();
    });
  });
}

export async function verifyAccountsRuntime(extensionDirectory, sdkEntry) {
  const sdk = await import(pathToFileURL(resolve(sdkEntry)).href);
  const directory = await mkdtemp(join(tmpdir(), 'pi-accounts-install-check-'));
  let requests = 0, body = '';
  const server = createServer((request, response) => {
    requests++;
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const item = { type: 'message', id: 'offline', role: 'assistant', content: [{ type: 'output_text', text: 'pong', annotations: [] }] };
      for (const event of [
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { status: 'completed', output: [item] } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
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
    await writeFile(fixture, `import {runProbeProcess} from ${JSON.stringify(pathToFileURL(join(chunks, chunk)).href)};
export default function(pi){
  pi.on('session_start',()=>process.send({kind:'ready'}));
  pi.registerCommand('accounts-probe-fixture',{description:'Offline install check',handler:async()=>{
    try {const result=await runProbeProcess(${JSON.stringify(model)},{apiKey:'offline-install-fixture'},new AbortController().signal);process.send({kind:result},()=>process.disconnect());}
    catch {process.send({kind:'failed'},()=>process.disconnect());}
  }});
}`);
    // The SDK loader above checks registration, but uses aliases. The shipped CLI
    // uses virtual modules and must exercise the lazy probe too, without peer copies.
    const hostRoot = sdk.getPackageDir();
    const host = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'));
    await runCliProbe(join(hostRoot, host.bin.pi), fixture, directory);
    assert.equal(requests, 1, 'Expected exactly one isolated probe request');
    const payload = JSON.parse(body);
    assert.equal(payload.tools, undefined);
    assert.match(JSON.stringify(payload.input), /ping/);
    assert.doesNotMatch(body, /AGENTS|PLAN|original conversation|powershell/);
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
