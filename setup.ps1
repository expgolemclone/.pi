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

$settingsPath = Join-Path $PSScriptRoot 'agent/settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
    Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable
} else { @{} }
foreach ($key in @('defaultProvider', 'defaultModel', 'defaultThinkingLevel')) {
    $settings.Remove($key) | Out-Null
}
$npmRoot = (& npm root --global).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not locate the global npm directory.' }
$officialExtensionPaths = @(
    (Join-Path $npmRoot '@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts')
)
foreach ($path in $officialExtensionPaths) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "The installed Pi does not include the required official extension: $path"
    }
}
$extensions = if ($settings.ContainsKey('extensions')) { @($settings['extensions']) } else { @() }
# Retire the old notifier even if its npm root or path separator has changed.
$extensions = @($extensions | Where-Object {
    ($_ -replace '\\', '/') -notmatch '/@earendil-works/pi-coding-agent/examples/extensions/notify\.ts$'
})
$settings['extensions'] = @((@($extensions) + $officialExtensionPaths) | Select-Object -Unique)
# The local notify/index.ts is auto-discovered. Generate its single audio asset.
& node (Join-Path $PSScriptRoot 'tools/sounds.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Could not generate the Pi completion sound.' }
$legacyCandidates = Join-Path $PSScriptRoot 'agent/sounds/candidates'
if (Test-Path -LiteralPath $legacyCandidates) {
    Remove-Item -LiteralPath $legacyCandidates -Recurse
}
$settings['defaultTools'] = @('read', 'powershell', 'edit', 'write', 'grep', 'find', 'ls')
$settings['defaultProjectTrust'] = 'never'
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8
Write-Output 'Pi is configured to use shared .agents resources, PowerShell, official plan-mode, and the local three-note completion notifier. Run /reload.'
