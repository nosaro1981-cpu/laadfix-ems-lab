import { randomUUID } from 'node:crypto';

const ACTIVE = new Set(['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing']);
export const recoveryActions = {
  analyze: { title: 'Diagnose + hersteladvies', description: 'Controleert verbinding, instellingen, laadstatus en meterwaarden. Geeft daarna een gericht advies.', steps: ['Verbinding beoordelen', 'Instellingen uitlezen', 'Nieuwe laadstatus opvragen', 'Nieuwe meterwaarden opvragen', 'Hersteladvies maken'] },
  network: { title: 'Verbinding onderzoeken', description: 'Controleert de route van dit station en test DNS en de serverpoort vanuit de proxy.' },
  status: { title: 'Laadstatus verversen', description: 'Vraagt een nieuwe status en foutcode van de gekozen connector op.' },
  meter: { title: 'Meterwaarden controleren', description: 'Leest meterinstellingen en vraagt nieuwe kWh-, stroom- en spanningswaarden op.' },
  configuration: { title: 'Instellingen controleren', description: 'Leest alle instellingen en toont communicatie, laadlimieten en ingestelde meters.' },
  grid: { title: 'Master/slave-instellingen lezen', description: 'Toont de gridrol, CAN-instelling en watchdog. Bevestigt geen fysieke CAN-verbinding.' },
  diagnostics: { title: 'Diagnosebestand · 5 minuten', description: 'Vraagt een controllerbestand over de laatste vijf minuten aan. Volgt ontvangst apart.' },
  backendReconnect: { title: 'Backofficeverbinding herstellen', description: 'Opent alleen de verbinding van de proxy naar de ingestelde backend opnieuw. De Homebox blijft verbonden.', changes: true, scope: 'station' },
  operative: { title: 'Connector beschikbaar maken', description: 'Geeft de gekozen connector weer vrij voor gebruik. Een aangesloten auto kan daarna laden als de autorisatie dat toestaat.', changes: true, scope: 'connector' },
  softReset: { title: 'Laadsoftware herstarten', description: 'Stuurt een soft reset naar het hele station. De verbinding kan tijdelijk wegvallen.', changes: true, scope: 'station' },
  unlock: { title: 'Stekker ontgrendelen', description: 'Vraagt de gekozen connector zijn stekkervergrendeling vrij te geven.', changes: true, scope: 'connector' },
  clearCache: { title: 'Laadpas-cache wissen', description: 'Wist opgeslagen autorisaties op het hele station. Nieuwe controles hangen af van de autorisatie-instellingen.', changes: true, scope: 'station' },
  clearTestProfile: { title: 'EMS-testlimiet verwijderen', description: 'Verwijdert uitsluitend LaadFix-testprofiel 900001. Andere laadlimieten kunnen actief blijven.', changes: true, scope: 'station' },
  meterInterval: { title: 'Meetinterval op 60 seconden', description: 'Wijzigt MeterValueSampleInterval voor het hele station en leest de waarde terug.', changes: true, scope: 'station' }
};

export function connectorIds(station) {
  const count = Number(station?.configuration?.find(r => r.key === 'NumberOfConnectors')?.value);
  const ids = Object.keys(station?.connectors || {}).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 100);
  if (Number.isInteger(count) && count > 0 && count <= 100) for (let i = 1; i <= count; i++) ids.push(i);
  return [...new Set(ids.length ? ids : [1])].sort((a, b) => a - b);
}

export function recoveryGuard(station) {
  if (!station?.chargerConnected) return 'Geen OCPP-verbinding met dit laadstation.';
  if (station.activeTransaction || ACTIVE.has(station.status) || Object.values(station.connectors || {}).some(c => ACTIVE.has(c.status))) return 'Er is een actieve, gepauzeerde of startende laadsessie op dit station. Uitlezen blijft mogelijk.';
  const idle = new Set(['Available', 'Unavailable', 'Faulted', 'Reserved']);
  if (connectorIds(station).some(id => !idle.has(station.connectors?.[id]?.status || (id === 1 ? station.status : null)))) return 'De toestand van een connector is onbekend. Vraag eerst de laadstatus op.';
  return null;
}

