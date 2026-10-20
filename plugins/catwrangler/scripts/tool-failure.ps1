# Native Windows half of Claude's dot-sourced PostToolUseFailure basename (cw:d-4453).
# Fail-soft: any problem prints {} so a failed call never gains a broken-hook notice.
# There is no power log to read on Windows; the note simply omits sleep.

try {
  $toolFailureScript = Join-Path $PSScriptRoot 'tool-failure.mjs'
  $toolFailureNode = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
  if (-not (Test-Path $toolFailureScript)) { [Console]::Out.Write('{}'); exit 0 }
  $toolFailurePayload = [Console]::In.ReadToEnd()
  $toolFailureOut = $toolFailurePayload | & $toolFailureNode.Source $toolFailureScript 2>$null
  if ($toolFailureOut) { [Console]::Out.Write(($toolFailureOut -join "`n")) } else { [Console]::Out.Write('{}') }
} catch {
  [Console]::Out.Write('{}')
}
exit 0
