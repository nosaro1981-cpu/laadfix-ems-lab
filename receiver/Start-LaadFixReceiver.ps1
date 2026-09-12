param([switch]$OpenDashboard)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$installRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$dataRoot=Join-Path $env:LOCALAPPDATA 'LaadFix Receiver\data'
$node=Join-Path $installRoot 'runtime\node.exe'
$receiver=Join-Path $installRoot 'receiver.mjs'
$configuration=Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway -and $_.IPv4Address.IPAddress -notlike '169.254.*' } | Sort-Object { $_.NetIPv4Interface.ConnectionState -ne 'Connected' } | Select-Object -First 1
$localIp=$configuration.IPv4Address.IPAddress | Select-Object -First 1
if(-not $localIp){[System.Windows.Forms.MessageBox]::Show('Geen actief lokaal netwerk gevonden. Verbind de laptop eerst met hetzelfde wifi-, kabel- of hotspotnetwerk als de Homebox.','LaadFix ontvanger');exit 1}
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*LaadFix Receiver*receiver.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$env:LAADFIX_LOCAL_IP=$localIp
$env:LAADFIX_FTP_PORT='2121'
$env:LAADFIX_PASSIVE_PORT='50000'
$env:LAADFIX_PROXY_URL='https://laadfix-ems-lab.onrender.com'
$env:LAADFIX_DATA_DIR=$dataRoot
Start-Process -FilePath $node -ArgumentList ('"'+$receiver+'"') -WorkingDirectory $installRoot -WindowStyle Hidden
Start-Sleep -Seconds 1
if($OpenDashboard){Start-Process ('https://laadfix-ems-lab.onrender.com/?receiver='+[uri]::EscapeDataString($localIp+':2121')+'#/stations')}
