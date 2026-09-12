# Herstelcentrum: veilige herstelstraat

## 1. Analyse van de bestaande codebase

De applicatie bestaat uit drie technische lagen. `cloud-entry.mjs` ontvangt de publieke OCPP-WebSocket en maakt per laadstation één `relay.mjs` aan. De relay bewaart de actieve route, verbindt met de gekozen backoffice en observeert CALL, CALLRESULT, CALLERROR, status, meterwaarden, configuratie en verbindingstijdlijn. `ems-server.mjs` biedt de beveiligde dashboard-API. `recovery-center.mjs` voert bestaande uitlees- en herstelacties uit; `recovery-ui.mjs` toont die acties.

De basis voor een veilige herstelstraat is aanwezig: één actieve verbinding per OCPP-ID, routering per station, blokkades tijdens een laadsessie, time-outs voor opdrachten, configuratie-uitlezing, diagnose-upload en volledige OCPP-observatie. Wat ontbreekt is een case-lifecycle met een uitgangssnapshot, bevindingen, audit trail, maximale behandeltijd, gecontroleerde afsluiting en expliciete scheiding tussen advies en wijzigingen.

## 2. Voorgestelde architectuur en datastroom

Versie 1 gebruikt een **diagnostische sidecar** in de bestaande proxy. De lader blijft via dezelfde WebSocket met RoboCharge verbonden. Het Herstelcentrum opent een case rond die verbinding, bewaart de oorspronkelijke upstream, maakt een snapshot, voert alleen read-only OCPP-controles uit en analyseert de ontvangen data. Hierdoor is geen wijziging van `com_Endpoint` nodig en blijft de backoffice online.

Datastroom:

1. Operator selecteert station, connector en maximale behandeltijd.
2. Case manager controleert dat geen andere case voor het station actief is.
3. Werkelijke oorspronkelijke upstream blijft alleen server-side bewaard; de UI krijgt een gemaskeerde route.
4. Snapshot legt identiteit, verbinding, configuratie, connectoren, meter, transactie, recente OCPP-berichten en verbindingstijdlijn vast.
5. Intake vraagt `GetConfiguration`, `StatusNotification` en `MeterValues` op. Een ontbrekend of niet ondersteund antwoord wordt als zodanig vastgelegd.
6. Deterministische regels uit `station-watchdog.mjs` en `connection-intelligence.mjs` produceren bevindingen.
7. Sluiten of verlopen controleert de oorspronkelijke route en herstelt die indien nodig. Daarna wordt de actuele verbinding vastgelegd.

Een exclusieve tijdelijke backend, waarbij RoboCharge bewust wordt losgekoppeld, valt buiten versie 1. Die aanpak veroorzaakt een zichtbare offlineperiode en vereist een volledige lokale CSMS. De sidecar levert dezelfde observatie en commandolaag zonder die uitval.

## 3. Wijzigingen per bestand of module

- `recovery-case-manager.mjs`: nieuwe case-lifecycle, snapshots, masking, deterministische bevindingen, tijdlijn, maximale duur en fail-safe afsluiting.
- `ems-server.mjs`: case manager koppelen aan vlootdata en routering; API voor openen en sluiten; cases opnemen in `/api/state`.
- `cloud-entry.mjs`: bestaande per-station routering doorgeven; geen wijziging aan het publieke OCPP-endpoint.
- `recovery-ui.mjs`: case openen/sluiten, actuele fase, tijdlijn, bevindingen en vergelijking tonen.
- `ems.html`: compacte casebalk en casepanelen toevoegen aan het bestaande Herstelcentrum.
- `recovery.css`: statussen, tijdlijn, bevindingen en mobiele weergave.
- `recovery-case-manager.test.mjs`: lifecycle, read-only intake, masking, timeout en routeherstel testen.
- `package.json`: nieuwe test opnemen.

## 4. Datamodellen

### RecoveryCase

`id`, `correlationId`, `stationId`, `connectorId`, `status`, `phase`, `actor`, `role`, `mode`, `openedAt`, `deadlineAt`, `closedAt`, `maxDurationMinutes`, `originalRoute` (gemaskeerd), `routeState`, `snapshotBefore`, `snapshotAfter`, `findings`, `comparisons`, `capabilities`, `timeline`, `outcome`.

### Snapshot

`capturedAt`, `identity`, `connection`, `configuration`, `connectors`, `meter`, `transaction`, `recentMessages`, `connectionTimeline`. ICCID, IMSI, IMEI, tokens, wachtwoorden en geheime endpointpaden worden gemaskeerd.

### Finding

