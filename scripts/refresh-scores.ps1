# Refresh fantasy scores from SofaScore. Intended for Windows Task Scheduler.
# Runs the ingest headless, appending timestamped output to refresh-scores.log
# in the project root. If SofaScore ever 403s here, run the ingest once by hand
# with $env:SOFA_HEADFUL=1 to refresh the Cloudflare clearance, then this
# scheduled run will work again from the saved .sofa-profile.

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $PSScriptRoot         # project root (parent of \scripts)
Set-Location $proj
$log = Join-Path $proj "refresh-scores.log"

"`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') refresh start =====" | Out-File -Append $log
try {
  # --env-file loads .env; node + tsx run the ingest.
  & node --env-file=.env --import tsx scripts/ingest-sofascore.ts *>&1 | Tee-Object -Append $log
  "===== done (exit $LASTEXITCODE) =====" | Out-File -Append $log
} catch {
  "ERROR: $_" | Out-File -Append $log
}
