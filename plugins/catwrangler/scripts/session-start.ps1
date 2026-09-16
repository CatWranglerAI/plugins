# Native Windows launcher for CatWrangler SessionStart and SubagentStart hooks.
# Always exits 0: a plugin bootstrap failure must never block the session.
param(
  [Parameter(Position = 0)]
  [string] $HostName = 'claude',

  [Parameter(Position = 1)]
  [string] $Adapter = 'session-start.mjs',

  [Parameter(Position = 2)]
  [string] $EventName = 'SessionStart'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-CatWranglerHookResult {
  param(
    [Parameter(Mandatory = $true)][string] $UserNotice,
    [Parameter(Mandatory = $true)][string] $ModelContext
  )

  [Console]::Error.WriteLine($UserNotice)
  $specific = [ordered]@{
    hookEventName = $EventName
    additionalContext = $ModelContext
  }
  $result = [ordered]@{ hookSpecificOutput = $specific }
  if ($EventName -eq 'SessionStart') {
    $result = [ordered]@{
      systemMessage = $UserNotice
      hookSpecificOutput = $specific
    }
  }

  [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
  exit 0
}

$resolver = Join-Path $PSScriptRoot 'resolve-node.ps1'
if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
  $notice = [Environment]::NewLine + [Environment]::NewLine + 'CatWrangler plugin: the Node.js runtime resolver is missing from the plugin directory.' + [Environment]::NewLine + '  - The session bootstrap did not run - reinstall the plugin.'
  $context = "The CatWrangler $EventName runtime resolver is missing, so the workspace bootstrap was skipped. Call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."
  Write-CatWranglerHookResult $notice $context
}

. $resolver
$node = Resolve-CatWranglerNode $HostName
if (-not $node) {
  if ($HostName -eq 'codex') {
    $notice = [Environment]::NewLine + [Environment]::NewLine + 'CatWrangler plugin: no compatible Node.js 18+ runtime was available, so the session bootstrap did not run.' + [Environment]::NewLine + '  - The plugin checked working Node 18+ executables on PATH and compatible runtimes exposed by Codex Desktop.' + [Environment]::NewLine + '  - Standalone Codex CLI/IDE may require Node 18+ from https://nodejs.org.' + [Environment]::NewLine + '  - Until then, connect manually by calling the catwrangler MCP server init_session tool.'
    $context = "The CatWrangler $EventName hook found no compatible Node.js 18+ runtime after checking PATH and the best-effort Codex Desktop bundled-runtime layouts. The usual workspace bootstrap was skipped. You can still work now: call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."
  } else {
    $notice = [Environment]::NewLine + [Environment]::NewLine + 'CatWrangler plugin: no compatible Node.js 18+ runtime was found on PATH, so the session bootstrap did not run.' + [Environment]::NewLine + '  - Claude Code may require Node 18+ from https://nodejs.org.' + [Environment]::NewLine + '  - If Node 18+ already works in a terminal, make it available from the non-interactive login profile, then start a new session.' + [Environment]::NewLine + '  - Until then, connect manually by calling the catwrangler MCP server init_session tool.'
    $context = "The CatWrangler $EventName hook found no compatible Node.js 18+ runtime on PATH, so the workspace bootstrap was skipped. Tell the user Claude Code may require Node 18+ and that an installed runtime must be visible through the non-interactive login profile. You can still work now: call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."
  }
  Write-CatWranglerHookResult $notice $context
}

$hook = Join-Path $PSScriptRoot $Adapter
if (-not (Test-Path -LiteralPath $hook -PathType Leaf)) {
  $notice = [Environment]::NewLine + [Environment]::NewLine + 'CatWrangler plugin: the session bootstrap script is missing from the plugin directory.' + [Environment]::NewLine + '  - The session bootstrap did not run - reinstall the plugin.'
  $context = "The CatWrangler $EventName hook script is missing, so the workspace bootstrap was skipped. Call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."
  Write-CatWranglerHookResult $notice $context
}

try {
  $payload = [Console]::In.ReadToEnd()
  $workingDirectory = $null

  if (-not [string]::IsNullOrWhiteSpace($payload)) {
    try {
      $inputObject = $payload | ConvertFrom-Json
      $cwdProperty = $inputObject.PSObject.Properties['cwd']
      if ($cwdProperty -and $cwdProperty.Value -and (Test-Path -LiteralPath ([string] $cwdProperty.Value) -PathType Container)) {
        $workingDirectory = [string] $cwdProperty.Value
      }
    } catch {
      # Invalid hook input is handled by the Node adapter; retain the raw bytes.
    }
  }

  if (-not $workingDirectory -and $env:CLAUDE_PROJECT_DIR -and (Test-Path -LiteralPath $env:CLAUDE_PROJECT_DIR -PathType Container)) {
    $workingDirectory = $env:CLAUDE_PROJECT_DIR
  }

  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $node
  $start.Arguments = '"' + $hook + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  if ($workingDirectory) {
    $start.WorkingDirectory = $workingDirectory
  }
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
  $process.StandardInput.Write($payload)
  $process.StandardInput.Close()
  $output = $process.StandardOutput.ReadToEnd()
  [void] $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $status = $process.ExitCode
} catch {
  $status = 1
  $output = ''
}

if ($status -ne 0) {
  $notice = [Environment]::NewLine + [Environment]::NewLine + 'CatWrangler plugin: the session bootstrap hook failed to run under Node.' + [Environment]::NewLine + '  - Node may be too old - Node 18+ is required.' + [Environment]::NewLine + '  - The session continues without the CatWrangler project menu.'
  $context = "The CatWrangler $EventName hook exited with an error, so the workspace bootstrap was skipped. Call the catwrangler MCP server init_session tool yourself and follow the protocol it returns."
  Write-CatWranglerHookResult $notice $context
}

if ([string]::IsNullOrEmpty($output)) {
  $output = '{}'
}

[Console]::Out.Write($output)
exit 0
