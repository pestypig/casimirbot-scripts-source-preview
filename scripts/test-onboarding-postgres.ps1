param(
  [ValidateSet('onboarding', 'ar2h-migrations')]
  [string]$Suite = 'onboarding'
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureSuffix = [Guid]::NewGuid().ToString('N')
$fixtureName = "casimir-onboarding-pg-$fixtureSuffix"
$fixtureDatabase = "casimir_onboarding_fixture_$fixtureSuffix"
$fixtureImage = 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
$fixtureDirectory = Join-Path $workspace '.tmp'
$fixtureEnvFile = Join-Path $fixtureDirectory "$fixtureName.env"
$previousFixtureUrl = $env:CASIMIR_ONBOARDING_POSTGRES_TEST_URL
$containerId = $null
$testExit = 1

# This runner owns only a labelled temporary database on the local Docker
# engine. It never reads the application's DATABASE_URL or native credentials.
$dockerEndpoint = (& docker context inspect --format '{{.Endpoints.docker.Host}}').Trim()
if ($LASTEXITCODE -ne 0 -or $dockerEndpoint -ne 'npipe:////./pipe/dockerDesktopLinuxEngine') {
  throw 'Expected the local Docker Desktop Linux engine.'
}
& docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Local Docker Desktop Linux engine is unavailable; no fixture or credential file was created.'
}
New-Item -ItemType Directory -Force -Path $fixtureDirectory | Out-Null
$fixturePassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllLines($fixtureEnvFile, @(
  'POSTGRES_USER=onboarding_fixture', "POSTGRES_PASSWORD=$fixturePassword", "POSTGRES_DB=$fixtureDatabase"
), [Text.UTF8Encoding]::new($false))
Push-Location -LiteralPath $workspace
try {
  $containerId = (& docker run --detach --rm --name $fixtureName `
    --label "casimir.onboarding.fixture=$fixtureSuffix" --memory=384m --cpus=1 --pids-limit=64 `
    --shm-size=64m --tmpfs '/var/lib/postgresql/data:rw,size=256m' `
    --env-file $fixtureEnvFile --publish '127.0.0.1::5432' $fixtureImage `
    -c shared_buffers=16MB -c max_connections=12).Trim()
  if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') { throw 'Fixture creation failed.' }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker exec $containerId pg_isready -U onboarding_fixture -d $fixtureDatabase *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Fixture PostgreSQL did not become ready.' }
  $fixtureAddress = (& docker port $containerId '5432/tcp').Trim()
  if ($LASTEXITCODE -ne 0 -or $fixtureAddress -notmatch '^127\.0\.0\.1:(\d+)$') {
    throw 'Fixture must publish only to loopback.'
  }
  $fixturePort = $Matches[1]
  $env:CASIMIR_ONBOARDING_POSTGRES_TEST_URL = "postgresql://onboarding_fixture:${fixturePassword}@127.0.0.1:${fixturePort}/${fixtureDatabase}"
  Write-Output "Isolated onboarding fixture: $fixtureImage; memory=384MiB; loopback only; temporary database."
  & docker exec $containerId postgres --version
  if ($LASTEXITCODE -ne 0) { throw 'Fixture version inspection failed.' }
  $fixtureTestFile = if ($Suite -eq 'ar2h-migrations') {
    'tests/integration/ar2h-migrations-postgres.spec.ts'
  } else {
    'tests/integration/onboarding-postgres.spec.ts'
  }
  & npx.cmd vitest run $fixtureTestFile --pool=forks --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --reporter=verbose
  $testExit = $LASTEXITCODE
} finally {
  $env:CASIMIR_ONBOARDING_POSTGRES_TEST_URL = $previousFixtureUrl
  if ($containerId -match '^[a-f0-9]{64}$') {
    $fixtureLabels = & docker inspect --format '{{json .Config.Labels}}' $containerId
    if ($LASTEXITCODE -ne 0 -or ($fixtureLabels | ConvertFrom-Json).'casimir.onboarding.fixture' -ne $fixtureSuffix) {
      throw 'Fixture identity changed; refusing cleanup.'
    }
    & docker stop --timeout 5 $containerId | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture cleanup failed.' }
    Write-Output 'Removed the owned fixture container and its temporary database.'
  }
  if (Test-Path -LiteralPath $fixtureEnvFile) { Remove-Item -LiteralPath $fixtureEnvFile }
  Pop-Location
}
exit $testExit
