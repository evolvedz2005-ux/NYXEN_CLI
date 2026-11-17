# install.ps1 — instala NYXEN_CLI desde GitHub
# Uso: irm https://raw.githubusercontent.com/evolvedz2005-ux/NYXEN_CLI/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js no está instalado. Instalando Node.js LTS con winget...'
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

$nodeVersion = (& node --version).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) {
  throw "NYXEN_CLI necesita Node.js 20 o superior. Tenés $nodeVersion."
}

npm install -g "github:evolvedz2005-ux/NYXEN_CLI"
Write-Host ''
Write-Host 'Listo. Abrí una terminal nueva y escribí: nyxen'
