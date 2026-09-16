# Native Windows half of Claude's dot-sourced SubagentStart basename.
# Keep all runtime selection and hook output behavior in session-start.ps1.

& (Join-Path $PSScriptRoot 'session-start.ps1') claude subagent-start.mjs SubagentStart
exit $LASTEXITCODE
