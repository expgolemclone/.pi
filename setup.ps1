Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath((Join-Path $HOME '.pi'))) {
    throw 'Clone this repository into $HOME/.pi before running setup.ps1.'
}
Get-Command pi -ErrorAction Stop | Out-Null
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
$planModePath = Join-Path $npmRoot '@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts'
if (-not (Test-Path -LiteralPath $planModePath)) {
    throw "The installed Pi does not include the plan-mode example: $planModePath"
}
$extensions = if ($settings.ContainsKey('extensions')) { @($settings['extensions']) } else { @() }
$settings['extensions'] = @((@($extensions) + @($planModePath)) | Select-Object -Unique)
$settings['defaultTools'] = @('read', 'powershell', 'edit', 'write', 'grep', 'find', 'ls')
$settings['defaultProjectTrust'] = 'never'
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8
Write-Output 'Pi is configured to use shared .agents resources, PowerShell, and the official plan-mode extension.'
