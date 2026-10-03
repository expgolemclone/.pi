param(
    [Parameter(Mandatory)]
    [string] $SoundPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load explicitly: a missing/invalid WAV must fail, never play the system beep.
$player = [System.Media.SoundPlayer]::new($SoundPath)
try {
    $player.Load()
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]::new()
    # LoadXml avoids live DOM collection mutation from the official example.
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Pi</text><text>Ready for input</text></binding></visual><audio silent="true" /></toast>')
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)
    # Direct playback is independent of toast sounds and Do not disturb.
    $player.PlaySync()
} finally {
    $player.Dispose()
}
