Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath((Join-Path $HOME '.pi'))) {
    throw 'Clone this repository into $HOME/.pi before running setup.ps1.'
}
Get-Command pi -ErrorAction Stop | Out-Null
Get-Command node -ErrorAction Stop | Out-Null
foreach ($relativePath in @('.agents/settings.json', '.agents/AGENTS.md', '.agents/skills')) {
    if (-not (Test-Path -LiteralPath (Join-Path $HOME $relativePath))) {
        throw "Required shared resource is missing: $relativePath"
    }
}

$kintoneIntegration = Join-Path $env:LOCALAPPDATA 'kintone-workspace/integrations/pi.js'
if (-not (Test-Path -LiteralPath $kintoneIntegration -PathType Leaf)) {
    throw 'Install the synchronized kintone-workspace runtime before configuring Pi.'
}
$accountsManifest = Join-Path $PSScriptRoot 'agent/extensions/accounts/package.json'
if (-not (Test-Path -LiteralPath $accountsManifest -PathType Leaf)) {
    throw 'Run tools/deploy-accounts.ps1 -Source <pi-accounts-workspace> before setup.'
}
& node (Join-Path $PSScriptRoot 'tools/accounts-runtime.mjs') check (Join-Path $PSScriptRoot 'agent')
if ($LASTEXITCODE -ne 0) { throw 'Shared Accounts placement verification failed before setup.' }
$settingsPath = Join-Path $PSScriptRoot 'agent/settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
    [IO.File]::ReadAllText($settingsPath) | ConvertFrom-Json -AsHashtable
} else { @{} }
foreach ($key in @('defaultProvider', 'defaultModel', 'defaultThinkingLevel')) {
    $settings.Remove($key) | Out-Null
}
$extensions = if ($settings.ContainsKey('extensions')) { @($settings['extensions']) } else { @() }
# Retire official plan-mode and notifier paths regardless of npm root or separator.
$settings['extensions'] = @($extensions | Where-Object {
    ($_ -replace '\\', '/') -notmatch '/@earendil-works/pi-coding-agent/examples/extensions/(notify\.ts|plan-mode(?:/index\.(?:ts|js))?)/?$'
} | Select-Object -Unique)
# The local notify.ts is auto-discovered. Generate its single audio asset.
& node (Join-Path $PSScriptRoot 'tools/sounds.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Could not generate the Pi completion sound.' }
$legacyCandidates = Join-Path $PSScriptRoot 'agent/sounds/candidates'
if (Test-Path -LiteralPath $legacyCandidates) {
    Remove-Item -LiteralPath $legacyCandidates -Recurse
}
$settings['defaultTools'] = @('read', 'powershell', 'edit', 'write', 'grep', 'find', 'ls', 'codemode')
$settings['defaultProjectTrust'] = 'always'
if ($settings.ContainsKey('skills')) {
    $settings['skills'] = @($settings['skills'] | Where-Object {
        ($_ -replace '\\', '/').TrimEnd('/') -notmatch '(?i)(?:^[-+!]?|/)skills/envx(?:/SKILL\.md)?$'
    })
}
# The local kintone.ts loads the installed integration only when the agent asks.
$settings['extensions'] = @($settings['extensions'] | Where-Object {
    ($_ -replace '\\', '/').TrimEnd('/') -notmatch '(?i)/kintone-workspace/integrations/pi\.js$'
} | Select-Object -Unique)
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8
Write-Output 'Pi is configured to use shared .agents resources, PowerShell, and the local three-note completion notifier. Run /reload.'
