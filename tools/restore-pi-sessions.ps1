#requires -Version 7.6
[CmdletBinding()]
param([string]$SessionDirectory = (Join-Path $HOME '.pi/agent/sessions'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SessionDirectory -PathType Container)) {
    Write-Output 'No saved Pi sessions.'
    return
}

$files = Get-ChildItem -LiteralPath $SessionDirectory -Recurse -File -Filter '*.jsonl' |
    Sort-Object @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, FullName
$sessions = [Collections.Generic.List[object]]::new()
foreach ($file in $files) {
    try {
        $header = Get-Content -LiteralPath $file.FullName -TotalCount 1 -Encoding utf8 | ConvertFrom-Json
        if ($header.type -ne 'session' -or $header.cwd -isnot [string] -or
            -not [IO.Path]::IsPathFullyQualified($header.cwd)) {
            throw 'Expected a session header with an absolute working directory.'
        }
    } catch {
        throw "Cannot read Pi session '$($file.FullName)': $_"
    }
    if (-not (Test-Path -LiteralPath $header.cwd -PathType Container)) {
        Write-Output "Skipping missing working directory: $($header.cwd)"
        continue
    }
    $sessions.Add([pscustomobject]@{ Path = $file.FullName; Cwd = $header.cwd })
    if ($sessions.Count -eq 5) { break }
}
if ($sessions.Count -eq 0) {
    Write-Output 'No resumable Pi sessions.'
    return
}

$mise = (Get-Command mise.exe -CommandType Application -ErrorAction Stop).Source
$powerShell = & $mise which pwsh
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $powerShell -PathType Leaf)) {
    throw 'Could not resolve mise-managed PowerShell.'
}
$terminalArguments = [Collections.Generic.List[string]]::new()
$terminalArguments.AddRange([string[]]@('-w', 'new'))
foreach ($session in $sessions) {
    if ($terminalArguments.Count -gt 2) { $terminalArguments.Add(';') }
    $command = '$ErrorActionPreference = ''Stop''; Set-Location -LiteralPath ''{0}''; & ''{1}'' exec -- pi --session ''{2}''' -f
        $session.Cwd.Replace("'", "''"), $mise.Replace("'", "''"), $session.Path.Replace("'", "''")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $terminalArguments.AddRange([string[]]@('new-tab', $powerShell, '-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', $encoded))
    Write-Output "Resuming $($session.Path) from $($session.Cwd)"
}
& wt.exe @terminalArguments
if ($LASTEXITCODE -ne 0) { throw "Windows Terminal failed with exit code $LASTEXITCODE." }
