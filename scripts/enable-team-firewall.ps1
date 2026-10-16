param(
  [Parameter(Mandatory=$true)][string]$LocalAddress,
  [ValidateRange(1,65535)][int]$Port = 41596
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resultFile = Join-Path $projectRoot 'data\team-firewall-result.json'
try {
  $address = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LocalAddress
  $profile = Get-NetConnectionProfile -InterfaceIndex $address.InterfaceIndex
  if ($profile.NetworkCategory -ne 'Private') { throw '团队服务只允许在专用网络开放，请先核对网络配置' }
  $ruleName = 'XbotTeamIngestLocalSubnet'
  $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  if ($existing) { throw '规则已存在，请先核对既有规则，不自动覆盖' }
  New-NetFirewallRule -Name $ruleName -DisplayName 'X.bot team ingest - private LAN only' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $LocalAddress -LocalPort $Port `
    -RemoteAddress LocalSubnet -Profile Private -InterfaceAlias $address.InterfaceAlias `
    -Program (Get-Command node.exe).Source | Out-Null
  @{ state='configured'; address=$LocalAddress; port=$Port; profile='Private'; remoteAddress='LocalSubnet' } |
    ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8
} catch {
  @{ state='failed'; error=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8
  exit 1
}
