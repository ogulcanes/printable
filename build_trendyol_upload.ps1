$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$template = Join-Path $root 'urun-olusturma-1416362.xlsx'
$outputDir = Join-Path $root 'outputs'
$output = Join-Path $outputDir 'trendyol-urun-yukleme-2026-09-20.xlsx'
$products = Get-Content -Raw (Join-Path $env:TEMP 'printable-products.json') | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -LiteralPath $template -Destination $output -Force
Unblock-File -LiteralPath $output

function Get-Ean13([int]$productId) {
  $base = '869' + $productId.ToString('D9')
  $sum = 0
  for ($index = 0; $index -lt 12; $index++) {
    $digit = [int][string]$base[$index]
    $sum += if (($index % 2) -eq 0) { $digit } else { $digit * 3 }
  }
  return $base + ((10 - ($sum % 10)) % 10)
}

function Get-EffectivePrice($product) {
  if ($product.scales -and $product.scales.Count -gt 0) {
    return [decimal](($product.scales | ForEach-Object { [decimal]$_.price } | Measure-Object -Minimum).Minimum)
  }
  if ($null -ne $product.sale_price -and [decimal]$product.sale_price -gt 0) { return [decimal]$product.sale_price }
  return [decimal]$product.price
}

function Get-Color($product) {
  $colors = @($product.colors | ForEach-Object { $_.name } | Where-Object { $_ })
  if ($colors.Count -eq 1) { return $colors[0] }
  return 'Çok Renkli'
}

function Get-Images($product) {
  $paths = @($product.image_path) + @($product.images | ForEach-Object { $_.image_path })
  return @($paths | Where-Object { $_ } | Select-Object -Unique | Select-Object -First 8 | ForEach-Object {
    if ($_ -match '^https?://') { $_ } else { "https://www.printable.com.tr$_" }
  })
}

