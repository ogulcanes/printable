Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$targetDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "assets\shopier"))
$tempDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".tmp-shopier-sync"))

if (-not $targetDir.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Hedef klasör çalışma alanı dışında."
}
if ($tempDir -ne [System.IO.Path]::GetFullPath((Join-Path $repoRoot ".tmp-shopier-sync"))) {
  throw "Geçici klasör doğrulanamadı."
}

[System.IO.Directory]::CreateDirectory($targetDir) | Out-Null
[System.IO.Directory]::CreateDirectory($tempDir) | Out-Null

$items = @(
  @{ id = 7; url = "https://makerworld.bblmw.com/makerworld/model/US3fa154f896830/design/2024-09-22_de7d140930a96.gif?x-oss-process=image/resize,w_1200/ignore-error,1" },
  @{ id = 15; url = "https://makerworld.bblmw.com/makerworld/model/USb0e373f9ff76f9/design/3698b5b15f6b7d96.webp?x-oss-process=image/resize,w_1200/ignore-error,1" },
  @{ id = 21; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482122492-69de97fe-taht-1.webp" },
  @{ id = 22; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482416167-c3523021-flexi-axolotl-anahtarl-k.webp" },
  @{ id = 35; url = "https://makerworld.bblmw.com/makerworld/model/US65ea0744fda435/design/8b5aec1b12034365.gif?x-oss-process=image/resize,w_1200/ignore-error,1" },
  @{ id = 39; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482555392-2fbd677c-ChatGPT-Image-19-Tem-2026-19-53-36.webp" },
  @{ id = 40; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482557860-a09d7b0b-ChatGPT-Image-19-Tem-2026-19-53-47.webp" },
  @{ id = 41; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482560534-da0cd156-ChatGPT-Image-19-Tem-2026-19-59-26.webp" },
  @{ id = 42; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482564022-6f4f1455-ChatGPT-Image-19-Tem-2026-20-06-35.webp" },
  @{ id = 43; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482567327-91090fc4-ChatGPT-Image-19-Tem-2026-20-09-31.webp" },
  @{ id = 44; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482569879-ef829d62-ChatGPT-Image-19-Tem-2026-20-12-36.webp" },
  @{ id = 45; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482572995-cd53295d-ChatGPT-Image-19-Tem-2026-20-19-40.webp" },
  @{ id = 46; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482577230-ade0f191-TNT-Katla.webp" },
  @{ id = 47; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/1784482579697-a6579623-creeper.webp" },
  @{ id = 51; url = "https://makerworld.bblmw.com/makerworld/model/US6a3e0154a93134/design/2025-09-01_3af3607d28c8b.gif" },
  @{ id = 53; url = "https://budyxdawnhcgqfizlbyu.supabase.co/storage/v1/object/public/images/products/53/spinball-kapak-5b2b579dbfa0.jpg" }
)

$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
try {
  foreach ($item in $items) {
    $source = Join-Path $tempDir "$($item.id).source"
    $target = Join-Path $targetDir "$($item.id).jpg"
    Invoke-WebRequest -UseBasicParsing -Uri $item.url -OutFile $source
    & $ffmpeg -loglevel error -y -i $source -frames:v 1 -vf "scale='min(1600,iw)':-2" -q:v 2 $target
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) {
      throw "Ürün $($item.id) görseli dönüştürülemedi."
    }
  }
} finally {
  if (Test-Path -LiteralPath $tempDir) {
    [System.IO.Directory]::Delete($tempDir, $true)
  }
}

Get-ChildItem -LiteralPath $targetDir -Filter "*.jpg" | Sort-Object Name | Select-Object Name, Length
