Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Read-only native window evidence. No title, command line, account, input or
# credential material is inspected or emitted. DWM bounds are physical pixels;
# the Electron host converts them to DIP before positioning its click-through HUD.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HelixHudForeground {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsIconic(IntPtr window);
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr window, int attribute,
    out Rect bounds, int boundsSize);
}
'@
  $window = [HelixHudForeground]::GetForegroundWindow()
  if ($window -eq [IntPtr]::Zero -or
      -not [HelixHudForeground]::IsWindowVisible($window) -or
      [HelixHudForeground]::IsIconic($window)) { throw 'foreground_unavailable' }
  [uint32]$processId = 0
  [void][HelixHudForeground]::GetWindowThreadProcessId($window, [ref]$processId)
  if ($processId -eq 0) { throw 'foreground_process_unavailable' }
  $bounds = New-Object HelixHudForeground+Rect
  $result = [HelixHudForeground]::DwmGetWindowAttribute($window, 9,
    [ref]$bounds, [Runtime.InteropServices.Marshal]::SizeOf([type][HelixHudForeground+Rect]))
  if ($result -ne 0 -or $bounds.Right -le $bounds.Left -or
      $bounds.Bottom -le $bounds.Top) { throw 'foreground_bounds_unavailable' }
  $process = Get-Process -Id $processId -ErrorAction Stop
  [ordered]@{
    schema = 'helix.minecraft.hud_foreground_window.v1'
    status = 'observed'
    client_process_id = [int]$processId
    client_process_started_at = $process.StartTime.ToUniversalTime().ToString('o')
    bounds_physical = [ordered]@{
      x = $bounds.Left
      y = $bounds.Top
      width = $bounds.Right - $bounds.Left
      height = $bounds.Bottom - $bounds.Top
    }
    observed_at = [DateTime]::UtcNow.ToString('o')
    credential_included = $false
    input_sent = $false
  } | ConvertTo-Json -Compress -Depth 3
} catch {
  [ordered]@{
    schema = 'helix.minecraft.hud_foreground_window.v1'
    status = 'unavailable'
    credential_included = $false
    input_sent = $false
  } | ConvertTo-Json -Compress
}
