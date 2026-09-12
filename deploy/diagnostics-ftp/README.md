# LaadFix diagnose-FTP

Deze configuratie is bedoeld voor Ecotap-controllers die diagnosebestanden alleen via klassieke FTP kunnen uploaden. De server gebruikt poort `2121`, omdat poort `21` op het huidige laadstationnetwerk niet bereikbaar is.

Benodigd: een Ubuntu-VPS met een vast publiek IPv4-adres. Open bij de cloudprovider TCP-poort `2121` en TCP-poorten `30000-30009`.

Voer op de VPS uit:

```bash
export PUBLIC_IP="<publiek-ip>"
export DIAG_FTP_USER="diagnostics"
export DIAG_FTP_PASSWORD="<sterk-wachtwoord>"
sudo -E bash setup.sh
```

Gebruik daarna in Render:

```text
DIAGNOSTICS_FTP_URL=ftp://diagnostics:<url-gecodeerd-wachtwoord>@<publiek-ip>:2121/
```

Controleer vóór de eerste laadstationtest vanaf een andere internetverbinding dat poort `2121` bereikbaar is. De proxy kan de bestandsnaam vervolgens volgen, downloaden en automatisch analyseren.
