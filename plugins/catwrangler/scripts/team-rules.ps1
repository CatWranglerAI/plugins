# Native Windows half of the team-rules hook (cw:d-4664, cw:d-4743): Stop.
# Fail-open: any problem prints {} and exits 0, so a broken hook never stops work.
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
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $start.StandardInputEncoding = $utf8
  $start.StandardOutputEncoding = $utf8

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  [void] $process.Start()
  $process.StandardInput.Write($teamRulesPayload)
  $process.StandardInput.Close()
  $teamRulesOut = $process.StandardOutput.ReadToEnd()
  $process.WaitForExit()

  if ($process.ExitCode -ne 0 -or [string]::IsNullOrEmpty($teamRulesOut)) {
    $teamRulesOut = '{}'
  }
  [Console]::Out.Write($teamRulesOut)
} catch {
  [Console]::Out.Write('{}')
}
exit 0
