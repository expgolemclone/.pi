import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function accountsRuntimeDirectory(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData || !isAbsolute(localAppData)) throw new Error('An absolute LOCALAPPDATA is required.');
  return join(localAppData, 'envx/runtimes/pi-accounts');
}

export function accountsManifest(extensionDirectory, runtime) {
  return { private: true, pi: { extensions: [relative(extensionDirectory,
    join(runtime, 'node_modules/@expgolemclone/pi-accounts/dist/index.ts')).split(sep).join('/')] } };
}

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function noLinks(path) {
  for (let candidate = resolve(path); ; candidate = dirname(candidate)) {
    if ((await info(candidate))?.isSymbolicLink()) throw new Error(`Accounts deployment link: ${candidate}`);
    if (dirname(candidate) === candidate) return;
  }
}

async function regularDirectory(path) {
  await noLinks(path);
  if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a regular directory: ${path}`);
}

async function replaceFile(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function noManagedAccounts(agentDirectory) {
  const path = join(agentDirectory, 'settings.json');
  await noLinks(path);
  if (!(await info(path))) return;
  const settings = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      (settings.packages !== undefined && !Array.isArray(settings.packages))) throw new Error('Invalid Pi settings.');
  if (settings.packages?.some(entry => /^npm:@(?:narumitw|expgolemclone)\/pi-accounts(?:@[^/]+)?$/.test(typeof entry === 'string' ? entry : entry?.source))) {
    throw new Error('Remove the original accounts package before shared deployment or setup.');
  }
}

export async function checkAccountsDestination(agentDirectory, runtime = accountsRuntimeDirectory()) {
  if (!isAbsolute(runtime)) throw new Error('A shared Accounts destination is required.');
  runtime = resolve(runtime);
  agentDirectory = resolve(agentDirectory);
  for (const [parent, child] of [[agentDirectory, runtime], [runtime, agentDirectory]]) {
    const part = relative(parent, child);
    if (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) {
      throw new Error('Accounts dependencies and agent data directories must be disjoint.');
    }
  }
  await noLinks(runtime);
  await noLinks(join(agentDirectory, 'extensions/accounts/package.json'));
  await noManagedAccounts(agentDirectory);
  return runtime;
}

export async function checkAccountsRuntime(agentDirectory, runtime = accountsRuntimeDirectory()) {
  const target = join(resolve(agentDirectory), 'extensions/accounts');
  await checkAccountsDestination(agentDirectory, runtime);
  await regularDirectory(runtime);
  const path = join(target, 'package.json');
  await noLinks(path);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), accountsManifest(target, runtime), 'Deploy the shared Accounts runtime before setup.');
  const entry = join(runtime, 'node_modules/@expgolemclone/pi-accounts/dist/index.ts');
  await noLinks(entry);
  if (!(await lstat(entry)).isFile()) throw new Error('Shared Accounts entrypoint is not a regular file.');
  return runtime;
}

export async function reuseUnchangedNativeModules(stagedRuntime, runtime) {
  const modules = join(stagedRuntime, 'node_modules');
  await noLinks(modules);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Accounts deployment link: ${path}`);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.node')) continue;
      const installed = join(runtime, relative(stagedRuntime, path));
      await noLinks(installed);
      if (!(await info(installed))?.isFile()) continue;
      const bytes = await readFile(path);
      if (!bytes.equals(await readFile(installed))) continue;
      // Windows can unlink a loaded DLL's old name when an identical package retains another hardlink.
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await link(installed, temporary);
        if (!bytes.equals(await readFile(temporary))) throw new Error('Installed native module changed during deployment.');
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }
  }
  await visit(modules);
}

