# Render the saved specification in a new, document-free WPS automation instance.
$ErrorActionPreference = 'Stop'
$loomaProject = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$loomaRender = Join-Path $loomaProject 'tmp\docs-v5'
New-Item -ItemType Directory -Path $loomaRender -Force | Out-Null
$loomaSource = Join-Path $loomaProject 'docs\Looma(灵犀胶囊)_ToB与ToC商业化产品全景规格书.docx'
$loomaPdf = Join-Path $loomaRender 'Looma-v5-specification.pdf'
$loomaWps = New-Object -ComObject KWPS.Application
$loomaDocument = $null
$loomaOwnInstance = $loomaWps.Documents.Count -eq 0
try {
  if (-not $loomaOwnInstance) { throw 'WPS automation attached to a populated instance; rendering stopped to preserve open documents.' }
  $loomaWps.Visible = $false
  $loomaWps.DisplayAlerts = 0
  $loomaDocument = $loomaWps.Documents.Open($loomaSource, $false, $true)
  $loomaDocument.ExportAsFixedFormat($loomaPdf, 17)
  Write-Output $loomaPdf
} finally {
  if ($null -ne $loomaDocument) { $loomaDocument.Close($false) }
  if ($loomaOwnInstance) { $loomaWps.Quit() }
}
& pdftoppm -r 100 -png $loomaPdf (Join-Path $loomaRender 'page')
if ($LASTEXITCODE -ne 0) { throw 'PDF page rendering failed.' }
