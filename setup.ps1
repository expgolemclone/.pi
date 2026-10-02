Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath((Join-Path $HOME '.pi'))) {
    throw 'Clone this repository into $HOME/.pi before running setup.ps1.'
}
Get-Command pi -ErrorAction Stop | Out-Null
foreach ($relativePath in @('.codex/config.toml', '.codex/AGENTS.md', '.agents/skills')) {
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
$settings['defaultTools'] = @('read', 'powershell', 'edit', 'write', 'grep', 'find', 'ls')
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8
Write-Output 'Pi is configured to use shared Codex settings and PowerShell. Start pi in your project directory.'