export async function publishAccountsRuntime(stagedRuntime, agentDirectory, runtime, verify) {
  if (typeof verify !== 'function' || !isAbsolute(runtime)) throw new Error('A shared destination and replacement verifier are required.');
  stagedRuntime = resolve(stagedRuntime);
  runtime = resolve(runtime);
  agentDirectory = resolve(agentDirectory);
  await checkAccountsDestination(agentDirectory, runtime);
  for (const [parent, child] of [[runtime, stagedRuntime], [stagedRuntime, runtime],
    [agentDirectory, stagedRuntime], [stagedRuntime, agentDirectory]]) {
    const part = relative(parent, child);
    if (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) {
      throw new Error('Staged Accounts dependencies, installed runtime and agent data must be disjoint.');
    }
  }
  const target = join(agentDirectory, 'extensions/accounts');
  const manifestPath = join(target, 'package.json');
  const backup = join(dirname(stagedRuntime), 'previous-runtime');
  for (const path of [stagedRuntime, runtime, manifestPath, backup]) await noLinks(path);
  if (await info(backup)) throw new Error('Previous Accounts deployment backup already exists.');
  await regularDirectory(stagedRuntime);
  await noManagedAccounts(agentDirectory);
  const manifestInfo = await info(manifestPath);
  if (manifestInfo && !manifestInfo.isFile()) throw new Error('Accounts discovery manifest is not a regular file.');
  const previousManifest = manifestInfo ? await readFile(manifestPath) : undefined;
  if (process.platform === 'win32') await reuseUnchangedNativeModules(stagedRuntime, runtime);
  await verify(stagedRuntime, join(stagedRuntime, 'node_modules/@expgolemclone/pi-accounts'));
  await noManagedAccounts(agentDirectory);
  for (const path of [stagedRuntime, runtime, manifestPath, backup]) await noLinks(path);
  await regularDirectory(stagedRuntime);
  if (await info(backup)) throw new Error('Accounts deployment backup appeared during verification.');
  const currentManifest = await info(manifestPath) ? await readFile(manifestPath) : undefined;
  if (previousManifest ? !currentManifest?.equals(previousManifest) : currentManifest !== undefined) {
    throw new Error('Accounts discovery changed during staged verification.');
  }
  await mkdir(target, { recursive: true });
  await mkdir(dirname(runtime), { recursive: true });
  const replacementManifest = Buffer.from(`${JSON.stringify(accountsManifest(target, runtime), null, 2)}\n`);
  let previous = false, installed = false, published = false;
  try {
    if (await info(runtime)) { await regularDirectory(runtime); await rename(runtime, backup); previous = true; }
    await rename(stagedRuntime, runtime);
    installed = true;
    await replaceFile(manifestPath, replacementManifest);
    published = true;
    await verify(runtime, target);
    await noLinks(manifestPath);
    if (!(await readFile(manifestPath)).equals(replacementManifest)) throw new Error('Accounts discovery changed during installed verification.');
    await noManagedAccounts(agentDirectory);
  } catch (error) {
    try {
      if (published) {
        await noLinks(manifestPath);
        if (!(await readFile(manifestPath)).equals(replacementManifest)) throw new Error('Discovery changed after publication; automatic rollback would overwrite another author.');
        if (previousManifest) await replaceFile(manifestPath, previousManifest);
        else await rm(manifestPath);
      }
      if (installed) await rm(runtime, { recursive: true });
      if (previous) await rename(backup, runtime);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Accounts deployment and rollback failed; preserve ${backup}.`);
    }
    throw error;
  }
  // Credentials, cooldowns, recovery and settings are data, not deployment outputs.
  // The old repository-local installs are retired separately after acceptance.
  if (previous) await rm(backup, { recursive: true });
  return target;
}

function isolatedEnvironment(directory) {
  const env = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'OS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, HOME: directory, USERPROFILE: directory, LOCALAPPDATA: join(directory, 'local'),
    APPDATA: join(directory, 'roaming'), TEMP: directory, TMP: directory, TMPDIR: directory,
    PI_CODING_AGENT_DIR: join(directory, 'agent'), PI_OFFLINE: '1' };
}

export async function runCliProbe(cli, fixture, directory) {
  await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli,
      '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-mcp', '--no-session', '--no-tools', '--no-approve',
      '-e', fixture, '-p', '/accounts-probe-fixture',
    ], { cwd: directory, env: isolatedEnvironment(directory), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true, detached: process.platform !== 'win32' });
    let ready = false, verified = false, failure, termination;
    const stop = (message) => {
      if (failure) return;
      failure = new Error(message);
      clearTimeout(timer);
      if (!child.pid) return;
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') { failure = new AggregateError([failure, error], 'Cannot stop the owned Accounts probe group.'); child.kill('SIGKILL'); } }
      } else {
        termination = new Promise(done => {
          const helper = spawn(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'],
            { stdio: 'ignore', windowsHide: true, timeout: 2_000, killSignal: 'SIGKILL' });
          helper.on('error', error => { failure = new AggregateError([failure, error], 'Cannot stop the owned Accounts probe tree.'); child.kill(); });
          helper.once('close', code => { if (code !== 0) child.kill(); done(); });
        });
      }
    };
    let timer = setTimeout(() => stop('Accounts CLI did not become ready.'), 30_000);
    child.on('message', value => {
      if (failure) return;
      if (!ready && value?.kind === 'ready') {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => stop('Accounts CLI probe timed out.'), 60_000);
      } else if (ready && !verified && value?.kind === 'pong') verified = true;
      else stop('Accounts CLI probe returned an invalid result.');
    });
    child.on('error', () => stop('Accounts CLI could not be launched.'));
    child.once('close', async code => {
      clearTimeout(timer);
      await termination;
      if (failure || code !== 0 || !verified) reject(failure ?? new Error('Accounts CLI exited without verified pong.'));
      else resolveResult();
    });
  });
}

export async function verifyAccountsRuntime(runtime, sdkEntry, extensionDirectory = join(runtime, 'node_modules/@expgolemclone/pi-accounts')) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-accounts-install-check-'));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, 'agent');
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
    const sdk = await import(pathToFileURL(resolve(sdkEntry)).href);
    for (const peer of ['pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-tui']) {
      await assert.rejects(access(join(runtime, 'node_modules/@earendil-works', peer)), { code: 'ENOENT' });
    }
    const loader = new sdk.DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager: sdk.SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [extensionDirectory],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.ok(loader.getExtensions().extensions[0].commands.has('accounts'));
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const chunks = join(runtime, 'node_modules/@expgolemclone/pi-accounts/dist/chunks');
    const chunk = (await readdir(chunks)).find(name => /^quota-probe-.*\.ts$/.test(name));
    assert.ok(chunk, 'Missing built quota-probe boundary');
    const fixture = join(directory, 'probe-fixture.ts');
    const model = {
      id: 'offline', name: 'Offline', api: 'openai-responses', provider: 'openai',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 32,
    };
    const handle = await open(fixture, 'wx', 0o600);
    try { await handle.writeFile(`import {runProbeProcess} from ${JSON.stringify(pathToFileURL(join(chunks, chunk)).href)};
export default function(pi){
  pi.on('session_start',()=>process.send({kind:'ready'}));
  pi.registerCommand('accounts-probe-fixture',{description:'Offline install check',handler:async()=>{
    try {const result=await runProbeProcess(${JSON.stringify(model)},{apiKey:'offline-install-fixture'},new AbortController().signal);process.send({kind:result},()=>process.disconnect());}
    catch {process.send({kind:'failed'},()=>process.disconnect());}
  }});
}`); } finally { await handle.close(); }
    const hostRoot = sdk.getPackageDir();
    const host = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'));
    await runCliProbe(join(hostRoot, host.bin.pi), fixture, directory);
    assert.equal(requests, 1, 'Expected exactly one isolated loopback probe request');
    const payload = JSON.parse(body);
    assert.equal(payload.tools, undefined);
    assert.match(JSON.stringify(payload.input), /ping/);
    assert.doesNotMatch(body, /AGENTS|PLAN|original conversation|powershell/);
    return JSON.parse(await readFile(join(runtime, 'source.json'), 'utf8'));
  } finally {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, path, argument, sdkEntry] = process.argv.slice(2);
  if (command === 'verify') {
    const source = await verifyAccountsRuntime(resolve(path), argument);
    console.log(`Verified one accounts extension and its isolated fresh-Pi loopback probe, source ${source.commit}.`);
  } else if (command === 'publish') {
    const target = await publishAccountsRuntime(resolve(path), argument, accountsRuntimeDirectory(),
      (runtime, extension) => verifyAccountsRuntime(runtime, sdkEntry, extension));
    console.log(`Verified shared Accounts deployment: ${target}`);
  } else if (command === 'check') {
    console.log(await checkAccountsRuntime(resolve(path)));
  } else if (command === 'destination') {
    console.log(await checkAccountsDestination(resolve(path)));
  } else throw new Error('Expected verify <runtime> <sdk>, publish <staged-runtime> <agent-directory> <sdk>, or check <agent-directory>.');
}
