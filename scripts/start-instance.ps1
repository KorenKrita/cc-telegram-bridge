param(
  [string]$Instance = "default"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

npm start -- telegram service start --instance $Instance