$maps = @(
  @{ Id = 833; Name = 'Figür(833)'; Selector = { param($p) @(50,29,28,26,21,19,17,12,10,6) -contains [int]$p.id }; Attributes = @{} },
  @{ Id = 2840; Name = 'Anahtarlık(2840)'; Selector = { param($p) @(54,38,36,33,24,22,18,13,9,5) -contains [int]$p.id }; Attributes = @{ 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p }; 'Kutu Durumu' = { param($p) 'Kutu yok' }; 'Menşei' = { param($p) 'TR' } } },
  @{ Id = 1015; Name = 'Diğer Oyuncaklar(1015)'; Selector = { param($p) @(53,52,51,49,48,47,46,45,44,43,42,41,40,39,35,16,7) -contains [int]$p.id }; Attributes = @{ 'Yaş' = { param($p) '10+ Yaş' }; 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p }; 'Menşei' = { param($p) 'TR' } } },
  @{ Id = 3618; Name = 'Düdük(3618)'; Selector = { param($p) @(15,14,11) -contains [int]$p.id }; Attributes = @{ 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p }; 'Menşei' = { param($p) 'TR' } } },
  @{ Id = 4937; Name = 'Tuvalet Kağıtlığı(4937)'; Selector = { param($p) [int]$p.id -eq 37 }; Attributes = @{ 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p }; 'Materyal' = { param($p) 'Plastik' }; 'Menşei' = { param($p) 'TR' } } },
  @{ Id = 5468; Name = 'Diğer Yazıcı Sarf(5468)'; Selector = { param($p) [int]$p.id -eq 34 }; Attributes = @{ 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p } } },
  @{ Id = 1511; Name = 'Kalemlik(1511)'; Selector = { param($p) [int]$p.id -eq 30 }; Attributes = @{ 'Materyal' = { param($p) 'Plastik' }; 'Menşei' = { param($p) 'TR' } } },
  @{ Id = 4973; Name = 'Makyaj Aplikatörleri(4973)'; Selector = { param($p) [int]$p.id -eq 27 }; Attributes = @{ 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p } } },
  @{ Id = 5206; Name = 'Şişe Açacağı(5206)'; Selector = { param($p) [int]$p.id -eq 31 }; Attributes = @{ 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p }; 'Menşei' = { param($p) 'TR' } } },
  @{ Id = 1881; Name = 'Vazo(1881)'; Selector = { param($p) [int]$p.id -eq 23 }; Attributes = @{ 'Materyal' = { param($p) 'Plastik' }; 'Yükseklik' = { param($p) 'Belirtilmemiş' }; 'Parça Sayısı' = { param($p) '1 Parça' }; 'Renk' = { param($p) Get-Color $p }; 'Web Color' = { param($p) Get-Color $p }; 'Menşei' = { param($p) 'TR' } } },
  @{ Id = 2710; Name = 'Tepsi(2710)'; Selector = { param($p) [int]$p.id -eq 20 }; Attributes = @{ 'Parça Sayısı' = { param($p) '1 Parça' }; 'Materyal' = { param($p) 'Plastik' }; 'Web Color' = { param($p) Get-Color $p }; 'Boyut/Ebat' = { param($p) 'Belirtilmemiş' }; 'Renk' = { param($p) Get-Color $p }; 'Menşei' = { param($p) 'TR' } } }
)

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$scriptError = $null
try {
  $workbook = $excel.Workbooks.Open($output)
  $source = $workbook.Worksheets.Item('Figür(833)')
  $source.Cells.Item(2, 4).Value2 = 833
  $source.Cells.Item(2, 5).Value2 = 'TRY'

  foreach ($map in $maps | Where-Object { $_.Id -ne 833 -and $_.Id -ne 2840 }) {
    $source.Copy($workbook.Worksheets.Item($workbook.Worksheets.Count))
    Start-Sleep -Milliseconds 500
    $sheet = $workbook.Worksheets.Item($workbook.Worksheets.Count)
    $sheet.Name = $map.Name
    $sheet.Cells.Item(2, 4).Value2 = $map.Id
    $sheet.Cells.Item(2, 5).Value2 = 'TRY'
    $headerColumn = 41
    foreach ($attributeName in $map.Attributes.Keys) {
      $sheet.Cells.Item(1, $headerColumn).Value2 = [string]$attributeName
      $headerColumn++
    }
  }

  foreach ($map in $maps) {
    $sheet = $workbook.Worksheets.Item($map.Name)
    $items = @($products | Where-Object $map.Selector)
    $sheet.Range('A3:AZ1048576').ClearContents()
    $headerColumns = @{}
    for ($column = 1; $column -le 52; $column++) {
      $header = [string]$sheet.Cells.Item(1, $column).Value2
      if ($header) { $headerColumns[$header] = $column }
    }
    $row = 3
    foreach ($product in $items) {
      $sitePrice = Get-EffectivePrice $product
      $trendyolPrice = [math]::Round([double]($sitePrice * 1.22), 2)
      $model = if ($product.sku) { [string]$product.sku } else { "PRINTABLE-$($product.id)" }
      $record = @{
        'Barkod' = Get-Ean13 ([int]$product.id)
        'Model Kodu' = $model
        'Marka' = ''
        'Kategori' = $map.Id
        'Para Birimi' = 'TRY'
        'Ürün Adı' = [string]$product.name
        'Ürün Açıklaması' = [string]$product.description
        'Piyasa Satış Fiyatı (KDV Dahil)' = $trendyolPrice
        "Trendyol'da Satılacak Fiyat (KDV Dahil)" = $trendyolPrice
        'Ürün Stok Adedi' = [int]$product.stock
        'Stok Kodu' = $model
        'KDV Oranı' = 20
        'ÖTV Oranı' = 0
        'Desi' = 1
        'Sevkiyat Süresi' = 3
        'Sevkiyat Tipi' = 'Hızlı Teslimat'
        'Menşei' = 'TR'
      }
      $images = Get-Images $product
      for ($imageIndex = 0; $imageIndex -lt $images.Count; $imageIndex++) { $record["Görsel $($imageIndex + 1)"] = $images[$imageIndex] }
      foreach ($attributeName in $map.Attributes.Keys) { $record[$attributeName] = & $map.Attributes[$attributeName] $product }
      foreach ($header in $record.Keys) { if ($headerColumns.ContainsKey($header)) { $sheet.Cells.Item($row, $headerColumns[$header]).Value2 = $record[$header] } }
      $row++
    }
    $sheet.UsedRange.Columns.AutoFit() | Out-Null
  }
  $workbook.Save()
  $workbook.Close($true)
} catch {
  $scriptError = $_
} finally {
  try { $excel.Quit() } catch {}
  [Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) | Out-Null
}

if ($scriptError) { throw $scriptError }

Write-Output $output
