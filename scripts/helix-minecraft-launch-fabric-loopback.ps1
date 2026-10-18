param(
  [string]$Address = "localhost:25565",
  [string]$MinecraftRoot = (Join-Path $env:APPDATA ".minecraft"),
  [string]$PlayerGameDirectory = "",
  [string]$RequiredGameVersion = "1.21.8",
  [string]$ProfileId = "",
  [int]$LaunchTimeoutSeconds = 90,
  [int]$ConnectTimeoutSeconds = 45,
  [switch]$RestartClient,
  [switch]$AllowAdditionalClient
)

if ($PSVersionTable.PSEdition -eq "Core") {
  $windowsPowerShell = Join-Path $env:SystemRoot `
    "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw "minecraft_windows_powershell_required"
  }
  $forwardedArguments = @(
    "-NoProfile"
    "-Mta"
    "-ExecutionPolicy"
    "Bypass"
    "-File"
    $PSCommandPath
    "-Address"
    $Address
    "-MinecraftRoot"
    $MinecraftRoot
    "-PlayerGameDirectory"
    $PlayerGameDirectory
    "-RequiredGameVersion"
    $RequiredGameVersion
    "-ProfileId"
    $ProfileId
    "-LaunchTimeoutSeconds"
    [string]$LaunchTimeoutSeconds
    "-ConnectTimeoutSeconds"
    [string]$ConnectTimeoutSeconds
  )
  if ($RestartClient) { $forwardedArguments += "-RestartClient" }
  if ($AllowAdditionalClient) { $forwardedArguments += "-AllowAdditionalClient" }
  & $windowsPowerShell @forwardedArguments
  exit $LASTEXITCODE
}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail-Typed([string]$Code) {
  throw $Code
}

function Get-MemoryUsedPercent {
  $memory = Get-CimInstance Win32_OperatingSystem
  [math]::Round(
    (1 - ($memory.FreePhysicalMemory / $memory.TotalVisibleMemorySize)) * 100,
    1
  )
}

function Get-OptionalProfileProperty(
  [object]$Profile,
  [string]$PropertyName
) {
  $property = $Profile.PSObject.Properties[$PropertyName]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# Read the public selected-profile button from the exact Launcher window. A
# historical lastUsed timestamp is not evidence of the current UI selection.
function Get-HelixLauncherProfileObservation([IntPtr]$WindowHandle) {
  if (-not ('HelixLauncherProfileUia' -as [type])) {
    # Use the Windows COM client. The Framework managed client on this host
    # projects even standard buttons as panes and cannot load its old proxies.
    # ABI declarations follow Windows SDK UIAutomationClient.h. Unused slots
    # retain their order; this private adapter exposes only bounded reads.
    Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class HelixLauncherProfileUia {
    [ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ICondition { }
    [ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IElementArray {
        int GetLength();
        IElement GetElement(int index);
    }
    [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IElement {
        void UnusedSetFocus(); void UnusedGetRuntimeId(); void UnusedFindFirst();
        IElementArray FindAll(int scope, ICondition condition);
        void UnusedFindFirstBuildCache(); void UnusedFindAllBuildCache(); void UnusedBuildUpdatedCache();
        [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int propertyId);
    }
    [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAutomation {
        void UnusedCompareElements(); void UnusedCompareRuntimeIds(); void UnusedGetRootElement();
        IElement ElementFromHandle(IntPtr window);
        void UnusedElementFromPoint(); void UnusedGetFocusedElement(); void UnusedGetRootElementBuildCache();
        void UnusedElementFromHandleBuildCache(); void UnusedElementFromPointBuildCache(); void UnusedGetFocusedElementBuildCache();
        void UnusedCreateTreeWalker(); void UnusedControlViewWalker(); void UnusedContentViewWalker(); void UnusedRawViewWalker();
        void UnusedRawViewCondition(); void UnusedControlViewCondition(); void UnusedContentViewCondition(); void UnusedCreateCacheRequest();
        void UnusedCreateTrueCondition(); void UnusedCreateFalseCondition();
        ICondition CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value);
    }
    private static void Release(object value) {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }
    public static Hashtable Read(IntPtr window) {
        IAutomation automation = null; IElement root = null; ICondition condition = null; IElementArray buttons = null;
        try {
            automation = (IAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e")));
            root = automation.ElementFromHandle(window);
            int processId = (int)root.GetCurrentPropertyValue(30002); // UIA_ProcessIdPropertyId
            condition = automation.CreatePropertyCondition(30003, 50000); // ControlType = Button
            buttons = root.FindAll(4, condition); // TreeScope_Descendants of this exact window
            int count = buttons.GetLength();
            if (count > 1000) throw new InvalidOperationException("minecraft_launcher_profile_observation_unavailable");
            var names = new List<string>(); int offscreen = 0; int disabled = 0;
            for (int i = 0; i < count; i++) {
                IElement button = buttons.GetElement(i);
                try {
                    bool hidden = (bool)button.GetCurrentPropertyValue(30022); // UIA_IsOffscreenPropertyId
                    bool enabled = (bool)button.GetCurrentPropertyValue(30010); // UIA_IsEnabledPropertyId
                    if (hidden) offscreen++; if (!enabled) disabled++;
                    if (!hidden && enabled) names.Add((string)button.GetCurrentPropertyValue(30005)); // UIA_NamePropertyId
                } finally { Release(button); }
            }
            return new Hashtable {
                {"process_id", processId}, {"button_names", names.ToArray()}, {"total_button_count", count},
                {"offscreen_button_count", offscreen}, {"disabled_button_count", disabled},
                {"apartment_state", Thread.CurrentThread.GetApartmentState().ToString()}
            };
        } finally { Release(buttons); Release(condition); Release(root); Release(automation); }
    }
}
'@
  }
  return [HelixLauncherProfileUia]::Read($WindowHandle)
}

function Assert-HelixLauncherSelectedProfile(
  [IntPtr]$WindowHandle, [int]$ExpectedProcessId, [string]$ProfileName, [string]$ProfileVersion,
  [string]$DiagnosticPath = ''
) {
  try { $observation = Get-HelixLauncherProfileObservation $WindowHandle }
  catch { throw 'minecraft_launcher_profile_observation_unavailable' }
  if ($observation.process_id -ne $ExpectedProcessId -or $ExpectedProcessId -le 0) {
    throw 'minecraft_launcher_profile_window_mismatch'
  }
  if ([string]::IsNullOrWhiteSpace($ProfileName) -or [string]::IsNullOrWhiteSpace($ProfileVersion)) {
    throw 'minecraft_saved_player_profile_unavailable'
  }
  $expected = "$ProfileName $ProfileVersion"
  $matchingButtons = @($observation.button_names | Where-Object { ([regex]::Replace([string]$_, '\s+', ' ')).Trim() -ceq $expected })
  if ($matchingButtons.Count -ne 1) {
    if ($DiagnosticPath) {
      # Bounded public profile-button diagnostics only. Never capture account
      # controls, arbitrary UI content, process command lines or credentials.
      $candidates = @($observation.button_names | Where-Object {
        ([string]$_).IndexOf($ProfileName, [StringComparison]::Ordinal) -ge 0 -or
        ([string]$_).IndexOf($ProfileVersion, [StringComparison]::Ordinal) -ge 0
      } | Select-Object -First 8 | ForEach-Object { ([string]$_).Substring(0, [Math]::Min(300, ([string]$_).Length)) })
      try {
        [IO.File]::WriteAllText($DiagnosticPath, (@{ schema = 'helix.minecraft.launcher_profile_diagnostic.v1';
          observed_at = [DateTime]::UtcNow.ToString('o'); expected_profile = $ProfileName; expected_version = $ProfileVersion;
          visible_button_count = @($observation.button_names).Count; matching_button_count = $matchingButtons.Count;
          total_button_count = $observation.total_button_count; offscreen_button_count = $observation.offscreen_button_count;
          disabled_button_count = $observation.disabled_button_count; apartment_state = $observation.apartment_state;
          candidate_profile_buttons = $candidates; credential_included = $false } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
      } catch { }
    }
    if (@($observation.button_names).Count -eq 0) { throw 'minecraft_launcher_profile_observation_unavailable' }
    # A newly opened launcher may expose only its window frame while the
    # installation page loads. This is no profile evidence and cannot admit
    # Play; re-observe within the existing launch deadline.
    $contentButtons = @($observation.button_names | Where-Object {
      ([string]$_).Trim() -cnotin @('Minimize', 'Maximize', 'Restore', 'Close')
    })
    if ($contentButtons.Count -eq 0) { throw 'minecraft_launcher_profile_loading' }
    throw 'minecraft_fabric_profile_selection_required'
  }
}

$addressMatch = [regex]::Match(
  $Address.Trim(),
  '^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$'
)
if (-not $addressMatch.Success) { Fail-Typed "minecraft_loopback_address_required" }
$port = if ($addressMatch.Groups[2].Success) {
  [int]$addressMatch.Groups[2].Value
} else {
  25565
}
if ($port -lt 1 -or $port -gt 65535) { Fail-Typed "minecraft_loopback_port_invalid" }
$normalizedAddress = "$($addressMatch.Groups[1].Value.ToLowerInvariant()):$port"

$root = [IO.Path]::GetFullPath($MinecraftRoot)
$profilesPath = Join-Path $root "launcher_profiles.json"
$launcherPath = "C:\Program Files (x86)\Minecraft Launcher\MinecraftLauncher.exe"
if (-not (Test-Path -LiteralPath $profilesPath -PathType Leaf)) {
  Fail-Typed "minecraft_launcher_profiles_missing"
}
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  Fail-Typed "minecraft_launcher_missing"
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
  Fail-Typed "minecraft_loopback_server_not_listening"
}
$connectedClientIds = @(
  Get-NetTCPConnection -State Established -RemotePort $port -ErrorAction SilentlyContinue |
    ForEach-Object OwningProcess |
    Sort-Object -Unique
)
$existingMinecraftClient = Get-Process javaw -ErrorAction SilentlyContinue |
  Where-Object {
    $connectedClientIds -contains $_.Id -or
    # Minecraft marks a modded or otherwise modified client title with `*`
    # (for example `Minecraft* 1.21.8`). Treat that as the same verified game
    # window so a lifecycle retry reuses the client instead of clicking Play
    # again and then waiting for a second javaw process that will never start.
    ($_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match '^Minecraft(?:\*|\s|$)')
  } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1

if ($RestartClient -and $AllowAdditionalClient) {
  Fail-Typed "minecraft_restart_and_additional_client_conflict"
}
if ($AllowAdditionalClient) {
  # An explicitly selected isolated profile may allocate a second client. Do
  # not reuse or disturb another verified Minecraft window in this mode.
  $existingMinecraftClient = $null
}

if ($RestartClient -and $existingMinecraftClient) {
  $verifiedClientId = [int]$existingMinecraftClient.Id
  $verifiedClient = Get-Process -Id $verifiedClientId -ErrorAction SilentlyContinue
  if (-not $verifiedClient) { Fail-Typed "minecraft_existing_client_unavailable" }
  $null = $verifiedClient.CloseMainWindow()
  $closeDeadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $verifiedClient = Get-Process -Id $verifiedClientId -ErrorAction SilentlyContinue
  } until (-not $verifiedClient -or (Get-Date) -ge $closeDeadline)
  if ($verifiedClient) {
    # RestartClient is an explicit operator delegation to replace this exact
    # verified Minecraft client. Never broaden this to every java/javaw PID.
    Stop-Process -Id $verifiedClientId
    Wait-Process -Id $verifiedClientId -Timeout 15 -ErrorAction SilentlyContinue
  }
  $existingMinecraftClient = $null
}
# Reusing an already verified client only stages the bounded autojoin inbox and
# must remain available under launch pressure. Preserve the launch ceiling for
# the branch that would allocate a new Minecraft client.
if (-not $existingMinecraftClient -and (Get-MemoryUsedPercent) -ge 90) {
  Fail-Typed "minecraft_launch_memory_ceiling"
}

$profiles = Get-Content -LiteralPath $profilesPath -Raw | ConvertFrom-Json
$fabricProfiles = @(
  $profiles.profiles.PSObject.Properties |
    ForEach-Object {
      $gameDir = Get-OptionalProfileProperty $_.Value "gameDir"
      $lastUsed = Get-OptionalProfileProperty $_.Value "lastUsed"
      [pscustomobject]@{
        id = $_.Name
        name = [string]$_.Value.name
        version = [string]$_.Value.lastVersionId
        gameDir = [string]$gameDir
        lastUsed = if ($lastUsed) {
          [datetime]$lastUsed
        } else {
          [datetime]::MinValue
        }
      }
    } |
    Where-Object { $_.version -match "^fabric-loader-.*-$([regex]::Escape($RequiredGameVersion))$" } |
    Sort-Object lastUsed -Descending
)
if ($fabricProfiles.Count -eq 0) { Fail-Typed "minecraft_fabric_profile_missing" }
if (-not [string]::IsNullOrWhiteSpace($PlayerGameDirectory)) {
  $selectedGameRoot = [IO.Path]::GetFullPath($PlayerGameDirectory)
  $fabricProfiles = @($fabricProfiles | Where-Object {
    $candidateGameRoot = if ([string]::IsNullOrWhiteSpace($_.gameDir)) { $root } else { [IO.Path]::GetFullPath($_.gameDir) }
    $candidateGameRoot -eq $selectedGameRoot
  })
  if ($fabricProfiles.Count -ne 1) { Fail-Typed "minecraft_saved_player_profile_unavailable" }
}
$selectedProfile = if ([string]::IsNullOrWhiteSpace($ProfileId)) {
  $fabricProfiles[0]
} else {
  @($fabricProfiles | Where-Object { $_.id -eq $ProfileId })[0]
}
if (-not $selectedProfile) { Fail-Typed "minecraft_fabric_profile_not_found" }
$mostRecentProfile = @(
  $profiles.profiles.PSObject.Properties |
    ForEach-Object {
      $lastUsed = Get-OptionalProfileProperty $_.Value "lastUsed"
      [pscustomobject]@{
        id = $_.Name
        lastUsed = if ($lastUsed) {
          [datetime]$lastUsed
        } else {
          [datetime]::MinValue
        }
      }
    } |
    Sort-Object lastUsed -Descending
)[0]
if ($existingMinecraftClient -and $mostRecentProfile.id -ne $selectedProfile.id) {
  Fail-Typed "minecraft_fabric_profile_selection_required"
}
$gameRoot = if ([string]::IsNullOrWhiteSpace($selectedProfile.gameDir)) {
  $root
} else {
  [IO.Path]::GetFullPath($selectedProfile.gameDir)
}
if ($AllowAdditionalClient -and $gameRoot -eq $root) {
  Fail-Typed "minecraft_additional_client_isolated_game_directory_required"
}
$logsPath = Join-Path $gameRoot "logs\latest.log"
$autoJoinInbox = Join-Path $gameRoot "config\helix-fabric-player-agent.autojoin-inbox"

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies ([Drawing.Bitmap].Assembly.Location) -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public static class HelixMinecraftLauncherAutomation {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr window, IntPtr deviceContext, uint flags);
    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr window,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extra);

    public static Point LocatePlayButton(Bitmap image) {
        // The launcher can reflow the profile/Play band all the way to the
        // bottom edge at narrower heights. Scan the complete bounded lower
        // center region; the right bound deliberately excludes gift banners.
        int left = image.Width / 3;
        int right = image.Width * 4 / 5;
        int top = image.Height / 2;
        int bottom = image.Height - 2;

        int width = right - left;
        int height = bottom - top;
        bool[,] green = new bool[height, width];
        for (int y = top; y < bottom; y++) {
            for (int x = left; x < right; x++) {
                Color pixel = image.GetPixel(x, y);
                bool buttonGreen = pixel.R >= 35 && pixel.R <= 90 &&
                    pixel.G >= 95 && pixel.G <= 175 &&
                    pixel.B >= 15 && pixel.B <= 75 &&
                    pixel.G >= pixel.R + 45;
                green[y - top, x - left] = buttonGreen;
            }
        }

        bool[,] visited = new bool[height, width];
        int bestScore = -1;
        Rectangle bestBounds = Rectangle.Empty;
        int[] deltaX = new int[] { -1, 1, 0, 0 };
        int[] deltaY = new int[] { 0, 0, -1, 1 };
        for (int localY = 0; localY < height; localY++) {
            for (int localX = 0; localX < width; localX++) {
                if (!green[localY, localX] || visited[localY, localX]) continue;
                var queue = new System.Collections.Generic.Queue<int>();
                queue.Enqueue(localY * width + localX);
                visited[localY, localX] = true;
                int minimumX = localX;
                int maximumX = localX;
                int minimumY = localY;
                int maximumY = localY;
                int greenCount = 0;
                while (queue.Count > 0) {
                    int encoded = queue.Dequeue();
                    int candidateY = encoded / width;
                    int candidateX = encoded % width;
                    greenCount++;
                    minimumX = Math.Min(minimumX, candidateX);
                    maximumX = Math.Max(maximumX, candidateX);
                    minimumY = Math.Min(minimumY, candidateY);
                    maximumY = Math.Max(maximumY, candidateY);
                    for (int direction = 0; direction < 4; direction++) {
                        int nextX = candidateX + deltaX[direction];
                        int nextY = candidateY + deltaY[direction];
                        if (
                            nextX < 0 || nextX >= width ||
                            nextY < 0 || nextY >= height ||
                            visited[nextY, nextX] || !green[nextY, nextX]
                        ) continue;
                        visited[nextY, nextX] = true;
                        queue.Enqueue(nextY * width + nextX);
                    }
                }
                int componentWidth = maximumX - minimumX + 1;
                int componentHeight = maximumY - minimumY + 1;
                int absoluteCenterY = top + (minimumY + maximumY) / 2;
                bool plausiblePlayControl =
                    // Exclude narrower green modal actions such as "Share
                    // crash report" while retaining the responsive Play band.
                    componentWidth >= image.Width / 6 &&
                    componentHeight >= Math.Max(12, image.Height / 60) &&
                    absoluteCenterY >= image.Height * 2 / 3;
                if (!plausiblePlayControl) continue;
                int score = greenCount + absoluteCenterY * 4;
                if (score > bestScore) {
                    bestScore = score;
                    bestBounds = new Rectangle(
                        left + minimumX,
                        top + minimumY,
                        componentWidth,
                        componentHeight
                    );
                }
            }
        }
        if (bestScore < 0 || bestBounds.IsEmpty) {
            throw new InvalidOperationException("minecraft_launcher_play_control_not_found");
        }
        return new Point(
            bestBounds.Left + bestBounds.Width / 2,
            bestBounds.Top + bestBounds.Height / 2
        );
    }

    private static bool TryLocateCrashReportDoNotShare(
        Bitmap image,
        out Point target
    ) {
        // The current launcher crash-consent modal renders a narrow green
        // "Share crash report" control in the lower-right half. Its privacy-
        // preserving "Do not share" sibling is immediately to the left. This
        // detector is used only after the wide Play component was absent.
        int left = image.Width / 2;
        int right = image.Width * 4 / 5;
        int top = image.Height / 2;
        // Current launcher builds place the crash-report actions below the
        // three-quarter line on tall windows. Keep the scan bounded above the
        // news cards while including that lower modal action row.
        int bottom = image.Height * 9 / 10;
        int width = right - left;
        int height = bottom - top;
        bool[,] green = new bool[height, width];
        for (int y = top; y < bottom; y++) {
            for (int x = left; x < right; x++) {
                Color pixel = image.GetPixel(x, y);
                bool buttonGreen = pixel.R >= 35 && pixel.R <= 100 &&
                    pixel.G >= 95 && pixel.G <= 190 &&
                    pixel.B >= 15 && pixel.B <= 90 &&
                    pixel.G >= pixel.R + 40;
                green[y - top, x - left] = buttonGreen;
            }
        }
        bool[,] visited = new bool[height, width];
        Rectangle best = Rectangle.Empty;
        int bestCount = -1;
        int[] dx = new int[] { -1, 1, 0, 0 };
        int[] dy = new int[] { 0, 0, -1, 1 };
        for (int localY = 0; localY < height; localY++) {
            for (int localX = 0; localX < width; localX++) {
                if (!green[localY, localX] || visited[localY, localX]) continue;
                var queue = new System.Collections.Generic.Queue<int>();
                queue.Enqueue(localY * width + localX);
                visited[localY, localX] = true;
                int minX = localX, maxX = localX, minY = localY, maxY = localY;
                int count = 0;
                while (queue.Count > 0) {
                    int encoded = queue.Dequeue();
                    int cy = encoded / width;
                    int cx = encoded % width;
                    count++;
                    minX = Math.Min(minX, cx); maxX = Math.Max(maxX, cx);
                    minY = Math.Min(minY, cy); maxY = Math.Max(maxY, cy);
                    for (int direction = 0; direction < 4; direction++) {
                        int nx = cx + dx[direction], ny = cy + dy[direction];
                        if (nx < 0 || nx >= width || ny < 0 || ny >= height ||
                            visited[ny, nx] || !green[ny, nx]) continue;
                        visited[ny, nx] = true;
                        queue.Enqueue(ny * width + nx);
                    }
                }
                int componentWidth = maxX - minX + 1;
                int componentHeight = maxY - minY + 1;
                if (count >= 500 &&
                    componentWidth >= Math.Max(100, image.Width / 12) &&
                    componentWidth < image.Width / 5 &&
                    componentHeight >= 20 && componentHeight <= image.Height / 8 &&
                    count > bestCount) {
                    bestCount = count;
                    best = new Rectangle(
                        left + minX,
                        top + minY,
                        componentWidth,
                        componentHeight
                    );
                }
            }
        }
        if (best.IsEmpty) {
            target = Point.Empty;
            return false;
        }
        int doNotShareX = best.Left - Math.Max(60, best.Width / 2);
        if (doNotShareX < image.Width / 3) {
            target = Point.Empty;
            return false;
        }
        target = new Point(doNotShareX, best.Top + best.Height / 2);
        return true;
    }

    public static string ClickRenderedPlay(
        IntPtr window,
        uint expectedProcessId,
        string diagnosticImagePath
    ) {
        IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            IntPtr oldForeground = GetForegroundWindow();
            uint oldProcessId;
            uint oldThread = GetWindowThreadProcessId(oldForeground, out oldProcessId);
            uint targetProcessId;
            uint targetThread = GetWindowThreadProcessId(window, out targetProcessId);
            if (targetProcessId != expectedProcessId) {
                throw new InvalidOperationException(
                    "minecraft_launcher_window_identity_mismatch:" +
                    expectedProcessId + ":" + targetProcessId
                );
            }
            uint currentThread = GetCurrentThreadId();
            AttachThreadInput(currentThread, oldThread, true);
            AttachThreadInput(currentThread, targetThread, true);
            try {
                ShowWindow(window, 9);
                keybd_event(0x12, 0, 0, UIntPtr.Zero);
                BringWindowToTop(window);
                SetForegroundWindow(window);
                SetFocus(window);
                keybd_event(0x12, 0, 2, UIntPtr.Zero);
                System.Threading.Thread.Sleep(500);

                RECT rectangle;
                if (!GetWindowRect(window, out rectangle)) {
                    throw new InvalidOperationException("minecraft_launcher_bounds_unavailable");
                }
                int width = rectangle.Right - rectangle.Left;
                int height = rectangle.Bottom - rectangle.Top;
                if (width < 640 || height < 480) {
                    // A launcher reopened from the tray can retain a tiny
                    // restored rectangle. Maximize this exact verified window,
                    // then recapture rather than guessing a stale coordinate.
                    ShowWindow(window, 3);
                    System.Threading.Thread.Sleep(500);
                    if (!GetWindowRect(window, out rectangle)) {
                        throw new InvalidOperationException("minecraft_launcher_bounds_unavailable");
                    }
                    width = rectangle.Right - rectangle.Left;
                    height = rectangle.Bottom - rectangle.Top;
                    if (width < 640 || height < 480) {
                        throw new InvalidOperationException("minecraft_launcher_bounds_invalid");
                    }
                }
                Point target;
                bool dismissCrashReport = false;
                using (Bitmap image = new Bitmap(width, height))
                using (Graphics graphics = Graphics.FromImage(image)) {
                    IntPtr deviceContext = graphics.GetHdc();
                    try {
                        if (!PrintWindow(window, deviceContext, 2)) {
                            throw new InvalidOperationException("minecraft_launcher_render_unavailable");
                        }
                    } finally {
                        graphics.ReleaseHdc(deviceContext);
                    }
                    try {
                        target = LocatePlayButton(image);
                    } catch (InvalidOperationException error) {
                        if (error.Message == "minecraft_launcher_play_control_not_found") {
                            if (!String.IsNullOrWhiteSpace(diagnosticImagePath)) {
                                image.Save(diagnosticImagePath, System.Drawing.Imaging.ImageFormat.Png);
                            }
                            Point privacyTarget;
                            if (TryLocateCrashReportDoNotShare(image, out privacyTarget)) {
                                target = privacyTarget;
                                dismissCrashReport = true;
                            } else {
                                // Older launcher versions dismissed this modal
                                // with Escape. A later frame must still expose
                                // and locate the real Play component.
                                keybd_event(0x1B, 0, 0, UIntPtr.Zero);
                                System.Threading.Thread.Sleep(100);
                                keybd_event(0x1B, 0, 2, UIntPtr.Zero);
                                throw;
                            }
                        } else {
                            throw;
                        }
                    }
                }
                int x = rectangle.Left + target.X;
                int y = rectangle.Top + target.Y;
                IntPtr topmost = new IntPtr(-1);
                IntPtr notTopmost = new IntPtr(-2);
                const uint preserveGeometryAndShow = 0x0001 | 0x0002 | 0x0040;
                SetWindowPos(window, topmost, 0, 0, 0, 0, preserveGeometryAndShow);
                try {
                    System.Threading.Thread.Sleep(250);
                    IntPtr hit = WindowFromPoint(new POINT { X = x, Y = y });
                    // GA_ROOT=2. Current launcher builds may move the rendered
                    // Play surface into another root HWND owned by the same
                    // verified launcher process. Accept that exact-process
                    // reparenting, but keep rejecting every unrelated window.
                    IntPtr hitRoot = hit == IntPtr.Zero
                        ? IntPtr.Zero
                        : GetAncestor(hit, 2);
                    uint hitProcessId = 0;
                    if (hitRoot != IntPtr.Zero) {
                        GetWindowThreadProcessId(hitRoot, out hitProcessId);
                    }
                    if (
                        hit == IntPtr.Zero ||
                        hitRoot == IntPtr.Zero ||
                        (hitRoot != window && hitProcessId != expectedProcessId)
                    ) {
                        throw new InvalidOperationException(
                            "minecraft_launcher_click_target_occluded:" + hitProcessId
                        );
                    }
                    SetCursorPos(x, y);
                    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
                    System.Threading.Thread.Sleep(100);
                    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
                    // Foreground and focus were established above. Deliver
                    // exactly one physical click to the freshly rendered
                    // center. Multiple physical/posted clicks can enqueue
                    // multiple Java clients before this launcher build dims
                    // the Play control.
                    return dismissCrashReport
                        ? "crash_report_dismissed"
                        : x + "," + y;
                } finally {
                    SetWindowPos(
                        window,
                        notTopmost,
                        0,
                        0,
                        0,
                        0,
                        preserveGeometryAndShow
                    );
                }
            } finally {
                AttachThreadInput(currentThread, targetThread, false);
                AttachThreadInput(currentThread, oldThread, false);
            }
        } finally {
            SetThreadDpiAwarenessContext(previousDpi);
        }
    }
}
'@

$launcherAction = "reused_client"
$clickPoint = "not_required"
$launcherStartedHere = $false
if ($existingMinecraftClient) {
  $client = Get-Process -Id $existingMinecraftClient.Id -ErrorAction SilentlyContinue
  if (-not $client) { Fail-Typed "minecraft_existing_client_unavailable" }
} else {
  $launcherAction = "launched_client"
  $existingClientIds = @(Get-Process javaw -ErrorAction SilentlyContinue | ForEach-Object Id)
  $launcherBaselineIds = @(Get-Process MinecraftLauncher -ErrorAction SilentlyContinue | ForEach-Object Id)
  $launcherLaunchStartedAt = [datetime]::MinValue
  $staleOutputWindows = @(Get-Process MinecraftLauncher -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      $_.MainWindowTitle -eq "Minecraft game output"
    })
  $staleOutputWindows | ForEach-Object { $null = $_.CloseMainWindow() }
  if ($staleOutputWindows.Count -gt 0) {
    # A launch request sent while the stale launcher process cluster is still
    # exiting can be swallowed by that dying instance. Wait for either a real
    # launcher window or completion of the stale shutdown before starting it.
    $staleIds = @($staleOutputWindows | ForEach-Object Id)
    $staleDeadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $realLauncher = Get-Process MinecraftLauncher -ErrorAction SilentlyContinue |
        Where-Object {
          $_.MainWindowHandle -ne 0 -and
          $_.MainWindowTitle -ne "Minecraft game output"
        } |
        Select-Object -First 1
      $staleAlive = @(Get-Process -Id $staleIds -ErrorAction SilentlyContinue)
    } until ($realLauncher -or $staleAlive.Count -eq 0 -or (Get-Date) -ge $staleDeadline)
  }
  $launcher = Get-Process MinecraftLauncher -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      $_.MainWindowTitle -ne "Minecraft game output"
    } |
    Select-Object -First 1
  if (-not $launcher) {
    $launcherLaunchStartedAt = Get-Date
    Start-Process -FilePath $launcherPath
    $launcherStartedHere = $true
    $deadline = (Get-Date).AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 500
      $launcher = Get-Process MinecraftLauncher -ErrorAction SilentlyContinue |
        Where-Object {
          $_.MainWindowHandle -ne 0 -and
          $_.MainWindowTitle -ne "Minecraft game output"
        } |
        Select-Object -First 1
    } until ($launcher -or (Get-Date) -ge $deadline)
  }
  if (-not $launcher) { Fail-Typed "minecraft_launcher_window_not_ready" }

  $playDeadline = (Get-Date).AddSeconds(30)
  $clickPoint = $null
  $lastLaunchFailure = "minecraft_launcher_play_control_not_attempted"
  $launcherDiagnosticImage = Join-Path $root "logs\helix-launcher-play-diagnostic.png"
  do {
    $currentLauncher = Get-Process MinecraftLauncher -ErrorAction SilentlyContinue |
      Where-Object {
        $_.MainWindowHandle -ne 0 -and
        $_.MainWindowTitle -ne "Minecraft game output"
      } |
      Select-Object -First 1
    if ($currentLauncher) { $launcher = $currentLauncher }
    try {
      Assert-HelixLauncherSelectedProfile -WindowHandle $launcher.MainWindowHandle `
        -ExpectedProcessId $launcher.Id -ProfileName $selectedProfile.name -ProfileVersion $selectedProfile.version `
        -DiagnosticPath (Join-Path $root 'logs\helix-launcher-profile-diagnostic.json')
      $candidatePoint = [HelixMinecraftLauncherAutomation]::ClickRenderedPlay(
        $launcher.MainWindowHandle,
        [uint32]$launcher.Id,
        $launcherDiagnosticImage
      )
      if ($candidatePoint -eq "crash_report_dismissed") {
        $lastLaunchFailure = "minecraft_launcher_crash_report_dismissed"
        $clickPoint = $null
        Start-Sleep -Seconds 1
        continue
      }
      $clickPoint = $candidatePoint
    } catch {
      $launchFailure = if ($_.Exception.InnerException) { [string]$_.Exception.InnerException.Message } else { [string]$_.Exception.Message }
      $lastLaunchFailure = $launchFailure
      if ($launchFailure -match '^minecraft_launcher_click_target_occluded:([0-9]+)$') {
        $occludingProcess = Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue
        if (
          $occludingProcess -and
          $occludingProcess.ProcessName -eq 'PickerHost' -and
          $occludingProcess.MainWindowTitle -eq 'Windows Security'
        ) {
          $lastLaunchFailure = 'minecraft_launcher_security_prompt_blocked'
          break
        }
      }
      if ($launchFailure -notin @(
        "minecraft_launcher_profile_loading",
        "minecraft_launcher_play_control_not_found",
        "minecraft_launcher_foreground_activation_failed",
        "minecraft_launcher_click_delivery_failed",
        "minecraft_launcher_bounds_unavailable",
        "minecraft_launcher_bounds_invalid"
      ) -and -not $launchFailure.StartsWith(
        "minecraft_launcher_click_target_occluded:"
      )) {
        throw
      }
      Start-Sleep -Seconds 1
    }
  } until ($clickPoint -or (Get-Date) -ge $playDeadline)
  if (-not $clickPoint) {
    Fail-Typed "minecraft_launcher_play_control_timeout:$lastLaunchFailure"
  }
  $clientDeadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
  do {
    Start-Sleep -Seconds 1
    $client = Get-Process javaw -ErrorAction SilentlyContinue |
      Where-Object { $existingClientIds -notcontains $_.Id } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
  } until ($client -or (Get-Date) -ge $clientDeadline)
  if (-not $client) { Fail-Typed "minecraft_client_launch_timeout" }

  # The authenticated launcher has completed its responsibility. Closing its UI
  # alone may leave its multi-process cluster alive. Reap only launcher processes
  # born during this invocation after the independent Java client exists; never
  # stop a launcher that was already running when this request began.
  $null = $launcher.CloseMainWindow()
  if ($launcherStartedHere) {
    $cleanupDeadline = (Get-Date).AddSeconds(5)
    do {
      Start-Sleep -Milliseconds 250
      $ownedLauncherProcesses = @(Get-Process MinecraftLauncher -ErrorAction SilentlyContinue |
        Where-Object {
          $launcherBaselineIds -notcontains $_.Id -and
          $_.StartTime -ge $launcherLaunchStartedAt.AddSeconds(-2) -and
          $_.Path -ieq $launcherPath
        })
      foreach ($ownedLauncherProcess in $ownedLauncherProcesses) {
        Stop-Process -Id $ownedLauncherProcess.Id -Force -ErrorAction SilentlyContinue
      }
    } until ($ownedLauncherProcesses.Count -eq 0 -or (Get-Date) -ge $cleanupDeadline)
  }
  if ((Get-MemoryUsedPercent) -ge 90) {
    # This exact client was created by this request. Do not leave it consuming
    # memory after a failed launch admission, even if its window is not ready.
    $null = $client.CloseMainWindow()
    $clientCloseDeadline = (Get-Date).AddSeconds(5)
    do {
      Start-Sleep -Milliseconds 250
      $stillRunning = Get-Process -Id $client.Id -ErrorAction SilentlyContinue
    } until (-not $stillRunning -or (Get-Date) -ge $clientCloseDeadline)
    if ($stillRunning) { Stop-Process -Id $client.Id -Force -ErrorAction SilentlyContinue }
    Fail-Typed "minecraft_launch_memory_ceiling"
  }
}

$modDeadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
$modLoaded = $false
do {
  Start-Sleep -Seconds 1
  if (-not (Get-Process -Id $client.Id -ErrorAction SilentlyContinue)) {
    Fail-Typed "minecraft_client_exited_before_mod_load"
  }
  if (Test-Path -LiteralPath $logsPath -PathType Leaf) {
    $logFile = Get-Item -LiteralPath $logsPath -ErrorAction SilentlyContinue
    if ($logFile -and $logFile.LastWriteTime -ge $client.StartTime) {
      $modLoaded = [bool](
        Select-String `
          -LiteralPath $logsPath `
          -SimpleMatch 'Helix Fabric Player Agent loaded' `
          -Quiet `
          -ErrorAction SilentlyContinue
      )
    }
  }
} until ($modLoaded -or (Get-Date) -ge $modDeadline)
if (-not $modLoaded) { Fail-Typed "minecraft_helix_mod_load_timeout" }
if ((Get-MemoryUsedPercent) -ge 95) { Fail-Typed "minecraft_runtime_memory_ceiling" }

$connection = Get-NetTCPConnection -OwningProcess $client.Id -ErrorAction SilentlyContinue |
  Where-Object { $_.RemotePort -eq $port -and $_.State -eq 'Established' } |
  Select-Object -First 1
$connectionAction = "already_connected"
if (-not $connection) {
  $connectionAction = "autojoin_staged"
  New-Item -ItemType Directory -Path (Split-Path $autoJoinInbox) -Force | Out-Null
  $pending = "$autoJoinInbox.pending.$PID.$([guid]::NewGuid())"
  try {
    [IO.File]::WriteAllText(
      $pending,
      "/helix-player autojoin $normalizedAddress`n",
      [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $pending -Destination $autoJoinInbox -Force
  } finally {
    Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue
  }

  $connectDeadline = (Get-Date).AddSeconds($ConnectTimeoutSeconds)
  do {
    Start-Sleep -Seconds 1
    $connection = Get-NetTCPConnection -OwningProcess $client.Id -ErrorAction SilentlyContinue |
      Where-Object { $_.RemotePort -eq $port -and $_.State -eq 'Established' } |
      Select-Object -First 1
  } until ($connection -or (Get-Date) -ge $connectDeadline)
  if (-not $connection) { Fail-Typed "minecraft_loopback_connect_timeout" }
}

[ordered]@{
  schema = "helix.minecraft.workstation_launch_receipt.v1"
  status = "connected"
  profile_id = $selectedProfile.id
  profile_version = $selectedProfile.version
  isolated_game_directory = $gameRoot -ne $root
  client_process_id = $client.Id
  server_address = $normalizedAddress
  launcher_action = $launcherAction
  connection_action = $connectionAction
  play_control_point = $clickPoint
  mod_loaded = $modLoaded
  memory_used_percent = Get-MemoryUsedPercent
  credentials_exposed = $false
} | ConvertTo-Json -Compress
