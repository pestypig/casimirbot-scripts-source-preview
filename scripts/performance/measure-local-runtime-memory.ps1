[CmdletBinding()]
param(
  [string]$Label = "local-runtime",
  [ValidateRange(1, 86400)]
  [int]$DurationSeconds = 60,
  [ValidateRange(1, 300)]
  [int]$IntervalSeconds = 5,
  [ValidateRange(1, 65535)]
  [int]$Port = 1522,
  [string]$OutputDirectory = "artifacts/performance/local-runtime-memory",
  [string[]]$TrackedProcessNames = @(
    "node",
    "esbuild",
    "codex",
    "ChatGPT",
    "msedgewebview2",
    "java",
    "javaw"
  )
)

$ErrorActionPreference = "Stop"

function Convert-ToMiB {
  param([double]$Bytes)
  return [math]::Round($Bytes / 1MB, 2)
}

function Get-ProcessMetrics {
  param(
    [System.Diagnostics.Process[]]$Processes,
    [int[]]$Ids
  )

  $wanted = @{}
  foreach ($id in $Ids) {
    $wanted[[int]$id] = $true
  }

  $results = @()
  foreach ($process in $Processes) {
    if (-not $wanted.ContainsKey([int]$process.Id)) {
      continue
    }
    try {
      $results += [pscustomobject]@{
        pid = [int]$process.Id
        name = [string]$process.ProcessName
        working_set_mb = Convert-ToMiB $process.WorkingSet64
        private_mb = Convert-ToMiB $process.PrivateMemorySize64
        paged_mb = Convert-ToMiB $process.PagedMemorySize64
        handles = [int]$process.HandleCount
        threads = [int]$process.Threads.Count
      }
    } catch {
      # A process can exit between topology and metric collection.
    }
  }
  return @($results | Sort-Object pid)
}

function Get-Totals {
  param([object[]]$ProcessMetrics)

  return [pscustomobject]@{
    process_count = @($ProcessMetrics).Count
    working_set_mb = [math]::Round((@($ProcessMetrics | Measure-Object working_set_mb -Sum).Sum), 2)
    private_mb = [math]::Round((@($ProcessMetrics | Measure-Object private_mb -Sum).Sum), 2)
    paged_mb = [math]::Round((@($ProcessMetrics | Measure-Object paged_mb -Sum).Sum), 2)
  }
}

function Get-NumberStats {
  param([object[]]$Values)

  $numbers = @($Values | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ })
  if ($numbers.Count -eq 0) {
    return [pscustomobject]@{ count = 0; min = $null; max = $null; average = $null; last = $null }
  }
  $measure = $numbers | Measure-Object -Minimum -Maximum -Average
  return [pscustomobject]@{
    count = $numbers.Count
    min = [math]::Round($measure.Minimum, 2)
    max = [math]::Round($measure.Maximum, 2)
    average = [math]::Round($measure.Average, 2)
    last = [math]::Round($numbers[-1], 2)
  }
}

function Get-NumberAverage {
  param([object[]]$Values)

  $numbers = @($Values | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ })
  if ($numbers.Count -eq 0) {
    return $null
  }
  return [math]::Round(($numbers | Measure-Object -Average).Average, 2)
}

