# Workspace-management launcher for native Windows.
param(
  [Parameter(Position = 0)]
  [string] $HostName,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]] $ManageArguments
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ($HostName -notin @('claude', 'codex')) {
  [Console]::Error.WriteLine('CatWrangler plugin: manage.ps1 requires an explicit claude or codex host.')
  exit 2
}

$resolver = Join-Path $PSScriptRoot 'resolve-node.ps1'
if (-not (Test-Path -LiteralPath $resolver -PathType Leaf)) {
  [Console]::Error.WriteLine('CatWrangler plugin: the Node.js runtime resolver is missing; reinstall the plugin.')
  exit 1
}

. $resolver
$node = Resolve-CatWranglerNode $HostName

if (-not $node) {
  if ($HostName -eq 'codex') {
    [Console]::Error.WriteLine('CatWrangler plugin: no compatible Node.js 18+ runtime was found. Codex Desktop automatically checks its compatible bundled runtime; standalone Codex CLI/IDE may require Node 18+ on PATH. Install Node 18+ or make an existing installation visible to Codex, then retry.')
  } else {
    [Console]::Error.WriteLine('CatWrangler plugin: no compatible Node.js 18+ runtime was found on PATH. Claude Code may require Node 18+; install it or make an existing installation visible to Claude Code, then retry.')
  }
  exit 1
}

$manage = Join-Path $PSScriptRoot 'manage.mjs'
if (-not (Test-Path -LiteralPath $manage -PathType Leaf)) {
  [Console]::Error.WriteLine('CatWrangler plugin: the workspace management script is missing; reinstall the plugin.')
  exit 1
}

& $node $manage @ManageArguments
exit $LASTEXITCODE
