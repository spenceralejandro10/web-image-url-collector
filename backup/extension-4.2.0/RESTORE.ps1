$ErrorActionPreference = "Stop"

$ExpectedSha256 = "0662f180fff252369ee4023451595832fcae23c06ca194903e3b3160b7e6c8ef"
$ZipName = "web-media-collector-4.2-spencer-collector-pro-final.zip"
$ZipPath = Join-Path $PSScriptRoot $ZipName
$OutputDir = Join-Path $PSScriptRoot "restored-4.2.0"

$Parts = Get-ChildItem -Path $PSScriptRoot -Filter "web-media-collector-4.2.0.zip.b64.part*" | Sort-Object Name
if ($Parts.Count -ne 7) {
  throw "Respaldo incompleto: se esperaban 7 partes y se encontraron $($Parts.Count)."
}

$Base64 = -join ($Parts | ForEach-Object { Get-Content $_.FullName -Raw })
$Bytes = [Convert]::FromBase64String($Base64)
[IO.File]::WriteAllBytes($ZipPath, $Bytes)

$ActualSha256 = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSha256 -ne $ExpectedSha256) {
  Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
  throw "Checksum inválido. Esperado: $ExpectedSha256. Obtenido: $ActualSha256"
}

if (Test-Path $OutputDir) {
  Remove-Item $OutputDir -Recurse -Force
}
Expand-Archive -Path $ZipPath -DestinationPath $OutputDir -Force

Write-Host "OK: respaldo 4.2.0 reconstruido y verificado."
Write-Host "ZIP: $ZipPath"
Write-Host "Carpeta: $OutputDir"