const valueOf = (rows, key) => rows.find(r => r.key === key)?.value;
const gridKeys = ['grid_Role', 'grid_CommChannel', 'grid_InstallationMaxCurrent', 'grid_InstallationSaveCurrent', 'grid_SupervisorClientCount', 'grid_SupervisorTotalcurrent', 'grid_TotalcurrentOffset'];
const configKeys = ['HeartbeatInterval', 'MeterValueSampleInterval', 'ClockAlignedDataInterval', 'com_ProtCh', 'chg_KWH1', 'chg_KWH2', 'chg_StationMaxCurrent', 'chg_RatedCurrent'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createRecoveryCenter({ getStation, command, checkNetwork, requestDiagnostics, beforeClearTestProfile = () => {}, waitMs = 8000 }) {
  const jobs = [];
  async function run(job) {
    const { stationId, connectorId, action } = job;
    let rows = getStation(stationId)?.configuration || [];
    const station = () => getStation(stationId);
    const addStep = async (title, fn) => {
      const step = { title, status: 'running', detail: 'Bezig…', startedAt: new Date().toISOString() };
      job.steps.push(step);
      try { Object.assign(step, { status: 'ok', ...await fn() }); }
      catch (e) { step.status = 'error'; step.detail = e.message; }
      step.finishedAt = new Date().toISOString();
      return step;
    };
    const call = async (name, payload) => {
      if (!station()?.chargerConnected) throw Error('De lader is niet via OCPP verbonden. Opdracht niet afgeleverd.');
      const response = await command(stationId, name, payload);
      if (response?.errorCode) throw Error(`${name}: ${response.errorCode} ${response.errorDescription || ''}`);
      return response;
    };
    const waitFor = async predicate => {
      const deadline = Date.now() + waitMs;
      do { const result = predicate(station()); if (result) return result; await sleep(Math.min(200, Math.max(1, waitMs))); } while (Date.now() < deadline);
      return predicate(station()) || null;
    };
    const readConfig = () => addStep('Instellingen uitlezen', async () => {
      const response = await call('GetConfiguration', {});
      if (!Array.isArray(response?.configurationKey) || !response.configurationKey.length) throw Error('Geen instellingen ontvangen. Dit bewijst geen lege configuratie of nul slaves.');
      rows = response.configurationKey;
      const keys = action === 'grid' ? gridKeys : configKeys;
      const lines = keys.filter(k => valueOf(rows, k) !== undefined).map(k => `${k}: ${valueOf(rows, k)}`);
      if (action === 'grid') {
        const options = valueOf(rows, 'com_Options') || '';
        const wdt = options.match(/(?:^|,)Wdt=([^,]*)/i)?.[1];
        lines.push(`Communicatiewatchdog (Wdt): ${wdt ?? 'niet gemeld'}`, 'Aantal daadwerkelijk aangemelde CAN-slaves: onbekend. SupervisorClientCount is hier niet als live slaveteller gevalideerd.');
        lines.push('Wijzig Wdt alleen op basis van de documentatie voor deze controller en firmware.');
      }
      return { detail: `${rows.length} instellingen ontvangen.\n${lines.join('\n')}` };
    });
    const readStatus = () => addStep(`Nieuwe status · connector ${connectorId}`, async () => {
      const before = station()?.connectors?.[connectorId]?.time;
      const response = await call('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId });
      if (response?.status !== 'Accepted') return { status: 'warning', detail: `Lader antwoordt ${response?.status || 'zonder status'}. Geen nieuwe status bevestigd.` };
      const update = await waitFor(s => s?.connectors?.[connectorId]?.time && s.connectors[connectorId].time !== before ? s.connectors[connectorId] : null);
      if (!update) return { status: 'warning', detail: 'Aanvraag geaccepteerd; binnen het wachtvenster geen nieuw statusbericht voor deze connector ontvangen. De laatst bekende status is geen bevestiging.' };
      return { status: update.status === 'Faulted' || (update.errorCode && update.errorCode !== 'NoError') ? 'warning' : 'ok', detail: `Status: ${update.status}\nFoutcode: ${update.errorCode || 'niet gemeld'}\nOntvangen: ${update.time}` };
    });
    const readMeter = () => addStep(`Nieuwe meterwaarden · connector ${connectorId}`, async () => {
      const before = station()?.lastMeterValues;
      const response = await call('TriggerMessage', { requestedMessage: 'MeterValues', connectorId });
      if (response?.status !== 'Accepted') return { status: 'warning', detail: `Lader antwoordt ${response?.status || 'zonder status'}. Geen nieuwe meting bevestigd.` };
      const update = await waitFor(s => s?.lastMeterValues && s.lastMeterValues !== before && Number(s.meterValues?.connectorId) === connectorId ? s.meterValues : null);
      if (!update) return { status: 'warning', detail: 'Aanvraag geaccepteerd; geen nieuwe meterwaarden voor deze connector ontvangen binnen het wachtvenster. Bekijk het meetinterval en de laadstatus.' };
      const lines = (update.meterValue || []).flatMap(g => (g.sampledValue || []).map(v => `${v.measurand || 'Energy.Active.Import.Register'}${v.phase ? ' ' + v.phase : ''}: ${v.value} ${v.unit || ''}`));
      return { status: lines.length ? 'ok' : 'warning', detail: lines.length ? `Nieuwe meting ontvangen.\n${lines.join('\n')}` : 'MeterValues ontvangen, maar zonder meetwaarden.' };
    });
    if (['analyze', 'network'].includes(action)) await addStep('Verbinding beoordelen', async () => {
      const s = station();
      const lines = [`Lader → proxy: ${s.chargerConnected ? 'verbonden' : 'niet verbonden'}`, `Proxy → backoffice: ${s.backendConnected ? 'verbonden' : 'niet verbonden'}`];
      if (action === 'network') {
        const result = await checkNetwork(s);
        lines.push(`Bestemming: ${result.host || 'onbekend'}${result.port ? ':' + result.port : ''}`, ...result.lines);
        return { status: result.ok && s.chargerConnected && s.backendConnected ? 'ok' : 'warning', detail: lines.join('\n') };
      }
      lines.push('Dit beschrijft OCPP-bereikbaarheid. CAN-bus, fysieke voeding en mobiel signaal zijn hiermee niet gemeten.');
      return { status: s.chargerConnected && s.backendConnected ? 'ok' : 'warning', detail: lines.join('\n') };
    });
    if (['analyze', 'meter', 'configuration', 'grid'].includes(action)) await readConfig();
    if (['analyze', 'status'].includes(action)) await readStatus();
    if (['analyze', 'meter'].includes(action)) await readMeter();
    if (action === 'analyze') await addStep('Hersteladvies maken', async () => {
      const s = station(), c = s?.connectors?.[connectorId], guard = recoveryGuard(s);
      if (!s.chargerConnected) return { status: 'warning', detail: 'Controleer voeding en netwerk op locatie of via een onafhankelijke beheerverbinding. OCPP-opdrachten kunnen nu niet worden afgeleverd.' };
      if (!s.backendConnected) return { status: 'warning', detail: 'De lader bereikt de proxy. Gebruik “Verbinding onderzoeken” om de ingestelde backofficebestemming te controleren.' };
      if (c?.status === 'Unavailable' && c.errorCode === 'NoError' && !guard) {
        job.recommendation = 'operative';
        return { status: 'warning', detail: 'Connector is administratief niet beschikbaar en meldt NoError. Gebruik “Connector beschikbaar maken” en controleer daarna de nieuwe status.' };
      }
      const earlierIssues = job.steps.slice(0, -1).some(step => ['warning', 'error'].includes(step.status));
      if (c?.status === 'Faulted' || c?.errorCode && c.errorCode !== 'NoError') return { status: 'warning', detail: `Fout gemeld: ${c.errorCode || c.status}. Vraag een diagnosebestand op en onderzoek de fout. Er is geen reset uitgevoerd.` };
      return { status: earlierIssues ? 'warning' : 'ok', detail: earlierIssues ? 'Een of meer controles zijn onvolledig. Bekijk de betreffende stap; zonder nieuwe gegevens kunnen we geen herstel bevestigen.' : 'De uitgevoerde controles geven geen directe reden voor een herstelactie. Dit is geen volledige hardwaretest.' };
    });
    if (action === 'diagnostics') await addStep('Diagnose-upload aanvragen · laatste 5 minuten', async () => {
      const report = await requestDiagnostics(stationId, 5);
      return { status: 'warning', detail: report.fileName ? `Bestandsnaam ontvangen: ${report.fileName}. Wachten op het bestand; Uploading is nog geen ontvangstbevestiging.` : 'Geen bestandsnaam teruggegeven. Er is nog geen diagnosebestand ontvangen.' };
    });
    if (recoveryActions[action].changes) {
      const guard = recoveryGuard(station());
      if (guard) throw Error(guard);
      if (action === 'meterInterval') {
        const read = await readConfig();
        if (read.status !== 'ok') throw Error('Instellingen niet gelezen; meetinterval niet gewijzigd.');
        await addStep('Meetinterval wijzigen en teruglezen', async () => {
          const old = valueOf(rows, 'MeterValueSampleInterval');
          if (old === undefined) throw Error('MeterValueSampleInterval ontbreekt; geen wijziging verstuurd.');
          if (rows.find(r => r.key === 'MeterValueSampleInterval')?.readonly) throw Error('Deze instelling is alleen-lezen.');
          if (recoveryGuard(station())) throw Error(recoveryGuard(station()));
          const response = await call('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '60' });
          if (!['Accepted', 'RebootRequired'].includes(response?.status)) return { status: 'warning', detail: `Oude waarde: ${old}. Antwoord: ${response?.status || 'onbekend'}. Wijziging niet bevestigd.` };
          const verified = await call('GetConfiguration', {}), actual = valueOf(verified?.configurationKey || [], 'MeterValueSampleInterval');
          return { status: actual === '60' && response.status === 'Accepted' ? 'ok' : 'warning', detail: `Oude waarde: ${old} s. Gevraagd: 60 s. Teruggelezen: ${actual ?? 'niet ontvangen'} s.\nAntwoord: ${response.status}.${response.status === 'RebootRequired' ? ' De lader vraagt een herstart; die is niet automatisch uitgevoerd.' : ''}\nDit verandert alleen het sample-interval; nieuwe meterwaarden moeten de werking nog bevestigen.` };
        });
      } else {
        const commands = { operative: ['ChangeAvailability', { connectorId, type: 'Operative' }], softReset: ['Reset', { type: 'Soft' }], unlock: ['UnlockConnector', { connectorId }], clearCache: ['ClearCache', {}], clearTestProfile: ['ClearChargingProfile', { id: 900001 }], backendReconnect: ['reconnectBackend', {}] };
        if (action === 'clearTestProfile') beforeClearTestProfile(stationId);
        await addStep(recoveryActions[action].title, async () => {
          if (recoveryGuard(station())) throw Error(recoveryGuard(station()));
          const [name, payload] = commands[action], response = await call(name, payload);
          const result = response?.status || 'onbekend';
          if (action === 'backendReconnect') return { status: ['Started', 'AlreadyConnected', 'Connecting'].includes(result) ? 'ok' : 'warning', detail: result === 'Started' ? 'Een nieuwe verbinding naar de ingestelde backend is gestart. De Homeboxsocket is open gebleven; de automatische herstelpogingen blijven actief.' : result === 'AlreadyConnected' ? 'De backofficeverbinding was al geopend.' : `Proxy antwoordt: ${result}.` };
          if (action === 'unlock') return { status: result === 'Unlocked' ? 'ok' : 'warning', detail: `Lader meldt ${result}.${result === 'Unlocked' ? ' Controleer of de stekker fysiek vrij is.' : ' Ontgrendeling is niet bevestigd.'}` };
          if (action === 'clearTestProfile' && result === 'Unknown') return { status: 'warning', detail: 'Geen passend testprofiel 900001 gevonden. Andere laadprofielen zijn niet verwijderd.' };
          if (result !== 'Accepted') return { status: 'warning', detail: `${name}: ${result}.${result === 'Scheduled' ? ' Uitvoering is uitgesteld door de lader.' : ' Uitvoering niet bevestigd.'}` };
          if (action === 'softReset') return { status: 'warning', detail: 'Soft reset geaccepteerd. Een nieuwe verbinding en BootNotification moeten de herstart nog bevestigen; de reparatie is nog niet bewezen.' };
          return { detail: action === 'clearTestProfile' ? 'Lader bevestigt verwijdering van testprofiel 900001. LaadFix-regeling voor dit station is uitgezet; andere stroomlimieten kunnen blijven gelden.' : action === 'clearCache' ? 'Lader bevestigt het wissen van de autorisatiecache. Dit repareert geen netwerkverbinding.' : 'Verzoek geaccepteerd. De connector is pas bevestigd beschikbaar na een nieuwe Available-status.' };
        });
        if (action === 'operative') {
          await readStatus();
          const c = station()?.connectors?.[connectorId];
          if (c?.status !== 'Available') job.steps.push({ title: 'Beschikbaarheid controleren', status: 'warning', detail: `Laatste status: ${c?.status || 'onbekend'}. Beschikbaarheid nog niet bevestigd.` });
        }
      }
    }
  }
  return {
    snapshot: () => ({ actions: recoveryActions, jobs, guards: {} }),
    start({ stationId, connectorId = 1, action }) {
      if (!Object.hasOwn(recoveryActions, action)) throw Error('Onbekende herstelactie.');
      const station = getStation(stationId);
      if (!station) throw Error('Selecteer een bekend laadstation.');
      if (!Number.isInteger(connectorId) || !connectorIds(station).includes(connectorId)) throw Error('Onbekende connector voor dit laadstation.');
      if (jobs.some(j => j.status === 'running')) throw Error('Er loopt al een controle of herstelactie.');
      const guard = recoveryActions[action].changes && recoveryGuard(station);
      if (guard) throw Error(guard);
      const job = { id: randomUUID(), stationId, connectorId, action, title: recoveryActions[action].title, startedAt: new Date().toISOString(), status: 'running', steps: [] };
      jobs.unshift(job); jobs.splice(40);
      const done = run(job).catch(e => job.steps.push({ title: 'Actie gestopt', status: 'error', detail: e.message })).finally(() => {
        job.status = job.steps.some(s => s.status === 'error') ? 'error' : job.steps.some(s => s.status === 'warning') ? 'warning' : 'ok';
        job.finishedAt = new Date().toISOString();
      });
      return { job, done };
    }
  };
}
