import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const deployment = fileURLToPath(new URL('../tools/deploy-accounts.ps1', import.meta.url));
const harness = String.raw`
param([string]$Script, [string]$Source, [string]$Agent, [string]$Directory, [string]$Failure)
$ErrorActionPreference = 'Stop'
$global:Calls = [Collections.Generic.List[object]]::new()
$global:Published = $null
$global:Runtime = $null
$global:Shared = Join-Path $Directory 'installed/pi-accounts'
function Import-Module { throw 'Deployment must not import source-workflow helpers.' }
function jj { throw 'Deployment must not manage source revisions.' }
function git { throw 'Deployment must not manage source revisions.' }
function npm {
    $global:Calls.Add(@{ arguments = @($args); cwd = (Get-Location).Path })
    $operation = $args[0]
    $global:LASTEXITCODE = 0
    if ($operation -eq $Failure) { $global:LASTEXITCODE = 7; return }
    if ($operation -eq 'pack') {
        $destination = $args[[Array]::IndexOf($args, '--pack-destination') + 1]
        [IO.File]::WriteAllText((Join-Path $destination 'accounts.tgz'), 'synthetic archive')
        if ($Failure -ne 'archives') {
            [IO.File]::WriteAllText((Join-Path $destination 'private-files.tgz'), 'synthetic archive')
        }
    }
}
function node {
    $global:LASTEXITCODE = 0
    if ($args[0] -like '*pi-install.mjs') { return 'synthetic-sdk-entry' }
    if ($args[0] -notlike '*accounts-runtime.mjs') { throw 'Unexpected Node entry point.' }
    if ($args[1] -eq 'destination') { return $global:Shared }
    if ($args[1] -ne 'publish' -or $args[3] -ne $Agent -or $args[4] -ne 'synthetic-sdk-entry') {
        throw 'Unexpected publication arguments.'
    }
    $global:Runtime = $args[2]
    $global:Published = @{
        source = ([IO.File]::ReadAllText((Join-Path $global:Runtime 'source.json')) | ConvertFrom-Json)
        manifest = ([IO.File]::ReadAllText((Join-Path $global:Runtime 'package.json')) | ConvertFrom-Json)
        npmrc = [IO.File]::ReadAllText((Join-Path $global:Runtime '.npmrc'))
    }
    if ($Failure -eq 'recovery') {
        [void][IO.Directory]::CreateDirectory((Join-Path (Split-Path $global:Runtime -Parent) 'previous-runtime'))
    }
    if ($Failure -in @('publish', 'recovery')) { $global:LASTEXITCODE = 7 }
}
try { & $Script -Source $Source -AgentDirectory $Agent }
finally {
    @{ calls = @($global:Calls.ToArray()); published = $global:Published; runtime = $global:Runtime } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Directory 'result.json')
}
`;

for (const failure of ['', 'ci', 'pack', 'archives', 'install', 'publish', 'recovery']) {
  test(`actual deployment entry point: ${failure || 'success'} uses caller source without workflow helpers`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'accounts-entry-'));
    const source = join(directory, "selected account's workspace"), agent = join(directory, 'agent');
    let passed = false;
    try {
      await mkdir(source); await mkdir(agent);
      await writeFile(join(source, 'package.json'), JSON.stringify({
        name: '@expgolemclone/pi-accounts', version: 'fixture-version', allowScripts: { esbuild: true },
      }));
      await writeFile(join(source, '.npmrc'), 'strict-allow-scripts=true\n');
      await writeFile(join(agent, 'credentials.json'), 'private synthetic fixture');
      const script = join(directory, 'invoke.ps1');
      await writeFile(script, harness);
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, deployment, source, agent, directory, failure], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
      });
      await writeFile(join(directory, 'process.json'), JSON.stringify({ status: result.status,
        error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
      assert.ifError(result.error);
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      const state = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
      assert(state.calls.length > 0);
      assert.equal(state.calls[0].arguments[0], 'ci');
      assert(state.calls.every(call => !call.arguments.includes('test')));
      assert(state.calls.filter(call => ['ci', 'pack'].includes(call.arguments[0])).every(call => call.cwd === source));
      if (state.published) {
        assert.deepEqual(state.published.source, { repository: 'https://github.com/expgolemclone/pi-accounts', version: 'fixture-version' });
        assert.deepEqual(state.published.manifest.allowScripts, { esbuild: true });
        assert.equal(state.published.npmrc, 'strict-allow-scripts=true\n');
        const install = state.calls.find(call => call.arguments[0] === 'install').arguments;
        assert(install.includes('--omit=dev') && install.includes('--legacy-peer-deps'));
        assert.equal(install.filter(argument => argument.endsWith('.tgz')).length, 2);
      }
      const stages = await readdir(join(directory, 'installed'));
      assert.equal(stages.length, failure === 'recovery' ? 1 : 0);
      if (failure === 'recovery') assert.deepEqual(await readdir(join(directory, 'installed', stages[0])), ['previous-runtime', 'runtime']);
      assert.equal(await readFile(join(agent, 'credentials.json'), 'utf8'), 'private synthetic fixture');
      passed = true;
    } finally {
      if (passed) await rm(directory, { recursive: true, force: true });
      else console.error(`Failed deployment fixture retained at ${directory}`);
    }
  });
}
