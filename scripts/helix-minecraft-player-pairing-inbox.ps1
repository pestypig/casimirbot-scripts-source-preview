param(
    [Parameter(Mandatory = $false)]
    [string]$MinecraftRoot = (Join-Path $env:APPDATA '.minecraft')
)

$ErrorActionPreference = 'Stop'
$inboxName = 'helix-fabric-player-agent.pairing-inbox'
$commandText = [Console]::In.ReadToEnd().Trim()
$commandBytes = [System.Text.Encoding]::UTF8.GetByteCount($commandText)

if ($commandBytes -eq 0 -or $commandBytes -gt 512) {
    throw 'player_pairing_inbox_size_invalid'
}
if (
    $commandText -notmatch
    '^/helix-player\s+pair\s+[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}(?:\s+\S+)?\s*$'
) {
    throw 'player_pairing_inbox_command_invalid'
}

$resolvedRoot = [System.IO.Path]::GetFullPath($MinecraftRoot)
$configDirectory = Join-Path $resolvedRoot 'config'
[System.IO.Directory]::CreateDirectory($configDirectory) | Out-Null
$resolvedConfig = [System.IO.Path]::GetFullPath($configDirectory)
if (-not $resolvedConfig.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'player_pairing_inbox_path_invalid'
}

$inboxPath = Join-Path $resolvedConfig $inboxName
$pendingPath = Join-Path $resolvedConfig ($inboxName + '.pending.' + $PID)
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

try {
    [System.IO.File]::WriteAllText($pendingPath, $commandText, $utf8WithoutBom)
    if (Test-Path -LiteralPath $inboxPath) {
        Remove-Item -LiteralPath $inboxPath -Force
    }
    Move-Item -LiteralPath $pendingPath -Destination $inboxPath
} finally {
    if (Test-Path -LiteralPath $pendingPath) {
        Remove-Item -LiteralPath $pendingPath -Force
    }
    $commandText = $null
}

Write-Output 'player_pairing_inbox_staged'
