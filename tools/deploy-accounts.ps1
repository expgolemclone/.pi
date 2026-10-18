[CmdletBinding()]
param([string]$AgentDirectory = (Join-Path $HOME '.pi/agent'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $HOME 'local-repository-map/repository-map.psm1') -Force
$repository = Get-LocalRepositoryPath 'expgolemclone/pi-extensions'
$remote = (& jj --repository $repository git remote list) -join "`n"
if ($LASTEXITCODE -ne 0 -or $remote -notmatch '^origin https://github\.com/expgolemclone/pi-extensions(?:\.git)?$') {
    throw 'Accounts must be built from the registered expgolemclone/pi-extensions fork.'
}
$commit = (& jj --repository $repository log -r main --no-graph -T commit_id).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve synchronized accounts source.' }
$remoteCommit = (& jj --repository $repository log -r 'main@origin' --no-graph -T commit_id).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -ne $remoteCommit) { throw 'Synchronize the fork main before deploying accounts.' }
$changes = & jj --repository $repository diff --summary --from main --to '@'
if ($LASTEXITCODE -ne 0 -or $changes) { throw 'The registered fork must match synchronized main before deployment.' }
Get-Command pi -ErrorAction Stop | Out-Null
Get-Command node -ErrorAction Stop | Out-Null
$sdkEntry = (& node (Join-Path $PSScriptRoot 'pi-install.mjs')).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the active managed Pi SDK.' }
$AgentDirectory = [IO.Path]::GetFullPath($AgentDirectory)
New-Item -ItemType Directory -Force $AgentDirectory | Out-Null
$stage = Join-Path $AgentDirectory ('.accounts-install-' + [guid]::NewGuid().ToString('N'))
$artifacts = Join-Path $stage 'artifacts'
$runtime = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Force $artifacts, $runtime | Out-Null
$previousAgentDirectory = $env:PI_CODING_AGENT_DIR
try {
    Push-Location $repository
    try {
        & npm ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Accounts source dependency installation failed.' }
        & npm --workspace '@narumitw/pi-tui-kit' run build
        if ($LASTEXITCODE -ne 0) { throw 'Accounts UI dependency build failed.' }
        foreach ($package in @('@narumitw/pi-tui-kit', '@narumitw/pi-accounts')) {
            & npm pack --workspace $package --pack-destination $artifacts
            if ($LASTEXITCODE -ne 0) { throw "Could not pack $package." }
        }
    } finally { Pop-Location }
    $archives = @(Get-ChildItem -LiteralPath $artifacts -Filter '*.tgz' | ForEach-Object FullName)
    if ($archives.Count -ne 2) { throw 'Expected only accounts and its UI library archives.' }
    & npm install --prefix $runtime --omit=peer --ignore-scripts --no-audit --no-fund @archives
    if ($LASTEXITCODE -ne 0) { throw 'Accounts production dependency installation failed.' }
    @{ repository = 'https://github.com/expgolemclone/pi-extensions'; commit = $commit } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'source.json') -Encoding utf8
    @{ private = $true; pi = @{ extensions = @('./runtime/node_modules/@narumitw/pi-accounts/dist/index.ts') } } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'package.json') -Encoding utf8
    & node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') verify $stage $sdkEntry
    if ($LASTEXITCODE -ne 0) { throw 'Staged accounts runtime failed its offline Pi loader/probe verification.' }

    # Verify the replacement before removing the old declaration and managed install.
    # Publish afterward so discovery never sees both account extensions at once.
    $env:PI_CODING_AGENT_DIR = $AgentDirectory
    $settingsPath = Join-Path $AgentDirectory 'settings.json'
    $settings = if (Test-Path -LiteralPath $settingsPath) {
        Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable
    } else { @{} }
    $original = @($settings['packages'] | Where-Object {
        $source = if ($_ -is [string]) { $_ } elseif ($_ -is [Collections.IDictionary]) { $_['source'] } else { $null }
        $source -match '^npm:@narumitw/pi-accounts(?:@[^/]+)?$'
    })
    if ($original.Count -gt 0 -or (Test-Path -LiteralPath (Join-Path $AgentDirectory 'npm/node_modules/@narumitw/pi-accounts'))) {
        & pi remove 'npm:@narumitw/pi-accounts'
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the original managed accounts package.' }
    }
    & node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') publish $runtime $AgentDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not publish the accounts runtime.' }
    & node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') verify (Join-Path $AgentDirectory 'extensions/accounts') $sdkEntry
    if ($LASTEXITCODE -ne 0) { throw 'Installed accounts runtime failed offline verification.' }
    Write-Output "Installed accounts from $commit. Credentials and cooldown/recovery records were preserved. Restart Pi or run /reload."
} finally {
    $env:PI_CODING_AGENT_DIR = $previousAgentDirectory
    Remove-Item -LiteralPath $stage -Recurse -Force
}
