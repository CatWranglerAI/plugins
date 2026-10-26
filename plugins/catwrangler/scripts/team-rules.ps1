# Native Windows half of the team-rules hook (cw:d-4664): PreToolUse and Stop.
# Fail-open: only the adapter's deliberate exit 2 (a rule hit on a worker brief)
# blocks. Any other problem prints {} and exits 0, so a broken hook never stops work.
param(
  [Parameter(Position = 0)]
  [string] $HostName = 'claude'
)

try {
  $teamRulesScript = Join-Path $PSScriptRoot 'team-rules.mjs'
  $teamRulesResolver = Join-Path $PSScriptRoot 'resolve-node.ps1'
  if (-not (Test-Path -LiteralPath $teamRulesScript -PathType Leaf) -or -not (Test-Path -LiteralPath $teamRulesResolver -PathType Leaf)) {
    [Console]::Out.Write('{}')
    exit 0
  }
  . $teamRulesResolver
  $teamRulesNode = Resolve-CatWranglerNode $HostName
  if (-not $teamRulesNode) {
    [Console]::Out.Write('{}')
    exit 0
  }

  $teamRulesPayload = [Console]::In.ReadToEnd()
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $teamRulesNode
  $start.Arguments = '"' + $teamRulesScript + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $start.StandardInputEncoding = $utf8
  $start.StandardOutputEncoding = $utf8
  $start.StandardErrorEncoding = $utf8

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  [void] $process.Start()
  # Read stderr concurrently: a long block message must not stall the child
  # while stdout is being drained.
  $teamRulesErr = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.Write($teamRulesPayload)
  $process.StandardInput.Close()
  $teamRulesOut = $process.StandardOutput.ReadToEnd()
  $process.WaitForExit()

  if ($process.ExitCode -eq 2) {
    [Console]::Error.Write($teamRulesErr.Result)
    exit 2
  }
  if ($process.ExitCode -ne 0 -or [string]::IsNullOrEmpty($teamRulesOut)) {
    $teamRulesOut = '{}'
  }
  [Console]::Out.Write($teamRulesOut)
} catch {
  [Console]::Out.Write('{}')
}
exit 0
