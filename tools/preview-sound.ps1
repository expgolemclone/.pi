Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$path = Join-Path (Split-Path $PSScriptRoot -Parent) 'agent/sounds/ready.wav'
Write-Output "Adopted three-note wood-like chime: $path"
$player = [System.Media.SoundPlayer]::new($path)
try {
    $player.Load()
    $player.PlaySync()
} finally {
    $player.Dispose()
}