function Get-SafeRuntimeMemory {
  param([int]$RuntimePort)

  try {
    $response = Invoke-RestMethod `
      -Method Get `
      -Uri "http://127.0.0.1:$RuntimePort/api/runtime/memory" `
      -TimeoutSec 2
    return [pscustomobject]@{
      available = $true
      pid = $response.pid
      rss_mib = $response.memory.rssMiB
      heap_total_mib = $response.memory.heapTotalMiB
      heap_used_mib = $response.memory.heapUsedMiB
      external_mib = $response.memory.externalMiB
      array_buffers_mib = $response.memory.arrayBuffersMiB
      host_free_mib = $response.host.freeMiB
      pressure_level = $response.pressureLevel
      pressure_reason = $response.pressureReason
    }
  } catch {
    return [pscustomobject]@{
      available = $false
      pid = $null
      rss_mib = $null
      heap_total_mib = $null
      heap_used_mib = $null
      external_mib = $null
      array_buffers_mib = $null
      host_free_mib = $null
      pressure_level = $null
      pressure_reason = $null
    }
  }
}

$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$safeLabel = ($Label -replace "[^A-Za-z0-9._-]", "-").Trim("-")
if (-not $safeLabel) {
  $safeLabel = "local-runtime"
}
$runId = "{0}-{1}" -f $safeLabel, (Get-Date -Format "yyyyMMdd-HHmmss")
$runDirectory = Join-Path $resolvedOutput $runId
[System.IO.Directory]::CreateDirectory($runDirectory) | Out-Null
$jsonlPath = Join-Path $runDirectory "samples.jsonl"
$csvPath = Join-Path $runDirectory "samples.csv"
$summaryPath = Join-Path $runDirectory "summary.json"

$computer = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$hardware = [pscustomobject]@{
  physical_memory_gb = [math]::Round([double]$computer.TotalPhysicalMemory / 1GB, 2)
  logical_processors = [int]$computer.NumberOfLogicalProcessors
  os_caption = [string]$os.Caption
  os_version = [string]$os.Version
}

$sampleCount = [math]::Max(1, [math]::Ceiling($DurationSeconds / $IntervalSeconds))
$samples = New-Object System.Collections.ArrayList
$flatSamples = New-Object System.Collections.ArrayList
$startedAt = Get-Date

for ($index = 0; $index -lt $sampleCount; $index += 1) {
  $capturedAt = Get-Date
  $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $paging = Get-CimInstance Win32_PerfFormattedData_PerfOS_PagingFile |
    Where-Object { $_.Name -eq "_Total" } |
    Select-Object -First 1

  $topology = @(Get-CimInstance Win32_Process |
    Select-Object ProcessId, ParentProcessId, Name)
  $processes = @([System.Diagnostics.Process]::GetProcesses())
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $listenerPid = if ($listener) { [int]$listener.OwningProcess } else { $null }

  $childrenByParent = @{}
  $parentById = @{}
  foreach ($entry in $topology) {
    $pidValue = [int]$entry.ProcessId
    $parentValue = [int]$entry.ParentProcessId
    $parentById[$pidValue] = $parentValue
    if (-not $childrenByParent.ContainsKey($parentValue)) {
      $childrenByParent[$parentValue] = New-Object System.Collections.ArrayList
    }
    [void]$childrenByParent[$parentValue].Add($pidValue)
  }

  $serverIds = New-Object System.Collections.ArrayList
  if ($null -ne $listenerPid) {
    [void]$serverIds.Add($listenerPid)
    for ($cursor = 0; $cursor -lt $serverIds.Count; $cursor += 1) {
      $parentId = [int]$serverIds[$cursor]
      if (-not $childrenByParent.ContainsKey($parentId)) {
        continue
      }
      foreach ($childId in $childrenByParent[$parentId]) {
        if (-not $serverIds.Contains([int]$childId)) {
          [void]$serverIds.Add([int]$childId)
        }
      }
    }
  }

  $ancestorIds = New-Object System.Collections.ArrayList
  if ($null -ne $listenerPid) {
    $ancestorCursor = $listenerPid
    for ($depth = 0; $depth -lt 8; $depth += 1) {
      if (-not $parentById.ContainsKey($ancestorCursor)) {
        break
      }
      $ancestorCursor = [int]$parentById[$ancestorCursor]
      if ($ancestorCursor -le 0 -or $ancestorIds.Contains($ancestorCursor)) {
        break
      }
      [void]$ancestorIds.Add($ancestorCursor)
    }
  }

  $trackedIds = @($processes |
    Where-Object { $TrackedProcessNames -contains $_.ProcessName } |
    ForEach-Object { [int]$_.Id })
  $serverMetrics = Get-ProcessMetrics -Processes $processes -Ids @($serverIds)
  $ancestorMetrics = Get-ProcessMetrics -Processes $processes -Ids @($ancestorIds)
  $trackedMetrics = Get-ProcessMetrics -Processes $processes -Ids $trackedIds
  $serverTotals = Get-Totals $serverMetrics
  $runtimeMemory = Get-SafeRuntimeMemory -RuntimePort $Port

  $sample = [pscustomobject]@{
    schema = "casimir.local_runtime_memory_sample.v1"
    run_id = $runId
    sample_index = $index
    captured_at = $capturedAt.ToString("o")
    elapsed_seconds = [math]::Round(($capturedAt - $startedAt).TotalSeconds, 2)
    system = [pscustomobject]@{
      available_mb = [double]$memory.AvailableMBytes
      committed_mb = Convert-ToMiB ([double]$memory.CommittedBytes)
      commit_limit_mb = Convert-ToMiB ([double]$memory.CommitLimit)
      pages_per_sec = [double]$memory.PagesPersec
      pagefile_usage_percent = if ($paging) { [double]$paging.PercentUsage } else { $null }
    }
    listener_pid = $listenerPid
    server_tree = $serverMetrics
    server_tree_totals = $serverTotals
    launcher_ancestors = $ancestorMetrics
    tracked_processes = $trackedMetrics
    node_runtime = $runtimeMemory
  }
  [void]$samples.Add($sample)

  $flat = [pscustomobject]@{
    run_id = $runId
    sample_index = $index
    captured_at = $capturedAt.ToString("o")
    elapsed_seconds = $sample.elapsed_seconds
    available_mb = $sample.system.available_mb
    committed_mb = $sample.system.committed_mb
    pages_per_sec = $sample.system.pages_per_sec
    pagefile_usage_percent = $sample.system.pagefile_usage_percent
    listener_pid = $listenerPid
    server_process_count = $serverTotals.process_count
    server_working_set_mb = $serverTotals.working_set_mb
    server_private_mb = $serverTotals.private_mb
    node_rss_mib = $runtimeMemory.rss_mib
    node_heap_total_mib = $runtimeMemory.heap_total_mib
    node_heap_used_mib = $runtimeMemory.heap_used_mib
    node_external_mib = $runtimeMemory.external_mib
  }
  [void]$flatSamples.Add($flat)

  [System.IO.File]::AppendAllText(
    $jsonlPath,
    (($sample | ConvertTo-Json -Depth 8 -Compress) + [Environment]::NewLine),
    [System.Text.Encoding]::UTF8
  )

  if ($index + 1 -lt $sampleCount) {
    $nextCaptureAt = $startedAt.AddSeconds(($index + 1) * $IntervalSeconds)
    $waitMilliseconds = [math]::Floor(($nextCaptureAt - (Get-Date)).TotalMilliseconds)
    if ($waitMilliseconds -gt 0) {
      Start-Sleep -Milliseconds $waitMilliseconds
    }
  }
}

$settledCount = [math]::Min(3, $samples.Count)
$settled = @($samples | Select-Object -Last $settledCount)
$summary = [pscustomobject]@{
  schema = "casimir.local_runtime_memory_summary.v1"
  run_id = $runId
  label = $Label
  started_at = $startedAt.ToString("o")
  completed_at = (Get-Date).ToString("o")
  duration_seconds_requested = $DurationSeconds
  interval_seconds = $IntervalSeconds
  sample_count = $samples.Count
  port = $Port
  hardware = $hardware
  metrics = [pscustomobject]@{
    available_mb = Get-NumberStats @($samples | ForEach-Object { $_.system.available_mb })
    committed_mb = Get-NumberStats @($samples | ForEach-Object { $_.system.committed_mb })
    pages_per_sec = Get-NumberStats @($samples | ForEach-Object { $_.system.pages_per_sec })
    server_private_mb = Get-NumberStats @($samples | ForEach-Object { $_.server_tree_totals.private_mb })
    server_working_set_mb = Get-NumberStats @($samples | ForEach-Object { $_.server_tree_totals.working_set_mb })
    node_rss_mib = Get-NumberStats @($samples | ForEach-Object { $_.node_runtime.rss_mib })
    node_heap_used_mib = Get-NumberStats @($samples | ForEach-Object { $_.node_runtime.heap_used_mib })
  }
  settled_last_samples = [pscustomobject]@{
    count = $settledCount
    server_private_mb_average = Get-NumberAverage @(
      $settled | ForEach-Object { $_.server_tree_totals.private_mb }
    )
    server_working_set_mb_average = Get-NumberAverage @(
      $settled | ForEach-Object { $_.server_tree_totals.working_set_mb }
    )
    available_mb_average = Get-NumberAverage @(
      $settled | ForEach-Object { $_.system.available_mb }
    )
  }
  artifacts = [pscustomobject]@{
    samples_jsonl = $jsonlPath
    samples_csv = $csvPath
    summary_json = $summaryPath
  }
}

$flatSamples | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8
[System.IO.File]::WriteAllText(
  $summaryPath,
  ($summary | ConvertTo-Json -Depth 8),
  [System.Text.Encoding]::UTF8
)

$summary | ConvertTo-Json -Depth 8
