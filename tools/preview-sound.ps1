param(
    [Parameter(Position = 0)]
    [ValidateRange(1, 3)]
    [int] $Candidate = 1
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$directory = Join-Path (Split-Path $PSScriptRoot -Parent) 'agent/sounds/candidates'
$report = Get-Content -LiteralPath (Join-Path $directory 'validation.json') -Raw | ConvertFrom-Json
$item = $report.report[$Candidate - 1]
$path = Join-Path $directory $item.file
Write-Output "$Candidate. $($item.description): $path"
$player = [System.Media.SoundPlayer]::new($path)
try {
    $player.Load()
    $player.PlaySync()
} finally {
    $player.Dispose()
}
