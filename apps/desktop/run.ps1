param(
    [ValidateSet("dev", "build", "preview")]
    [string]$Mode = "dev"
)

$desktopRoot = Resolve-Path $PSScriptRoot
Push-Location $desktopRoot
try {
    npm run $Mode
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
