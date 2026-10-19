[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [string]$AgentDirectory = (Join-Path $HOME '.pi/agent')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Source = (Get-Item -LiteralPath $Source -ErrorAction Stop).FullName
$AgentDirectory = [IO.Path]::GetFullPath($AgentDirectory)
$package = [IO.File]::ReadAllText((Join-Path $Source 'package.json')) | ConvertFrom-Json -AsHashtable
if ($package.name -cne '@expgolemclone/pi-accounts') { throw 'Expected a pi-accounts source directory.' }
$sdkEntry = (& node (Join-Path $PSScriptRoot 'pi-install.mjs')).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the active managed Pi SDK.' }
$shared = (& node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') destination $AgentDirectory).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Accounts shared destination validation failed.' }
$stage = Join-Path (Split-Path $shared -Parent) ('.pi-accounts-install-' + [guid]::NewGuid().ToString('N'))
$runtime = Join-Path $stage 'runtime'
$artifacts = Join-Path $runtime 'artifacts'
New-Item -ItemType Directory -Path $artifacts | Out-Null
try {
    Push-Location $Source
    try {
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Accounts dependency installation failed.' }
        # npm pack runs the package's prepack build.
        & npm pack --workspaces --include-workspace-root --pack-destination $artifacts
        if ($LASTEXITCODE -ne 0) { throw 'Accounts build or packaging failed.' }
    } finally { Pop-Location }
    $archives = @(Get-ChildItem -LiteralPath $artifacts -Filter '*.tgz' | ForEach-Object FullName)
    if ($archives.Count -ne 2) { throw 'Expected Accounts and private-files archives.' }
    @{ name = 'pi-accounts-runtime'; private = $true; type = 'module'; allowScripts = $package.allowScripts } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runtime 'package.json') -Encoding utf8
    Copy-Item -LiteralPath (Join-Path $Source '.npmrc') -Destination (Join-Path $runtime '.npmrc')
    & npm install --prefix $runtime --omit=dev --legacy-peer-deps --no-audit --no-fund @archives
    if ($LASTEXITCODE -ne 0) { throw 'Accounts runtime dependency installation failed.' }
    @{ repository = 'https://github.com/expgolemclone/pi-accounts'; version = $package.version } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'source.json') -Encoding utf8
    & node (Join-Path $PSScriptRoot 'accounts-runtime.mjs') publish $runtime $AgentDirectory $sdkEntry
    if ($LASTEXITCODE -ne 0) { throw 'Shared Accounts publication or offline replacement verification failed.' }
    Write-Output "Installed Accounts $($package.version). Credentials, settings and recovery records were preserved. Run /reload when convenient."
} finally {
    if (Test-Path -LiteralPath (Join-Path $stage 'previous-runtime')) {
        Write-Warning "Accounts recovery runtime retained at $stage."
    } else { Remove-Item -LiteralPath $stage -Recurse -Force }
}
