# scripts/probe.ps1
#
# Runs the search `where` clause probe, signing in first if there is no cached
# token. Exists so the operator types one short command instead of pasting
# multi-line environment assignments -- a paste that arrived mangled once, and
# in a terminal that was rendering some characters as blanks.
#
# Reads only. Issues GET /api/search four times and prints the responses.
#
#   .\scripts\probe.ps1
#   .\scripts\probe.ps1 -Title "Some Other Item Title"

param(
    [string]$Title = "AI for Evidence-Based PT Practice Website"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot\..

Write-Host ""
Write-Host "Probe title: $Title"
Write-Host ""

# The authorization-code flow caches a token per instance. Without one the
# probe cannot authenticate, and no environment variable substitutes for it --
# it authenticates as a PERSON, interactively.
Write-Host "--- Step 1 of 2: signing in (skip the browser step if a token is already cached)"
node --env-file=.env dist/cli/index.js login

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Sign-in did not complete, so the probe was not run." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "--- Step 2 of 2: probing"
$env:OEQ_PROBE_TITLE = $Title
npx tsx --env-file=.env scripts/probe-where.mts
