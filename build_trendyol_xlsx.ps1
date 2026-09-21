$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$template = Join-Path $root 'urun-olusturma-1416362.xlsx'
$outputDir = Join-Path $root 'outputs'
$output = Join-Path $outputDir 'trendyol-urun-yukleme-2026-09-20.xlsx'
$products = Get-Content -Raw (Join-Path $env:TEMP 'printable-products.json') | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -LiteralPath $template -Destination $output -Force

function Xml([string]$value) { [Security.SecurityElement]::Escape($value) }
function Cell([string]$col, [int]$row, $value) {
  if ($null -eq $value -or $value -eq '') { return '' }
  if ($value -is [int] -or $value -is [double] -or $value -is [decimal]) { return "<c r=`"$col$row`"><v>$value</v></c>" }
  return "<c r=`"$col$row`" t=`"inlineStr`"><is><t>$(Xml ([string]$value))</t></is></c>"
}
function Get-Ean13([int]$productId) {
  $base = '869' + $productId.ToString('D9'); $sum = 0
  for ($i = 0; $i -lt 12; $i++) { $sum += if (($i % 2) -eq 0) { [int][string]$base[$i] } else { 3 * [int][string]$base[$i] } }
  return $base + ((10 - ($sum % 10)) % 10)
}
function Price($p) { if ($p.scales -and $p.scales.Count) { return [decimal](($p.scales | ForEach-Object { [decimal]$_.price } | Measure-Object -Minimum).Minimum) }; if ($null -ne $p.sale_price -and [decimal]$p.sale_price -gt 0) { return [decimal]$p.sale_price }; return [decimal]$p.price }
function Color($p) { $colors = @($p.colors | ForEach-Object { $_.name } | Where-Object { $_ }); if ($colors.Count -eq 1) { return $colors[0] }; return 'Çok Renkli' }
function Images($p) { return @((@($p.image_path) + @($p.images | ForEach-Object { $_.image_path })) | Where-Object { $_ } | Select-Object -Unique | Select-Object -First 8 | ForEach-Object { if ($_ -match '^https?://') { $_ } else { "https://www.printable.com.tr$_" } }) }

$maps = @(
  @{ Id=833; Name='Figür(833)'; File='xl/worksheets/sheet9.xml'; IDs=@(50,29,28,26,21,19,17,12,10,6); Attr=@{} },
  @{ Id=2840; Name='Anahtarlık(2840)'; File='xl/worksheets/sheet11.xml'; IDs=@(54,38,36,33,24,22,18,13,9,5); Attr=@{'Renk'='Renk';'Web Color'='Web Color';'Kutu Durumu'='Kutu yok';'Menşei'='TR'} },
  @{ Id=1015; Name='Diger Oyuncaklar(1015)'; IDs=@(53,52,51,49,48,47,46,45,44,43,42,41,40,39,35,16,7); Attr=@{'Yaş'='10+ Yaş';'Renk'='Renk';'Web Color'='Web Color';'Menşei'='TR'} },
  @{ Id=3618; Name='Duduk(3618)'; IDs=@(15,14,11); Attr=@{'Renk'='Renk';'Web Color'='Web Color';'Menşei'='TR'} },
  @{ Id=4937; Name='Tuvalet Kagitligi(4937)'; IDs=@(37); Attr=@{'Renk'='Renk';'Web Color'='Web Color';'Materyal'='Plastik';'Menşei'='TR'} },
  @{ Id=5468; Name='Diger Yazici Sarf(5468)'; IDs=@(34); Attr=@{'Renk'='Renk';'Web Color'='Web Color'} },
  @{ Id=1511; Name='Kalemlik(1511)'; IDs=@(30); Attr=@{'Materyal'='Plastik';'Menşei'='TR'} },
  @{ Id=4973; Name='Makyaj Aplikatorleri(4973)'; IDs=@(27); Attr=@{'Renk'='Renk';'Web Color'='Web Color'} },
  @{ Id=5206; Name='Sise Acacagi(5206)'; IDs=@(31); Attr=@{'Renk'='Renk';'Web Color'='Web Color';'Menşei'='TR'} },
  @{ Id=1881; Name='Vazo(1881)'; IDs=@(23); Attr=@{'Materyal'='Plastik';'Yükseklik'='Belirtilmemiş';'Parça Sayısı'='1 Parça';'Renk'='Renk';'Web Color'='Web Color';'Menşei'='TR'} },
  @{ Id=2710; Name='Tepsi(2710)'; IDs=@(20); Attr=@{'Parça Sayısı'='1 Parça';'Materyal'='Plastik';'Web Color'='Web Color';'Boyut/Ebat'='Belirtilmemiş';'Renk'='Renk';'Menşei'='TR'} }
)

function ProductRows($map, [int]$attrStart) {
  $items = @($products | Where-Object { $map.IDs -contains [int]$_.id })
  $rows = @(); $row = 3
  foreach ($p in $items) {
    $price = [math]::Round([double]((Price $p) * 1.22), 2)
    $model = if ($p.sku) { [string]$p.sku } else { "PRINTABLE-$($p.id)" }
    $cells = @(
      (Cell 'A' $row (Get-Ean13 ([int]$p.id))),(Cell 'B' $row $model),(Cell 'D' $row $map.Id),(Cell 'E' $row 'TRY'),
      (Cell 'F' $row $p.name),(Cell 'G' $row $p.description),(Cell 'H' $row $price),(Cell 'I' $row $price),(Cell 'J' $row ([int]$p.stock)),
      (Cell 'K' $row $model),(Cell 'L' $row 20),(Cell 'M' $row 0),(Cell 'N' $row 1),(Cell 'X' $row 3),(Cell 'Y' $row 'Hızlı Teslimat')
    )
    $imageIndex = 0; foreach ($image in (Images $p)) { $letter = [char]([int][char]'P' + $imageIndex); $cells += Cell ([string]$letter) $row $image; $imageIndex++ }
    if ($map.Id -eq 833) { $cells += Cell 'AI' $row 'TR' }
    if ($map.Id -eq 2840) { $cells += Cell 'Z' $row (Color $p); $cells += Cell 'AG' $row 'TR'; $cells += Cell 'AO' $row (Color $p); $cells += Cell 'AQ' $row 'Kutu yok' }
    $index = 0; foreach ($attribute in $map.Attr.Keys) {
      if ($map.Id -eq 2840) { continue }
      $value = $map.Attr[$attribute]; if ($value -eq 'Renk' -or $value -eq 'Web Color') { $value = Color $p }
      $column = [char]([int][char]'A' + (($attrStart - 1 + $index) % 26)); $prefix = if (($attrStart - 1 + $index) -ge 26) { [char]([int][char]'A' + [int][math]::Floor(($attrStart - 1 + $index) / 26) - 1) } else { '' }
      $cells += Cell "$prefix$column" $row $value; $index++
    }
    $rows += "<row r=`"$row`">$($cells -join '')</row>"; $row++
  }
  return $rows -join ''
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip = [IO.Compression.ZipFile]::Open($output, [IO.Compression.ZipArchiveMode]::Update)
try {
  $sourceEntry = $zip.GetEntry('xl/worksheets/sheet9.xml'); $reader = [IO.StreamReader]::new($sourceEntry.Open()); $sourceXml = $reader.ReadToEnd(); $reader.Close()
  function ReplaceEntry([string]$path, [string]$content) { $old = $zip.GetEntry($path); if ($old) { $old.Delete() }; $entry = $zip.CreateEntry($path); $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false)); $writer.Write($content); $writer.Close() }
  function SheetXml($map, [string]$baseXml, [int]$attrStart) {
    $items = @($products | Where-Object { $map.IDs -contains [int]$_.id }); $last = 2 + $items.Count
    $xml = $baseXml -replace 'ref="A1:AN2"', "ref=`"A1:AZ$last`""
    $xml = $xml -replace '<c r="D2" s="[^"]+" t="s"><v>[^<]+</v></c>', "<c r=`"D2`"><v>$($map.Id)</v></c>"
    if ($map.Id -ne 833 -and $map.Id -ne 2840) { $i=0; $headers=''; foreach($attribute in $map.Attr.Keys) { $column = [char]([int][char]'A' + (($attrStart - 1 + $i) % 26)); $prefix = if (($attrStart - 1 + $i) -ge 26) { [char]([int][char]'A' + [int][math]::Floor(($attrStart - 1 + $i) / 26) - 1) } else { '' }; $headers += "<c r=`"$prefix$column`1`" t=`"inlineStr`"><is><t>$(Xml $attribute)</t></is></c>"; $i++ }; $xml = $xml -replace '</row></sheetData>', "$headers</row></sheetData>" }
    return $xml -replace '</sheetData>', "$(ProductRows $map $attrStart)</sheetData>"
  }
  ReplaceEntry 'xl/worksheets/sheet9.xml' (SheetXml $maps[0] $sourceXml 41)
  $keyEntry=$zip.GetEntry('xl/worksheets/sheet11.xml');$reader=[IO.StreamReader]::new($keyEntry.Open());$keyXml=$reader.ReadToEnd();$reader.Close();ReplaceEntry 'xl/worksheets/sheet11.xml' (SheetXml $maps[1] $keyXml 41)
  $workbookEntry=$zip.GetEntry('xl/workbook.xml');$reader=[IO.StreamReader]::new($workbookEntry.Open());$workbookXml=$reader.ReadToEnd();$reader.Close()
  $relEntry=$zip.GetEntry('xl/_rels/workbook.xml.rels');$reader=[IO.StreamReader]::new($relEntry.Open());$relXml=$reader.ReadToEnd();$reader.Close()
  $typesEntry=$zip.GetEntry('[Content_Types].xml');$reader=[IO.StreamReader]::new($typesEntry.Open());$typesXml=$reader.ReadToEnd();$reader.Close()
  $sheetId=13; $relId=13; $fileId=13
  foreach($map in $maps | Select-Object -Skip 2) { $path="xl/worksheets/sheet$fileId.xml"; ReplaceEntry $path (SheetXml $map $sourceXml 41); $sheetTag="<sheet name=`"$(Xml $map.Name)`" sheetId=`"$sheetId`" r:id=`"rId$relId`"/>"; $workbookXml=$workbookXml -replace '</sheets>', "$sheetTag</sheets>"; $relTag="<Relationship Id=`"rId$relId`" Target=`"worksheets/sheet$fileId.xml`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet`"/>"; $relXml=$relXml -replace '</Relationships>', "$relTag</Relationships>"; $typeTag="<Override PartName=`"/xl/worksheets/sheet$fileId.xml`" ContentType=`"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml`"/>"; $typesXml=$typesXml -replace '</Types>', "$typeTag</Types>"; $sheetId++;$relId++;$fileId++ }
  ReplaceEntry 'xl/workbook.xml' $workbookXml; ReplaceEntry 'xl/_rels/workbook.xml.rels' $relXml; ReplaceEntry '[Content_Types].xml' $typesXml
} finally { $zip.Dispose() }

Write-Output $output
