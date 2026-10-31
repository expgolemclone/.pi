Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiNotificationTest { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
$env:USERPROFILE = $homePath
$env:HOME = $homePath
$env:PI_CODING_AGENT_DIR = $agentDir
$env:PI_OFFLINE = '1'
$env:PI_TELEMETRY = '0'
$env:PI_SKIP_VERSION_CHECK = '1'
$env:TEMP = $homePath
$env:TMP = $homePath
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $windowTitle)
$focusTitle = $windowTitle + '-focus'
$focusCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $focusTitle)
$wt = (Get-Command wt.exe -CommandType Application).Source
$piWindow = $null
$decoyWindow = $null
$focusWindow = $null
function Wait-Until([scriptblock]$predicate, [int]$seconds, [string]$message) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    do {
        if (& $predicate) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw $message
}
try {
    Start-Process -FilePath $wt -ArgumentList '-w', 'new', 'new-tab', '--title', $windowTitle, '--suppressApplicationTitle', $nodePath, $cliPath, '--no-mcp', '--no-tools', '--no-skills', '--no-prompt-templates', '--no-session'
    Wait-Until { (Test-Path -LiteralPath $readyPath) -and $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition).Count -eq 1 } 25 'Pi fixture did not start.'
    $piWindow = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)[0]
    $piHandle = [IntPtr]::new($piWindow.Current.NativeWindowHandle)
    $decoy = '$ErrorActionPreference = ''Stop''; while (-not [IO.File]::Exists(' + "'" + $quitPath.Replace("'", "''") + "'" + ')) { Start-Sleep -Milliseconds 100 }'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($decoy))
    Start-Process -FilePath $wt -ArgumentList '-w', 'new', 'new-tab', '--title', $windowTitle, '--suppressApplicationTitle', $pwshPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded
    Wait-Until { $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition).Count -eq 2 } 20 'Decoy window did not start.'
    foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
        if ($window.Current.NativeWindowHandle -ne $piHandle.ToInt32()) { $decoyWindow = $window }
    }
    if ($null -eq $decoyWindow) { throw 'Could not identify decoy fixture window.' }
    $decoyHandle = [IntPtr]::new($decoyWindow.Current.NativeWindowHandle)
    Start-Sleep -Milliseconds 750
    [void][PiNotificationTest]::ShowWindow($decoyHandle, 6)
    [void][PiNotificationTest]::ShowWindow($piHandle, 6)
    Wait-Until { [PiNotificationTest]::IsIconic($piHandle) -and [PiNotificationTest]::IsIconic($decoyHandle) } 5 'Fixture windows did not minimize.'
    Start-Process -FilePath $wt -ArgumentList '-w', 'new', 'new-tab', '--title', $focusTitle, '--suppressApplicationTitle', $pwshPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded
    Wait-Until { $root.FindAll([System.Windows.Automation.TreeScope]::Children, $focusCondition).Count -eq 1 } 20 'Foreground fixture did not start.'
    $focusWindow = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $focusCondition)[0]
    $foreground = [IntPtr]::new($focusWindow.Current.NativeWindowHandle)
    [void][PiNotificationTest]::SetForegroundWindow($foreground)
    Wait-Until { [PiNotificationTest]::GetForegroundWindow() -eq $foreground } 5 'Could not focus the foreground fixture.'
    [IO.File]::WriteAllText($goPath, 'go')
    Wait-Until { (Test-Path -LiteralPath $donePath) -and -not [PiNotificationTest]::IsIconic($piHandle) } 25 'Pi fixture did not settle and restore its window.'
    if (-not [PiNotificationTest]::IsIconic($decoyHandle)) { throw 'A different window with the same title was restored.' }
    $after = [PiNotificationTest]::GetForegroundWindow()
    if ($after -eq $piHandle) { throw 'Restoring the Pi fixture activated its window.' }
    [IO.File]::WriteAllText($queryPath, 'query')
    Wait-Until { Test-Path -LiteralPath $colorPath } 10 'The Pi fixture did not report its terminal background.'
    $color = [IO.File]::ReadAllText($colorPath) | ConvertFrom-Json
    if ($color.background.r -ne 255 -or $color.background.g -ne 255 -or $color.background.b -ne 255 -or
        $color.foreground.r -ne 0 -or $color.foreground.g -ne 0 -or $color.foreground.b -ne 0) {
        throw "Unexpected ready colors: $([IO.File]::ReadAllText($colorPath))"
    }
    $theme = [IO.File]::ReadAllText($themePath) | ConvertFrom-Json
    if ($theme.appearance -ne 'light' -or ($theme.text.r + $theme.text.g + $theme.text.b) -gt 384 -or
        $theme.userMessageBg.r -lt 200 -or $theme.userMessageBg.g -lt 200 -or $theme.userMessageBg.b -lt 200) {
        throw "Pi did not switch to readable light colors: $([IO.File]::ReadAllText($themePath))"
    }
    Remove-Item -LiteralPath $colorPath -Force
    [IO.File]::WriteAllText($inputPath, 'input')
    Wait-Until { Test-Path -LiteralPath $keyPath } 10 'The Pi fixture did not receive the input.'
    if ([IO.File]::ReadAllText($keyPath) -ne 'x') { throw 'The completion indicator consumed the input.' }
    [IO.File]::WriteAllText($queryPath, 'query')
    Wait-Until { Test-Path -LiteralPath $colorPath } 10 'The Pi fixture did not report its restored background.'
    $color = [IO.File]::ReadAllText($colorPath) | ConvertFrom-Json
    if ($color.background.r -ne 26 -or $color.background.g -ne 43 -or $color.background.b -ne 60 -or
        $color.foreground.r -ne 170 -or $color.foreground.g -ne 187 -or $color.foreground.b -ne 204) {
        throw "Unexpected restored colors: $([IO.File]::ReadAllText($colorPath))"
    }
    $theme = [IO.File]::ReadAllText($themePath) | ConvertFrom-Json
    if ($theme.appearance -ne 'dark' -or ($theme.text.r + $theme.text.g + $theme.text.b) -lt 300) {
        throw "Pi did not restore readable dark colors: $([IO.File]::ReadAllText($themePath))"
    }
    Remove-Item -LiteralPath $donePath, $colorPath -Force
    [IO.File]::WriteAllText($goPath, 'go again')
    Wait-Until { Test-Path -LiteralPath $donePath } 15 'Pi fixture did not settle the second run.'
    Start-Sleep -Milliseconds 1500
    if ([PiNotificationTest]::IsIconic($piHandle)) { throw 'The visible Pi window was minimized.' }
    if ([PiNotificationTest]::GetForegroundWindow() -eq $piHandle) { throw 'The visible Pi window took focus.' }
    [IO.File]::WriteAllText($queryPath, 'query again')
    Wait-Until { Test-Path -LiteralPath $colorPath } 10 'The Pi fixture did not report its second background.'
    $color = [IO.File]::ReadAllText($colorPath) | ConvertFrom-Json
    if ($color.background.r -ne 255 -or $color.background.g -ne 255 -or $color.background.b -ne 255) {
        throw 'The second run did not mark the background white.'
    }
    $theme = [IO.File]::ReadAllText($themePath) | ConvertFrom-Json
    if ($theme.appearance -ne 'light') { throw 'The second run did not use a light appearance.' }
    Write-Output 'Real Pi fixture restored only its own minimized window, did not activate it, and changed its background.'
} finally {
    [IO.File]::WriteAllText($quitPath, 'quit')
    Start-Sleep -Milliseconds 750
    foreach ($windowCondition in $condition, $focusCondition) {
        foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)) {
            try { $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch {}
        }
    }
}
exit 0
