param(
  [ValidateRange(1, 200)][int]$MaxDocuments = 25,
  [ValidateRange(0, 5000)][int]$DelayMilliseconds = 300,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path '.').Path
$pagesPath = Join-Path $root 'server/assets/civilization/unga81-official-pages.json'
$manifestPath = Join-Path $root 'server/assets/civilization/unga81-submitted-pdf-manifest.v1.json'
$cacheDir = Join-Path $root '.cache/civilization/unga81-submitted-pdfs'
if (-not (Test-Path -LiteralPath $pagesPath)) { throw 'Official page index is missing.' }
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$pages = (Get-Content -LiteralPath $pagesPath -Raw | ConvertFrom-Json).pages
$prior = @{}
if (Test-Path -LiteralPath $manifestPath) {
  foreach ($entry in (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).entries) {
    $prior[$entry.sourceUrl] = $entry
  }
}
$pdfTool = (Get-Command pdftotext -ErrorAction SilentlyContinue).Source
$infoTool = (Get-Command pdfinfo -ErrorAction SilentlyContinue).Source
if (-not $pdfTool -or -not $infoTool) { throw 'pdftotext and pdfinfo are required to acquire the submitted-PDF text cache.' }

$sources = @($pages | ForEach-Object {
  $page = $_
  foreach ($url in $page.pdfUrls) {
    [pscustomobject]@{ sourceUrl = $url; countryIso3 = $page.countryIso3; label = $page.label; pageUrl = $page.pageUrl }
  }
} | Sort-Object sourceUrl -Unique)
$entries = @()
$processed = 0
foreach ($source in $sources) {
  $url = [string]$source.sourceUrl
  if ($url -notmatch '^https://gadebate\.un\.org/sites/default/files/gastatements/81/[A-Za-z0-9._%-]+\.pdf$') {
    throw "Unexpected PDF URL in official index: $url"
  }
  $urlBytes = [Text.Encoding]::UTF8.GetBytes($url)
  $urlHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($urlBytes)).ToLowerInvariant().Substring(0, 20)
  $pdfPath = Join-Path $cacheDir "$urlHash.pdf"
  $textPath = Join-Path $cacheDir "$urlHash.txt"
  $previous = $prior[$url]
  $needsWork = $Force -or -not (Test-Path -LiteralPath $pdfPath) -or -not (Test-Path -LiteralPath $textPath) -or
    -not $previous -or $previous.status -ne 'available'
  $entry = [ordered]@{
    countryIso3 = $source.countryIso3
    label = $source.label
    pageUrl = $source.pageUrl
    sourceUrl = $url
    status = if ($previous) { $previous.status } else { 'pending' }
    retrievedAt = if ($previous) { $previous.retrievedAt } else { $null }
    pdfSha256 = if ($previous) { $previous.pdfSha256 } else { $null }
    pdfBytes = if ($previous) { $previous.pdfBytes } else { $null }
    pageCount = if ($previous) { $previous.pageCount } else { $null }
    extractedTextSha256 = if ($previous) { $previous.extractedTextSha256 } else { $null }
  }
  if ($needsWork -and $processed -lt $MaxDocuments) {
    $processed++
    $temporary = Join-Path $cacheDir "$urlHash.download"
    try {
      if ($Force -or -not (Test-Path -LiteralPath $pdfPath)) {
        Invoke-WebRequest -Uri $url -OutFile $temporary -TimeoutSec 30
        if ((Get-Item -LiteralPath $temporary).Length -gt 10MB) { throw 'Submitted PDF exceeds the acquisition size limit.' }
        $header = [byte[]]::new(4)
        $stream = [IO.File]::OpenRead($temporary)
        try { $read = $stream.Read($header, 0, 4) } finally { $stream.Dispose() }
        if ($read -ne 4 -or [Text.Encoding]::ASCII.GetString($header) -ne '%PDF') { throw 'Source did not return a PDF.' }
        Move-Item -LiteralPath $temporary -Destination $pdfPath -Force
        $entry.retrievedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        if ($DelayMilliseconds) { Start-Sleep -Milliseconds $DelayMilliseconds }
      }
      & $pdfTool -enc UTF-8 $pdfPath $textPath | Out-Null
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $textPath) -or
          (Get-Item -LiteralPath $textPath).Length -eq 0) { throw 'Text extraction failed.' }
      $info = & $infoTool $pdfPath
      $pagesLine = @($info | Where-Object { $_ -match '^Pages:\s+\d+' } | Select-Object -First 1)
      if (-not $pagesLine.Count) { throw 'PDF page count unavailable.' }
      $entry.status = 'available'
      $entry.pdfSha256 = (Get-FileHash -LiteralPath $pdfPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $entry.pdfBytes = (Get-Item -LiteralPath $pdfPath).Length
      $entry.pageCount = [int]([regex]::Match($pagesLine[0], '\d+').Value)
      $entry.extractedTextSha256 = (Get-FileHash -LiteralPath $textPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
      $entry.status = 'unavailable'
      $entry.pdfSha256 = $null
      $entry.pdfBytes = $null
      $entry.pageCount = $null
      $entry.extractedTextSha256 = $null
    } finally {
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
  }
  $entries += [pscustomobject]$entry
}
$manifest = [ordered]@{
  schemaVersion = 'civilization_unga81_submitted_pdf_manifest/v1'
  sourceKind = 'Official General Debate submitted-PDF links; downloaded text remains in ignored local cache'
  generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  sourceIndex = 'server/assets/civilization/unga81-official-pages.json'
  interpretationLimits = @(
    'Acquisition and text extraction do not verify speech delivery, translation, attribution, or factual claims.'
    'The manifest records only linked PDFs; missing links and unavailable downloads require separate review.'
    'PDFs and extracted text remain in the ignored local cache and are not bundled in this asset.'
  )
  entries = $entries
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
$available = @($entries | Where-Object { $_.status -eq 'available' }).Count
$unavailable = @($entries | Where-Object { $_.status -eq 'unavailable' }).Count
Write-Output "$manifestPath`: $($entries.Count) links, $available available, $unavailable unavailable, $processed attempted this run"
