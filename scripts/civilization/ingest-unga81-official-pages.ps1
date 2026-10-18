$ErrorActionPreference = 'Stop'
$source = 'https://gadebate.un.org'
$snapshot = Get-Content 'server/assets/civilization/unga81-provisional-transcripts.json' -Raw | ConvertFrom-Json
$codes = @{}
foreach ($meeting in $snapshot.meetings) {
  foreach ($statement in $meeting.statements) {
    $speaker = $statement.speaker
    if ($speaker.affiliationIso3 -and $speaker.affiliationName) {
      $key = $speaker.affiliationName.ToLowerInvariant() -replace '[^a-z]', ''
      $codes[$key] = $speaker.affiliationIso3
    }
  }
}
$aliases = @{
  republicofkorea = 'KOR'
  democraticpeoplesrepublicofkorea = 'PRK'
  unitedstatesofamerica = 'USA'
  unitedkingdomofgreatbritainandnorthernireland = 'GBR'
  stateofpalestine = 'PSE'
  holysee = 'VAT'
  turkiye = 'TUR'
  bahamasthe = 'BHS'
  gambiarepublicofthe = 'GMB'
  naoero = 'NRU'
  palestinestateof = 'PSE'
  europeanunion = 'EUR'
}
[xml]$index = (Invoke-WebRequest -Uri "$source/sitemap.xml" -UseBasicParsing -TimeoutSec 20).Content
$urls = @()
foreach ($site in $index.sitemapindex.sitemap) {
  [xml]$page = (Invoke-WebRequest -Uri $site.loc -UseBasicParsing -TimeoutSec 20).Content
  $urls += @($page.urlset.url.loc | Where-Object { $_ -match '^https://gadebate\.un\.org/en/81/' })
}
$urls = @($urls | Sort-Object -Unique)
if ($urls.Count -lt 190) { throw "Official sitemap listed only $($urls.Count) pages" }
$pages = @()
foreach ($url in $urls) {
  $html = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20).Content
  $title = [regex]::Match($html, '<title>([^<]+)</title>').Groups[1].Value -replace '&amp;', '&'
  $label = $title -replace '\s*\|\s*81st session.*$', ''
  $key = $label.ToLowerInvariant() -replace '[^a-z]', ''
  $code = if ($codes.ContainsKey($key)) { $codes[$key] } elseif ($aliases.ContainsKey($key)) { $aliases[$key] } else { $null }
  $dateMatch = [regex]::Match($html, '<time datetime="(2026-09-\d\d)T')
  $date = if ($dateMatch.Success) { $dateMatch.Groups[1].Value } else { $null }
  $descriptionMatch = [regex]::Match($html, '<meta name="description" content="([^"]*)"')
  $description = if ($descriptionMatch.Success) { $descriptionMatch.Groups[1].Value -replace '&amp;', '&' } else { $null }
  $pdfs = @([regex]::Matches($html, 'href="(/sites/default/files/gastatements/81/[^"?#]+\.pdf)"') |
    ForEach-Object { "$source$($_.Groups[1].Value)" } | Sort-Object -Unique)
  $pages += [pscustomobject]@{
    countryIso3 = $code
    label = $label
    pageUrl = $url
    date = $date
    description = $description
    pdfUrls = $pdfs
    submittedStatementStatus = if ($pdfs.Count) { 'available' } else { 'not_linked' }
  }
}
$asset = [ordered]@{
  schemaVersion = 'civilization_unga81_official_pages/v1'
  sourceKind = 'official General Debate delegation pages and linked submitted PDFs'
  sitemapUrl = "$source/sitemap.xml"
  collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  interpretationLimits = @(
    'A linked PDF is a submitted statement and may differ from the speech as delivered.'
    'Page-to-ISO3 matches use transcript affiliation labels and explicit aliases; unmatched pages need manual reconciliation.'
    'A missing PDF link in this snapshot may reflect publication delay; it does not mean no statement was made.'
  )
  pages = $pages
}
$output = 'server/assets/civilization/unga81-official-pages.json'
$asset | ConvertTo-Json -Depth 8 -Compress | Set-Content -Path $output -Encoding utf8
$matched = @($pages | Where-Object { $_.countryIso3 }).Count
$withPdf = @($pages | Where-Object { $_.pdfUrls.Count }).Count
Write-Output "$output`: $($pages.Count) pages, $matched ISO3 matches, $withPdf pages with PDF links"
