Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath((Join-Path $HOME '.pi'))) {
    throw 'Clone this repository into $HOME/.pi before running setup.ps1.'
}
Get-Command pi -ErrorAction Stop | Out-Null
foreach ($relativePath in @('.agents/AGENTS.md', '.agents/skills')) {
    if (-not (Test-Path -LiteralPath (Join-Path $HOME $relativePath))) {
        throw "Required shared resource is missing: $relativePath"
    }
}

$kintoneIntegration = Join-Path $env:LOCALAPPDATA 'kintone-workspace/integrations/pi.js'
if (-not (Test-Path -LiteralPath $kintoneIntegration -PathType Leaf)) {
    throw "Required workspace integration is missing: $kintoneIntegration"
}
$sound = Join-Path $PSScriptRoot 'agent/sounds/ready.wav'
if (-not (Test-Path -LiteralPath $sound -PathType Leaf)) {
    throw "Required completion sound is missing: $sound"
}
$instructions = Join-Path $PSScriptRoot 'agent/AGENTS.md'
if (-not (Test-Path -LiteralPath $instructions -PathType Leaf)) {
    New-Item -ItemType SymbolicLink -Path $instructions -Target (Join-Path $HOME '.agents/AGENTS.md') | Out-Null
}
Write-Output 'Pi uses agent/settings.json and agent/models.json, shared .agents instructions and skills, and the bundled completion sound. Run /reload.'
