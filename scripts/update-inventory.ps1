$ErrorActionPreference = 'Stop'

$accessKey = $env:OURBOX_API_ACCESS_KEY
$secretKey = $env:OURBOX_API_SECRET_KEY

if ([string]::IsNullOrWhiteSpace($accessKey) -or [string]::IsNullOrWhiteSpace($secretKey)) {
  throw 'OURBOX_API_ACCESS_KEY and OURBOX_API_SECRET_KEY environment variables are required.'
}

$headers = @{
  api_access_key = $accessKey
  api_secret_key = $secretKey
  'Content-Type' = 'application/json'
}

$endpoint = 'https://api.ourbox.co.kr/api/oms/info/bat_product_stock'
$page = 1
$totalPage = 1
$items = New-Object System.Collections.Generic.List[object]
$responseDate = ''

function Get-Category($item) {
  $code = [string]$item.sales_product_company_code
  $name = [string]$item.product_name
  if ($code -match '^(BM|BOX|ICE|PK|S-|TAPE|OPP)' -or $name -match '박스|아이스|테이프|포장|봉투|스티커|완충|보냉|팩|아이스팩') {
    return '부자재'
  }
  if ($name -match '^\[세트\]|세트') {
    return '세트'
  }
  if ($name -match '^\[증정\]|증정|키링') {
    return '증정품'
  }
  return '판매상품'
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
      warehouse = '통합기본'
      center = [string]$item.plant_name
      owner = '밭(파머스베이크샵)'
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
      stock_status_name = if ([int]$item.stock_status -eq 0) { '가용(가용)' } else { '불용' }
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
  generated_at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  response_date = $responseDate
  source = 'ourbox-bat-product-stock'
  total_count = $items.Count
  items = $items
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
$outPath = Join-Path (Get-Location) 'inventory-latest.json'
[System.IO.File]::WriteAllText($outPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $($items.Count) inventory rows to $outPath"
