# Shared Node.js resolver for native Windows CatWrangler entry points.
#
# Resolve-CatWranglerNode validates every PATH candidate in order. For Codex it
# then checks only packaged-runtime layouts adjacent to host-supplied PATH
# entries. It never scans the machine, changes PATH, or persists a result.

Set-StrictMode -Version 2.0

function Test-CatWranglerNode {
  param([Parameter(Mandatory = $true)][string] $Candidate)

  if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
    return $false
  }

  try {
    $version = (& $Candidate --version 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) {
      return $false
    }
  } catch {
    return $false
  }

  $match = [regex]::Match([string] $version, '^v?([0-9]+)(?:\.|$)')
  return $match.Success -and [int] $match.Groups[1].Value -ge 18
}

function Resolve-CatWranglerNode {
  param([string] $HostName = '')

  $pathEntries = @()
  if ($env:PATH) {
    $pathEntries = $env:PATH -split [IO.Path]::PathSeparator |
      ForEach-Object { $_.Trim().Trim('"') } |
      Where-Object { $_ }
  }

  foreach ($entry in $pathEntries) {
    foreach ($name in @('node.exe', 'node')) {
      $candidate = Join-Path $entry $name
      if (Test-CatWranglerNode $candidate) {
        return (Get-Item -LiteralPath $candidate).FullName
      }
    }
  }

  if ($HostName -ne 'codex') {
    return $null
  }

  foreach ($entry in $pathEntries) {
    $candidates = @()

    if ($entry -match '[\\/](?:Resources|resources)$') {
      $candidates += Join-Path $entry 'cua_node\node.exe'
      $candidates += Join-Path $entry 'cua_node\bin\node.exe'
    }

    if ($entry -match '[\\/]dependencies[\\/]bin[\\/](?:override|fallback)$') {
      $dependencies = Split-Path (Split-Path $entry -Parent) -Parent
      $candidates += Join-Path $dependencies 'node\node.exe'
      $candidates += Join-Path $dependencies 'node\bin\node.exe'
    }

    foreach ($candidate in $candidates) {
      if (Test-CatWranglerNode $candidate) {
        return (Get-Item -LiteralPath $candidate).FullName
      }
    }
  }

  return $null
}
