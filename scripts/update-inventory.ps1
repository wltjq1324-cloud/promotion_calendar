$ErrorActionPreference = 'Stop'

$accessKey = ([string]$env:OURBOX_API_ACCESS_KEY).Trim()
$secretKey = ([string]$env:OURBOX_API_SECRET_KEY).Trim()

if ([string]::IsNullOrWhiteSpace($accessKey) -or [string]::IsNullOrWhiteSpace($secretKey)) {
  throw 'OURBOX_API_ACCESS_KEY and OURBOX_API_SECRET_KEY environment variables are required.'
}

$headers = @{
  api_access_key = $accessKey
  api_secret_key = $secretKey
  'Content-Type' = 'application/json'
}

$endpoint = 'https://api.ourbox.co.kr/api/oms/info/product_stock_detail'
$page = 1
$totalPage = 1
$items = New-Object System.Collections.Generic.List[object]
$responseDate = ''

try {
  $koreaTimeZone = [System.TimeZoneInfo]::FindSystemTimeZoneById('Korea Standard Time')
  $generatedAt = [System.TimeZoneInfo]::ConvertTimeFromUtc((Get-Date).ToUniversalTime(), $koreaTimeZone).ToString('yyyy-MM-dd HH:mm:ss')
} catch {
  $generatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
}

function ConvertFrom-Codepoints($codes) {
  return -join ($codes | ForEach-Object { [char]$_ })
}

$labelMaterial = ConvertFrom-Codepoints @(48512,51088,51116)
$labelSet = ConvertFrom-Codepoints @(49464,53944)
$labelGift = ConvertFrom-Codepoints @(51613,51221,54408)
$labelSales = ConvertFrom-Codepoints @(54032,47588,49345,54408)
$warehouseName = ConvertFrom-Codepoints @(53685,54633,44592,48376)
$ownerName = ConvertFrom-Codepoints @(48173,40,54028,47672,49828,48288,51060,53356,49397,41)
$availableName = ConvertFrom-Codepoints @(44032,50857,40,44032,50857,41)
$unusableName = ConvertFrom-Codepoints @(48520,50857)
$materialPattern = ConvertFrom-Codepoints @(48149,49828,124,50500,51060,49828,124,53580,51060,54532,124,54252,51109,124,48393,53804,124,49828,54000,52964,124,50756,52649,124,48372,45257,124,54057,124,50500,51060,49828,54057)
$setPattern = ConvertFrom-Codepoints @(94,92,91,49464,53944,92,93,124,49464,53944)
$giftPattern = ConvertFrom-Codepoints @(94,92,91,51613,51221,92,93,124,51613,51221,124,53412,47553)

function Get-Category($item) {
  $code = [string]$item.sales_product_company_code
  $name = [string]$item.product_name
  if ($code -match '^(BM|BOX|ICE|PK|S-|TAPE|OPP)' -or $name -match $script:materialPattern) {
    return $script:labelMaterial
  }
  if ($name -match $script:setPattern) {
    return $script:labelSet
  }
  if ($name -match $script:giftPattern) {
    return $script:labelGift
  }
  return $script:labelSales
}

do {
  $body = @{
    sales_product_codes = @()
    sales_product_company_codes = @()
    page = $page
  } | ConvertTo-Json -Compress

  $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body
  if (-not $response.result) {
    throw "OurBox inventory API failed on page ${page}: $($response.message)"
  }

  $responseDate = [string]$response.response_date
  $totalPage = [int]$response.total_page

  foreach ($item in @($response.product_stock_info)) {
    $category = Get-Category $item
    $items.Add([ordered]@{
      warehouse = $warehouseName
      center = [string]$item.plant_name
      owner = $ownerName
      product_code = [string]$item.sales_product_code
      company_code = [string]$item.sales_product_company_code
      product_name = [string]$item.product_name
      barcode = ''
      manufacturing_date = [string]$item.manufacturing_date
      expiration_date = [string]$item.expiration_date
      batch_no = [string]$item.bat_no
      lot_no = [string]$item.lot_no
      received_date = ''
      stock_status = [string]$item.stock_status
      stock_status_name = if ([int]$item.stock_status -eq 0) { $availableName } else { $unusableName }
      unit = 'EA'
      pack_qty = ''
      total_stock = [int]$item.total_stock
      available_stock = [int]$item.available_stock
      allocated_stock = [int]$item.unavailable_stock
      hold_stock = 0
      unusable_stock = 0
      category = $category
      search_key = "$($item.product_name) $($item.sales_product_code) $($item.sales_product_company_code) $category"
      updated_at = $responseDate
    }) | Out-Null
  }

  $page += 1
} while ($page -le $totalPage)

$payload = [ordered]@{
  generated_at = $generatedAt
  response_date = $responseDate
  source = 'ourbox-product-stock-detail'
  total_count = $items.Count
  items = $items
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
$outPath = Join-Path (Get-Location) 'inventory-latest.json'
[System.IO.File]::WriteAllText($outPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $($items.Count) inventory rows to $outPath"
