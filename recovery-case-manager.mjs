import { randomUUID } from 'node:crypto';
import { auditStation } from './station-watchdog.mjs';
import { connectionIntelligence } from './connection-intelligence.mjs';

const OPEN = new Set(['intake', 'observing', 'analyzing', 'returning']);
const nowIso = () => new Date().toISOString();
const clone = value => value == null ? value : structuredClone(value);

export function maskIdentifier(value) {
  const text = String(value || '');
  return text.length < 5 ? (text ? '••••' : null) : `${'•'.repeat(Math.min(12, text.length - 4))}${text.slice(-4)}`;
}

export function maskRoute(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'));
    const protocol = String(value).startsWith('wss:') ? 'wss:' : 'ws:';
    const parts = url.pathname.split('/').filter(Boolean);
    const path = parts.length > 1 ? `/${parts[0]}/••••/${parts.at(-1)}` : url.pathname;
    return `${protocol}//${url.host}${path}`;
  } catch { return 'Route ingesteld (adres gemaskeerd)'; }
}

function redact(value, key = '') {
  if (value == null) return value;
  if (/^(iccid|imsi|imei)$/i.test(key)) return maskIdentifier(value);
  if (/password|secret|token|authorizationkey|idtag/i.test(key)) return '••••';
  if (/endpoint|upstream|location/i.test(key) && typeof value === 'string') return maskRoute(value);
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (typeof value === 'object') {
    if (typeof value.key === 'string' && Object.hasOwn(value, 'value') && /password|secret|token|authorizationkey|idtag/i.test(value.key)) return { ...value, value: '••••' };
    if (typeof value.key === 'string' && Object.hasOwn(value, 'value') && /endpoint|upstream|location/i.test(value.key)) return { ...value, value: maskRoute(value.value) };
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function snapshot(station) {
  return redact({
    capturedAt: nowIso(),
    identity: station.boot || null,
    connection: {
      chargerConnected: !!station.chargerConnected,
      backendConnected: !!station.backendConnected,
      status: station.status || 'Onbekend',
      errorCode: station.errorCode || null,
      lastSeen: station.lastSeen || null,
      lastHeartbeat: station.lastHeartbeat || null,
      upstream: station.upstream || null,
      diagnostics: station.connectionDiagnostics || null,
    },
    configuration: station.configuration || [],
    connectors: station.connectors || {},
    meter: { lastMeterValues: station.lastMeterValues || null, values: station.meterValues || null, history: (station.meterHistory || []).slice(0, 20) },
    transaction: { active: !!station.activeTransaction, transactionId: station.transactionId || null },
    recentMessages: (station.ocppMessages || []).slice(0, 100),
    connectionTimeline: (station.connectionTimeline || []).slice(0, 80),
  });
}

const expectedFor = finding => finding.repair ? `${finding.repair.key} = ${finding.repair.value}` : 'Geen afwijking of een aantoonbaar werkende verbinding';
const technicianCodes = new Set(['METER_MODEL_MISMATCH', 'METER_TIMEOUT', 'LOW_SUPPLY', 'RFID_READER']);
function enrichFindings(station, diagnostic) {
  const watchdog = auditStation(station, diagnostic);
  const connection = connectionIntelligence(station, []);
  const source = [
    ...connection.findings.map((item, index) => ({ ...item, code: `CONNECTION_${index + 1}` })),
    ...watchdog.findings,
  ];
  return source.map((item, index) => {
    const severity = item.level === 'critical' ? 'critical' : item.level === 'warning' ? 'warning' : 'ok';
    const technicianRequired = technicianCodes.has(item.code);
    return {
      id: `${item.code || 'FINDING'}-${index + 1}`,
      code: item.code || `FINDING_${index + 1}`,
      severity,
      title: item.title,
      actual: item.detail,
      expected: expectedFor(item),
      probableCause: severity === 'ok' ? 'Geen directe fout gevonden' : item.detail,
      evidence: [item.detail],
      recommendation: item.repair ? `Stel ${item.repair.key} na goedkeuring in op ${item.repair.value} en lees de waarde terug.` : item.detail,
      risk: severity === 'critical' ? 'hoog' : severity === 'warning' ? 'middel' : 'laag',
      impact: severity === 'critical' ? 'Laden, meten of bereikbaarheid kan uitvallen.' : severity === 'warning' ? 'Werking of diagnose kan onbetrouwbaar zijn.' : 'Geen direct effect gevonden.',
      confidence: item.code === 'WATCHDOG_OK' ? 0.7 : 0.85,
      actionClass: technicianRequired ? 'technician_only' : item.repair ? 'approval_required' : 'advice',
      remotePossible: !!item.repair && !technicianRequired,
      technicianRequired,
      status: 'open',
    };
  });
}

function comparisons(configuration = []) {
  const actual = Object.fromEntries(configuration.map(row => [row.key, row.value]));
  const specs = [
    ['HeartbeatInterval', '300–900 seconden'],
    ['MeterValueSampleInterval', '1–120 seconden'],
    ['ClockAlignedDataInterval', '0–300 seconden'],
    ['SupportedFeatureProfiles', 'Core en voor EMS SmartCharging'],
    ['chg_KWH1', 'Een ondersteund metertype, adres en baudrate'],
    ['com_ProtType', 'OCPP1.6J'],
  ];
  return specs.map(([key, expected]) => ({ key, actual: actual[key] ?? 'Niet ontvangen', expected, proposed: 'Geen automatische wijziging', status: actual[key] == null ? 'unknown' : 'observed' }));
}

export function createRecoveryCaseManager({ getStation, command, changeRoute, getDiagnostic = () => null, actor = () => ({ name: 'dashboard-user', role: 'operator' }), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const cases = [];
  const secrets = new Map();
  const timers = new Map();
  const event = (item, kind, status, title, detail = '') => item.timeline.push({ id: randomUUID(), correlationId: item.correlationId, time: nowIso(), actor: item.actor, role: item.role, kind, status, title, detail });
  const publicSnapshot = () => ({ cases: cases.map(item => {
    const station = getStation(item.stationId);
    return { ...clone(item), liveObservation: OPEN.has(item.status) && station ? redact({ lastSeen: station.lastSeen || null, received: station.received || 0, forwarded: station.forwarded || 0, chargerConnected: !!station.chargerConnected, backendConnected: !!station.backendConnected, latestMessages: (station.ocppMessages || []).slice(0, 20) }) : null };
  }), activeCaseIds: cases.filter(item => OPEN.has(item.status)).map(item => item.id) });

  async function restore(item, reason) {
    if (!OPEN.has(item.status)) return item;
    item.status = 'returning'; item.phase = 'route_control';
    event(item, 'route', 'running', 'Oorspronkelijke route controleren', reason);
    const station = getStation(item.stationId);
    const original = secrets.get(item.id);
    try {
      if (station?.upstream && original && station.upstream !== original) {
        if (typeof changeRoute !== 'function') throw Error('Routering kan in deze omgeving niet worden hersteld.');
        await changeRoute(item.stationId, original);
        event(item, 'route', 'ok', 'Oorspronkelijke route hersteld', item.originalRoute);
      } else event(item, 'route', 'ok', 'Oorspronkelijke route ongewijzigd', item.originalRoute);
      const current = getStation(item.stationId);
      item.snapshotAfter = snapshot(current || station || {});
      item.routeState = 'original';
      const online = !!current?.chargerConnected && !!current?.backendConnected;
      item.outcome = online ? 'repaired' : current?.chargerConnected ? 'partial' : 'not_repaired';
      item.status = reason === 'Maximale behandeltijd bereikt' ? 'timed_out' : 'closed';
      item.phase = 'complete'; item.closedAt = nowIso();
      event(item, 'validation', online ? 'ok' : 'warning', online ? 'Lader en RoboCharge verbonden' : 'Terugkeer vraagt controle', online ? 'Beide OCPP-zijden zijn verbonden.' : 'De route is gecontroleerd, maar beide verbindingen zijn nog niet bevestigd.');
    } catch (error) {
      item.status = 'failed'; item.phase = 'complete'; item.outcome = 'partial'; item.closedAt = nowIso();
      event(item, 'route', 'error', 'Terugkeer naar oorspronkelijke route mislukt', error.message);
    }
    const timer = timers.get(item.id); if (timer) clearTimer(timer); timers.delete(item.id); secrets.delete(item.id);
    return item;
  }

  async function intake(item) {
    const station = () => getStation(item.stationId);
    const call = async (action, payload) => {
      if (!station()?.chargerConnected) throw Error('Geen actieve OCPP-verbinding; opdracht niet afgeleverd.');
      return command(item.stationId, action, payload);
    };
    item.status = 'intake'; item.phase = 'snapshot';
    event(item, 'snapshot', 'ok', 'Uitgangssituatie vastgelegd', 'Configuratie, route, verbinding, connectoren, meter en recente OCPP-data zijn opgeslagen.');
    const checks = [
      ['GetConfiguration', {}, result => Array.isArray(result?.configurationKey) && result.configurationKey.length ? `${result.configurationKey.length} instellingen ontvangen` : 'Geen configuratiewaarden ontvangen'],
      ['TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: item.connectorId }, result => `StatusNotification: ${result?.status || 'geen antwoordstatus'}`],
      ['TriggerMessage', { requestedMessage: 'MeterValues', connectorId: item.connectorId }, result => `MeterValues: ${result?.status || 'geen antwoordstatus'}`],
    ];
    for (const [action, payload, describe] of checks) {
      try {
        const result = await call(action, payload);
        const accepted = action === 'GetConfiguration' ? Array.isArray(result?.configurationKey) && result.configurationKey.length : result?.status === 'Accepted';
        event(item, 'ocpp', accepted ? 'ok' : 'unsupported', action, describe(result));
        item.capabilities[action === 'GetConfiguration' ? 'getConfiguration' : payload.requestedMessage === 'StatusNotification' ? 'triggerStatus' : 'triggerMeter'] = accepted ? 'supported' : 'unavailable';
      } catch (error) {
        event(item, 'ocpp', 'error', action, error.message);
        item.capabilities[action === 'GetConfiguration' ? 'getConfiguration' : payload.requestedMessage === 'StatusNotification' ? 'triggerStatus' : 'triggerMeter'] = 'unavailable';
      }
    }
    item.status = 'analyzing'; item.phase = 'rules';
    const current = station() || {};
    item.snapshotBefore = snapshot(current);
    item.findings = enrichFindings(current, getDiagnostic(item.stationId));
    item.comparisons = comparisons(current.configuration);
    event(item, 'analysis', 'ok', 'Deterministische analyse afgerond', `${item.findings.length} bevindingen vastgelegd; er is niets gewijzigd.`);
    item.status = 'observing'; item.phase = 'observation';
    event(item, 'case', 'ok', 'Veilige observatiemodus actief', 'RoboCharge blijft via de oorspronkelijke route verbonden.');
    return item;
  }

  return {
    snapshot: publicSnapshot,
    open({ stationId, connectorId = 1, maxDurationMinutes = 15 }) {
      const station = getStation(stationId);
      if (!station) throw Error('Selecteer een bekend laadstation.');
      if (cases.some(item => item.stationId === stationId && OPEN.has(item.status))) throw Error('Voor dit laadstation loopt al een herstelcase.');
      const minutes = Number(maxDurationMinutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) throw Error('Kies een maximale behandeltijd van 5 tot 120 minuten.');
      const connectorStatus = station.connectors?.[connectorId]?.status || (connectorId === 1 ? station.status : null);
      if (!Number.isInteger(connectorId) || connectorId < 1) throw Error('Kies een geldige connector.');
      const identity = actor(); const openedAt = nowIso();
      const item = { id: randomUUID(), correlationId: randomUUID(), stationId, connectorId, status: 'intake', phase: 'created', actor: identity.name, role: identity.role, mode: 'diagnostic_sidecar', openedAt, deadlineAt: new Date(Date.now() + minutes * 60_000).toISOString(), closedAt: null, maxDurationMinutes: minutes, originalRoute: maskRoute(station.upstream), routeState: 'unchanged', snapshotBefore: snapshot(station), snapshotAfter: null, findings: [], comparisons: [], capabilities: { protocol: 'OCPP 1.6J', getConfiguration: 'pending', triggerStatus: 'pending', triggerMeter: 'pending', getDiagnostics: 'manual', ocpp201: 'planned', vendorData: 'unavailable' }, timeline: [], outcome: null };
      cases.unshift(item); cases.splice(30); secrets.set(item.id, station.upstream || null);
      event(item, 'case', 'ok', 'Herstelcase geopend', `Connector ${connectorId}: ${connectorStatus || 'status onbekend'}. Behandeltijd ${minutes} minuten.`);
      const timer = setTimer(() => restore(item, 'Maximale behandeltijd bereikt'), minutes * 60_000); timer?.unref?.(); timers.set(item.id, timer);
      const done = intake(item).catch(async error => { event(item, 'case', 'error', 'Intake afgebroken', error.message); await restore(item, 'Intakefout'); });
      return { case: clone(item), done };
    },
    close(caseId) {
      const item = cases.find(entry => entry.id === caseId);
      if (!item) throw Error('Herstelcase niet gevonden.');
      if (!OPEN.has(item.status)) throw Error('Deze herstelcase is al afgesloten.');
      return restore(item, 'Handmatig afgesloten');
    },
  };
}
