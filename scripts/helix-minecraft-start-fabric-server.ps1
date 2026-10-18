param(
  [string]$ServerRunDirectory,
  [string]$Address = "localhost:25565"
)

# Fixed workstation provider. No user/provider commands, EULA writes, downloads,
# credentials, process replacement or gameplay authority are accepted here.
function Invoke-HelixSavedFabricServer {
  param([string]$RunDirectory, [string]$ServerAddress, [int]$StartupTimeoutSeconds = 60)
  $ErrorActionPreference = "Stop"
  Set-StrictMode -Version Latest
  $serverObservation = $null
  $mutex = $null
  $locked = $false
  try {
    if ($StartupTimeoutSeconds -lt 1 -or $StartupTimeoutSeconds -gt 60) { throw "minecraft_server_timeout_invalid" }
    if ($RunDirectory -notmatch '^[A-Za-z]:[\\/]' -or $RunDirectory -match '[\r\n"]') {
      throw "minecraft_server_profile_required"
    }
    $runRoot = [IO.Path]::GetFullPath($RunDirectory)
    if ($runRoot.TrimEnd('\') -eq [IO.Path]::GetPathRoot($runRoot).TrimEnd('\')) { throw "minecraft_server_profile_invalid" }
    $rootItem = Get-Item -LiteralPath $runRoot
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "minecraft_server_profile_invalid"
    }
    $configRoot = Join-Path $runRoot 'config'
    $configItem = Get-Item -LiteralPath $configRoot
    if (-not $configItem.PSIsContainer -or ($configItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "minecraft_server_profile_invalid"
    }
    $jarPath = Join-Path $runRoot 'fabric-server-launch.jar'
    $propertiesPath = Join-Path $runRoot 'server.properties'
    $eulaPath = Join-Path $runRoot 'eula.txt'
    foreach ($requiredPath in @($jarPath, $propertiesPath, $eulaPath)) {
      $required = Get-Item -LiteralPath $requiredPath
      if ($required.PSIsContainer -or ($required.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "minecraft_server_profile_invalid"
      }
    }
    if ((Get-Item -LiteralPath $propertiesPath).Length -gt 65536 -or
        (Get-Item -LiteralPath $eulaPath).Length -gt 4096) { throw "minecraft_server_profile_invalid" }
    $eulaRows = @(Get-Content -LiteralPath $eulaPath | Where-Object { $_.Trim() -and $_ -notmatch '^\s*[#!]' })
    if ($eulaRows.Count -ne 1 -or $eulaRows[0] -cnotmatch '^\s*eula\s*=\s*true\s*$') {
      throw "minecraft_server_eula_acceptance_required"
    }
    $addressMatch = [regex]::Match($ServerAddress, '^(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$', 'IgnoreCase')
    if (-not $addressMatch.Success) { throw "minecraft_loopback_address_required" }
    $port = [int]$addressMatch.Groups[2].Value
    if ($port -lt 1 -or $port -gt 65535) { throw "minecraft_loopback_port_invalid" }
    # Reject ambiguous duplicate/escaped properties instead of interpreting a
    # different bind target from the Java properties reader. Never emit contents.
    $properties = @(Get-Content -LiteralPath $propertiesPath)
    foreach ($line in $properties) {
      if (-not $line.Trim() -or $line -match '^\s*[#!]') { continue }
      if ($line -notmatch '^\s*[A-Za-z0-9_.-]+\s*=' -or $line -match '(?<!\\)(\\\\)*\\$') {
        throw "minecraft_server_properties_ambiguous"
      }
    }
    $ipRows = @($properties | Where-Object { $_ -cmatch '^\s*server-ip\s*=' })
    $portRows = @($properties | Where-Object { $_ -cmatch '^\s*server-port\s*=' })
    if ($ipRows.Count -ne 1 -or $portRows.Count -ne 1) { throw "minecraft_server_loopback_configuration_required" }
    $configuredIp = ($ipRows[0] -split '=', 2)[1].Trim()
    $configuredPort = ($portRows[0] -split '=', 2)[1].Trim()
    if ($configuredIp -notin @('127.0.0.1', '::1') -or $configuredPort -notmatch '^\d{1,5}$') {
      throw "minecraft_server_loopback_configuration_required"
    }
    $requestedHost = $addressMatch.Groups[1].Value.ToLowerInvariant()
    if ([int]$configuredPort -ne $port -or
        ($requestedHost -eq '127.0.0.1' -and $configuredIp -ne '127.0.0.1') -or
        ($requestedHost -eq '[::1]' -and $configuredIp -ne '::1')) {
      throw "minecraft_server_address_mismatch"
    }
    $javaRelative = 'java-runtime-delta\windows-x64\java-runtime-delta'
    $runtimeRoots = @(
      (Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime'),
      (Join-Path $env:APPDATA '.minecraft\runtime')
    )
    $javaPath = $null
    foreach ($runtimeRoot in $runtimeRoots) {
      $candidateRoot = Join-Path $runtimeRoot $javaRelative
      $candidateJava = Join-Path $candidateRoot 'bin\java.exe'
      $releasePath = Join-Path $candidateRoot 'release'
      if ((Test-Path -LiteralPath $candidateJava -PathType Leaf) -and
          (Test-Path -LiteralPath $releasePath -PathType Leaf) -and
          (Get-Item -LiteralPath $releasePath).Length -le 16384 -and
          (Select-String -LiteralPath $releasePath -Pattern '^JAVA_VERSION="21\.[0-9.]+' -Quiet)) {
        $javaPath = [IO.Path]::GetFullPath($candidateJava)
        break
      }
    }
    if (-not $javaPath) { throw "minecraft_launcher_java21_required" }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $profileDigest = ([BitConverter]::ToString($sha.ComputeHash(
      [Text.Encoding]::UTF8.GetBytes($runRoot.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $mutex = [Threading.Mutex]::new($false, "Local\CasimirBotFabricServer-$profileDigest")
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw "minecraft_server_lifecycle_busy" }
    $statePath = Join-Path $configRoot 'helix-fabric-server.workstation-state.json'
    $prior = $null
    if (Test-Path -LiteralPath $statePath) {
      $stateItem = Get-Item -LiteralPath $statePath
      if ($stateItem.PSIsContainer -or $stateItem.Length -gt 4096 -or
          ($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "minecraft_server_state_invalid" }
      try { $prior = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { throw "minecraft_server_state_invalid" }
      if ($prior.schema -ne 'helix.minecraft.owned_server_process.v1' -or $prior.profile_digest -ne $profileDigest) {
        throw "minecraft_server_state_invalid"
      }
      if ($prior.status -eq 'launch_pending') { throw "minecraft_server_start_outcome_unknown" }
      if ($prior.status -ne 'started' -or $prior.process_id -lt 1 -or
          [string]::IsNullOrWhiteSpace($prior.process_started_at)) { throw "minecraft_server_state_invalid" }
    }
    $serverProcess = $null
    if ($prior) {
      $candidate = Get-Process -Id $prior.process_id -ErrorAction SilentlyContinue
      if ($candidate -and $candidate.Path -eq $javaPath -and
          $candidate.StartTime.ToUniversalTime().ToString('o') -eq $prior.process_started_at) {
        $serverProcess = $candidate
      }
    }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0 -and (-not $serverProcess -or
        @($listeners | Where-Object { $_.OwningProcess -ne $serverProcess.Id }).Count -gt 0)) {
      throw "minecraft_server_port_owner_unverified"
    }
    $action = 'reused_server'
    if (-not $serverProcess) {
      $memory = Get-CimInstance Win32_OperatingSystem
      $used = 100 * (1 - $memory.FreePhysicalMemory / $memory.TotalVisibleMemorySize)
      if ($used -ge 90 -or $memory.FreePhysicalMemory -lt 2097152 -or $memory.FreeVirtualMemory -lt 2097152) {
        throw "minecraft_server_launch_memory_ceiling"
      }
      $intent = [ordered]@{ schema = 'helix.minecraft.owned_server_process.v1';
        profile_digest = $profileDigest; status = 'launch_pending';
        launch_id = [guid]::NewGuid().ToString(); requested_at = [DateTime]::UtcNow.ToString('o') }
      Write-HelixServerStateAtomically $statePath $intent
      # Only fixed JVM arguments and the saved profile's fixed JAR are used.
      # The hidden server retains its ordinary rolling Minecraft log; no game
      # output, credentials or raw process command line enters the receipt.
      $serverProcess = Start-Process -FilePath $javaPath -WorkingDirectory $runRoot `
        -ArgumentList @('-Xms256M', '-Xmx1536M', '-jar', ('"' + $jarPath + '"'), 'nogui') `
        -WindowStyle Hidden -PassThru
      $intent.status = 'started'
      $intent['process_id'] = $serverProcess.Id
      $intent['process_started_at'] = $serverProcess.StartTime.ToUniversalTime().ToString('o')
      Write-HelixServerStateAtomically $statePath $intent
      $action = 'launched_server'
    }
    $serverObservation = [ordered]@{
      schema = 'helix.minecraft.local_server_lifecycle.v1'; status = 'starting';
      server_process_id = $serverProcess.Id;
      process_started_at = $serverProcess.StartTime.ToUniversalTime().ToString('o');
      observed_at = [DateTime]::UtcNow.ToString('o');
      server_address = $ServerAddress.ToLowerInvariant(); launcher_action = $action;
      profile_digest = $profileDigest; credentials_exposed = $false; authority_widened = $false
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    # Both elapsed time and count are bounded; clock rollback cannot spin forever.
    for ($poll = 0; $poll -le $StartupTimeoutSeconds; $poll++) {
      $serverObservation.observed_at = [DateTime]::UtcNow.ToString('o')
      $current = Get-Process -Id $serverProcess.Id -ErrorAction SilentlyContinue
      if (-not $current -or $current.Path -ne $javaPath -or
          $current.StartTime.ToUniversalTime().ToString('o') -ne $serverObservation.process_started_at) {
        $serverObservation.status = 'stopped'
        throw "minecraft_server_exited_before_ready"
      }
      $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
      if (@($listeners | Where-Object { $_.OwningProcess -ne $serverProcess.Id }).Count -gt 0) {
        throw "minecraft_server_port_owner_unverified"
      }
      if ($listeners.Count -gt 0) {
        $serverObservation.status = 'listening'
        return @{ ok = $true; server = $serverObservation }
      }
      if ([DateTime]::UtcNow -ge $deadline -or $poll -eq $StartupTimeoutSeconds) { break }
      Start-Sleep -Seconds 1
    }
    throw "minecraft_server_start_timeout"
  } catch {
    $message = [string]$_.Exception.Message
    $code = if ($message -match '^minecraft_[a-z0-9_]{1,100}$') { $message } else { 'minecraft_server_lifecycle_unavailable' }
    return @{ ok = $false; error = $code; server = $serverObservation }
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
  }
}

function Write-HelixServerStateAtomically([string]$StatePath, [object]$State) {
  $temporary = "$StatePath.$([guid]::NewGuid()).tmp"
  try {
    [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $StatePath -Force
  } finally { Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-HelixSavedFabricServer -RunDirectory $ServerRunDirectory -ServerAddress $Address | ConvertTo-Json -Depth 5 -Compress
}
