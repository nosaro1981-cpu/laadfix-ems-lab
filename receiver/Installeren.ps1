$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$isAdmin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $isAdmin){Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$MyInvocation.MyCommand.Path+'"');exit}
$installRoot=Join-Path $env:LOCALAPPDATA 'LaadFix Receiver'
$runtimeRoot=Join-Path $installRoot 'runtime'
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'receiver.mjs') $installRoot -Force
Copy-Item (Join-Path $PSScriptRoot 'Start-LaadFixReceiver.ps1') $installRoot -Force
if(-not (Test-Path (Join-Path $runtimeRoot 'node.exe'))){
  $architecture=if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'}
  $releases=Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $release=$releases | Where-Object { $_.version -like 'v22.*' -and $_.files -contains ('win-'+$architecture+'-zip') } | Select-Object -First 1
  if(-not $release){throw 'De veilige Node.js-runtime kon niet worden gevonden.'}
  $zipName='node-'+$release.version+'-win-'+$architecture+'.zip'
  $baseUrl='https://nodejs.org/dist/'+$release.version+'/'
  $tempZip=Join-Path $env:TEMP $zipName
  $checksums=Invoke-WebRequest ($baseUrl+'SHASUMS256.txt') -UseBasicParsing
  $expected=(($checksums.Content -split "`n" | Where-Object { $_ -match ([regex]::Escape($zipName)+'$') }) -split '\s+')[0]
  Invoke-WebRequest ($baseUrl+$zipName) -OutFile $tempZip -UseBasicParsing
  if((Get-FileHash $tempZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()){throw 'Controle van de gedownloade runtime is mislukt.'}
  $unpack=Join-Path $env:TEMP ('laadfix-node-'+[guid]::NewGuid())
  Expand-Archive $tempZip $unpack -Force
  Remove-Item $runtimeRoot -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item (Join-Path $unpack ('node-'+$release.version+'-win-'+$architecture)) $runtimeRoot
  Remove-Item $tempZip -Force
  Remove-Item $unpack -Recurse -Force
}
$node=Join-Path $runtimeRoot 'node.exe'
Get-NetFirewallRule -DisplayName 'LaadFix diagnose-ontvanger*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'LaadFix diagnose-ontvanger FTP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 2121 -Profile Any -RemoteAddress LocalSubnet -Program $node | Out-Null
New-NetFirewallRule -DisplayName 'LaadFix diagnose-ontvanger gegevens' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 50000 -Profile Any -RemoteAddress LocalSubnet -Program $node | Out-Null
$shell=New-Object -ComObject WScript.Shell
$arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $installRoot 'Start-LaadFixReceiver.ps1')+'" -OpenDashboard'
foreach($shortcutPath in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'LaadFix diagnose-ontvanger.lnk'),(Join-Path ([Environment]::GetFolderPath('Startup')) 'LaadFix diagnose-ontvanger.lnk'))){$shortcut=$shell.CreateShortcut($shortcutPath);$shortcut.TargetPath='powershell.exe';$shortcut.Arguments=$arguments;$shortcut.WorkingDirectory=$installRoot;$shortcut.Save()}
& (Join-Path $installRoot 'Start-LaadFixReceiver.ps1') -OpenDashboard
[System.Windows.Forms.MessageBox]::Show('De LaadFix diagnose-ontvanger is geïnstalleerd en gestart. De proxy is geopend met het juiste lokale adres.','LaadFix ontvanger') | Out-Null