`id`, `code`, `severity`, `title`, `actual`, `expected`, `probableCause`, `evidence`, `recommendation`, `risk`, `impact`, `confidence`, `actionClass`, `remotePossible`, `technicianRequired`, `status`.

### Action/AuditEvent

`id`, `correlationId`, `time`, `actor`, `role`, `kind`, `status`, `title`, `detail`, `oldValue`, `newValue`, `result`. Versie 1 registreert alleen intake- en routecontroleacties; configuratiewijzigingen blijven buiten deze automatische flow.

## 5. Ondersteunde OCPP-diagnoses

Versie 1 richt zich op OCPP 1.6J:

- live BootNotification-identiteit, Heartbeat, StatusNotification en MeterValues;
- `GetConfiguration` met duidelijke melding bij leeg, rejected, timeout of unsupported;
- `TriggerMessage` voor StatusNotification en MeterValues;
- connectorstatus, foutcode, actieve transactie, laadprofiel- en meetinstellingen;
- verbindingstijdlijn van upgrade tot Boot-acceptatie en upstream;
- bestaand `GetDiagnostics`-proces blijft als handmatige read-only actie beschikbaar;
- SIM- en modemgegevens worden getoond als de Homebox ze via Boot/configuratie/diagnoselog meldt.

OCPP 2.0.1 `GetVariables`, `GetBaseReport`, `LogStatusNotification` en `SecurityEventNotification` krijgen in versie 1 de status **gepland**. Niet gemelde vendor-data krijgt **niet beschikbaar** en wordt nooit verzonnen.

## 6. Risico- en securitymaatregelen

- één actieve case per station;
- één actieve backendverbinding per OCPP-ID blijft door de relay afgedwongen;
- versie 1 wijzigt geen laadpaalconfiguratie en onderbreekt RoboCharge niet;
- routegeheimen, credentials, tokens, ICCID, IMSI en IMEI zijn gemaskeerd in case en export;
- maximale behandeltijd is verplicht en begrensd op 5–120 minuten;
- timeout en fouten starten routecontrole en herstel naar de server-side bewaarde oorspronkelijke route;
- configuratie, certificaten, firmware, netwerk en security worden nooit automatisch gewijzigd;
- correlation ID en actor/rol staan op iedere case;
- bestaande blokkade tijdens Charging, Preparing, Suspended en Finishing blijft gelden voor acties die de lader wijzigen;
- productie vereist duurzame case-opslag en volwaardige gebruikersrollen; versie 1 gebruikt de ingelogde dashboardoperator en procesgeheugen.

## 7. Gefaseerd implementatieplan

### Fase 1: minimale veilige herstelstraat

Case openen, oorspronkelijke route server-side bewaren, read-only snapshot, OCPP-intake, bevindingen, tijdlijn, maximale duur en gecontroleerd sluiten. RoboCharge blijft verbonden.

### Fase 2: gecontroleerde voorstellen

Goedgekeurde templates per fabrikant/model/firmware, laatste werkende configuratie, peervergelijking, change set met oude/nieuwe waarde, expliciete goedkeuring, verify en rollback.

### Fase 3: uitgebreide protocollen en data

OCPP 2.0.1-adapter, DiagnosticsLog/SecurityLog, vendoradapters, duurzame database, RBAC en technisch/manageroverzicht.

### Fase 4: veilige automatisering

Alleen vooraf goedgekeurde laag-risicoacties automatisch uitvoeren, met rate limits, onderhoudsvensters, herhaalbeveiliging en rapportage over vlootpatronen.

## 8. Testplan en acceptatiecriteria

- Een case opent alleen voor een bekend station en nooit dubbel voor hetzelfde station.
- De oorspronkelijke upstream blijft server-side beschikbaar en verschijnt gemaskeerd in API/UI.
- Openen voert alleen `GetConfiguration` en `TriggerMessage` uit; geen `ChangeConfiguration`, `Reset`, firmware- of netwerkactie.
- Elk ondersteund, geweigerd, leeg of ontbrekend antwoord krijgt een zichtbare status.
- Snapshot bevat OCPP- en verbindingstijdlijn maar geen volledige ICCID/IMSI/IMEI of geheime endpointtoken.
- Bevindingen hebben actual, expected, evidence, recommendation, risk en confidence.
- Handmatig sluiten en timeout controleren/herstellen de oorspronkelijke route en registreren het resultaat.
- Een routeherstel dat faalt eindigt als gedeeltelijk hersteld of mislukt en wordt nooit als succesvol getoond.
- Bestaande herstelacties en EMS-tests blijven werken.
- Alle unit-, API- en buildcontroles slagen.

