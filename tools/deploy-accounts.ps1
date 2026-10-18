[CmdletBinding()]
param([string]$AgentDirectory = (Join-Path $HOME '.pi/agent'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $HOME 'local-repository-map/repository-map.psm1') -Force
Import-Module (Join-Path (Get-LocalRepositoryPath 'expgolemclone/.agents') 'workflow/agent-workflow.psm1')
Import-Module (Join-Path (Get-LocalRepositoryPath 'expgolemclone/envx') 'runtimes/native-node-workspace.psm1')
$repository = Get-LocalRepositoryPath 'expgolemclone/pi-accounts'
$AgentDirectory = [IO.Path]::GetFullPath($AgentDirectory)
Get-Command node -ErrorAction Stop | Out-Null
$sdkEntry = (& node (Join-Path $PSScriptRoot 'pi-install.mjs')).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the active managed Pi SDK.' }
$shared = (& node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') destination $AgentDirectory).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Accounts shared destination validation failed.' }

Invoke-AgentRepositoryLock -RepositoryPath $repository -Action {
    $remote = (& jj --repository $repository git remote list) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $remote -notmatch '^origin https://github\.com/expgolemclone/pi-accounts(?:\.git)?$') {
        throw 'Accounts must be built from the registered expgolemclone/pi-accounts repository.'
    }
    $commit = (& jj --repository $repository log -r main --no-graph -T commit_id).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve synchronized accounts source.' }
    $remoteCommit = (& jj --repository $repository log -r 'main@origin' --no-graph -T commit_id).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -ne $remoteCommit) { throw 'Synchronize Accounts main before deployment.' }
    $changes = & jj --repository $repository diff --summary --from main --to '@'
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'The registered Accounts repository must match synchronized main before deployment.' }
    Invoke-AgentRepositoryLock -RepositoryPath $shared -Action {
        & node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') destination $AgentDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Accounts destination changed before deployment.' }
        $stage = Join-Path (Split-Path $shared -Parent) ('.pi-accounts-install-' + [guid]::NewGuid().ToString('N'))
        $runtime = Join-Path $stage 'runtime'
        $artifacts = Join-Path $runtime 'artifacts'
        New-Item -ItemType Directory -Path $artifacts | Out-Null
        try {
            Invoke-NativeNodeWorkspace -Operation Run -Source $repository -Command @('npm', 'run', 'build')
            Invoke-NativeNodeWorkspace -Operation Run -Source $repository -Command @(
                'npm', 'pack', '--workspaces', '--include-workspace-root', '--pack-destination', $artifacts
            )
            $archives = @(Get-ChildItem -LiteralPath $artifacts -Filter '*.tgz' | ForEach-Object FullName)
            if ($archives.Count -ne 2) { throw 'Expected Accounts and private-files archives, with Kit resolved through its published contract.' }
            $policy = ([IO.File]::ReadAllText((Join-Path $repository 'package.json')) | ConvertFrom-Json -AsHashtable).allowScripts
            @{ name = 'envx-pi-accounts'; private = $true; type = 'module'; allowScripts = $policy } |
                ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runtime 'package.json') -Encoding utf8
            Copy-Item -LiteralPath (Join-Path $repository '.npmrc') -Destination (Join-Path $runtime '.npmrc')
            Invoke-NativeNodeWorkspace -Operation Run -Source $repository -Command (@(
                'npm', 'install', '--prefix', $runtime, '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund'
            ) + $archives)
            @{ repository = 'https://github.com/expgolemclone/pi-accounts'; commit = $commit } |
                ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'source.json') -Encoding utf8
            & node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') publish $runtime $AgentDirectory $sdkEntry
            if ($LASTEXITCODE -ne 0) { throw 'Shared Accounts publication or offline replacement verification failed.' }
            Write-Output "Installed shared Accounts from $commit. Credentials, settings and recovery records were preserved. Run /reload when convenient."
        } finally {
            # A failed rollback retains the previous runtime for recovery, never deletes it as staging debris.
            if (Test-Path -LiteralPath (Join-Path $stage 'previous-runtime')) {
                Write-Warning "Accounts recovery runtime retained at $stage."
            } else { Remove-Item -LiteralPath $stage -Recurse -Force }
        }
    }
}
