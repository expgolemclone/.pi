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

Import-Module (Join-Path $HOME 'local-repository-map/RepositoryMap.psm1') -Force
$envxRepositories = @((Read-LocalRepositoryMap).repositories | Where-Object repository -eq 'expgolemclone/envx')
if ($envxRepositories.Count -ne 1) { throw 'Exactly one mapped envx repository is required.' }
$envxSkill = Join-Path $envxRepositories[0].path 'skills/envx'
if (-not (Test-Path -LiteralPath (Join-Path $envxSkill 'SKILL.md') -PathType Leaf)) {
    throw "Mapped envx skill is missing: $envxSkill"
}

$settingsPath = Join-Path $PSScriptRoot 'agent/settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
    Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable
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
$settings['defaultTools'] = @('read', 'powershell', 'edit', 'write', 'grep', 'find', 'ls')
$settings['defaultProjectTrust'] = 'always'
$skills = if ($settings.ContainsKey('skills')) { @($settings['skills']) } else { @() }
$settings['skills'] = @(@($skills) + $envxSkill | Select-Object -Unique)
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8
Write-Output 'Pi is configured to use shared .agents resources, PowerShell, and the local three-note completion notifier. Run /reload.'
