param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs
)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataRoot = Join-Path $repoRoot "data\rag"
$composeFile = Join-Path $dataRoot "compose.yaml"

if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
    throw "Compose file was not found: $composeFile"
}

if (-not $ComposeArgs -or $ComposeArgs.Count -eq 0) {
    $ComposeArgs = @("config", "--quiet")
}

& docker compose --project-directory $dataRoot --file $composeFile @ComposeArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
