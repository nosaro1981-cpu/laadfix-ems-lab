import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryCaseManager, maskIdentifier, maskRoute } from './recovery-case-manager.mjs';
import { startEMS } from './ems-server.mjs';

function fixture(overrides = {}) {
  const station = {
    id: 'RBC-TEST', chargerConnected: true, backendConnected: true, upstream: 'ws://backend.example/ocpp/very-secret/RBC-TEST', status: 'Available', errorCode: 'NoError', lastSeen: new Date().toISOString(), lastHeartbeat: new Date().toISOString(),
    boot: { chargePointVendor: 'Ecotap', iccid: '89462038075016961884', imsi: '240075823773701' }, connectors: { 1: { status: 'Available', errorCode: 'NoError' } }, configuration: [{ key: 'HeartbeatInterval', value: '900' }, { key: 'MeterValueSampleInterval', value: '60' }, { key: 'chg_KWH1', value: 'EASTR_SDM72D,1,9600,N,1' }, { key: 'SupportedFeatureProfiles', value: 'Core,SmartCharging' }, { key: 'com_Endpoint', value: 'ws://ocpp.example/ocppopter/configlk/RBC-TEST' }], meterHistory: [], ocppMessages: [], connectionTimeline: [], ...overrides,
  };
  const calls = [], routes = [];
  const command = async (_id, action, payload) => { calls.push({ action, payload }); return action === 'GetConfiguration' ? { configurationKey: station.configuration } : { status: 'Accepted' }; };
  const manager = createRecoveryCaseManager({ getStation: id => id === station.id ? station : null, command, changeRoute: async (_id, route) => { routes.push(route); station.upstream = route; }, actor: () => ({ name: 'tester', role: 'operator' }) });
  return { station, calls, routes, manager };
}

test('Case-intake is read-only, bewaart bevindingen en maskeert geheimen', async () => {
  const f = fixture(); const opened = f.manager.open({ stationId: f.station.id, connectorId: 1, maxDurationMinutes: 5 }); await opened.done;
  const item = f.manager.snapshot().cases[0];
  assert.equal(item.status, 'observing');
  assert.deepEqual(f.calls.map(call => call.action), ['GetConfiguration', 'TriggerMessage', 'TriggerMessage']);
  assert.ok(!f.calls.some(call => ['ChangeConfiguration', 'Reset', 'UpdateFirmware'].includes(call.action)));
  assert.match(item.originalRoute, /••••/); assert.doesNotMatch(JSON.stringify(item), /very-secret|configlk|89462038075016961884|240075823773701/);
  assert.ok(item.findings.length); assert.ok(item.findings.every(row => row.actual && row.expected && row.recommendation && row.evidence.length));
});

test('Afsluiten herstelt alleen een afwijkende route en controleert verbindingen', async () => {
  const f = fixture(); const opened = f.manager.open({ stationId: f.station.id, maxDurationMinutes: 5 }); await opened.done;
  f.station.upstream = 'ws://wrong.example/RBC-TEST';
  const closed = await f.manager.close(opened.case.id);
  assert.deepEqual(f.routes, ['ws://backend.example/ocpp/very-secret/RBC-TEST']);
  assert.equal(closed.status, 'closed'); assert.equal(closed.outcome, 'repaired'); assert.equal(closed.routeState, 'original');
});

test('Onbekende, dubbele en te lange cases worden geweigerd', async () => {
  const f = fixture(); assert.throws(() => f.manager.open({ stationId: 'UNKNOWN', maxDurationMinutes: 5 }), /bekend/);
  assert.throws(() => f.manager.open({ stationId: f.station.id, maxDurationMinutes: 3 }), /5 tot 120/);
  const opened = f.manager.open({ stationId: f.station.id, maxDurationMinutes: 5 });
  assert.throws(() => f.manager.open({ stationId: f.station.id, maxDurationMinutes: 5 }), /al een herstelcase/); await opened.done;
});

test('Masking laat alleen het noodzakelijke herkenningsdeel zien', () => {
  assert.equal(maskIdentifier('1234567890'), '••••••7890');
  assert.match(maskRoute('wss://proxy.example/ocpp/token/STATION-1'), /^wss:\/\/proxy\.example\/ocpp\/••••\/STATION-1$/);
});

test('Dashboard-API opent en sluit een diagnosecase', async () => {
  const f = fixture();
  const app = await startEMS({ port: 0, hardware: false, fleetProvider: () => [f.station], fleetCommander: async (id, action, payload) => f.manager ? (action === 'GetConfiguration' ? { configurationKey: f.station.configuration } : { status: 'Accepted' }) : null, fleetRouteChanger: async (_id, route) => { f.station.upstream = route; return { upstream: route }; } });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const openedResponse = await post('/api/recovery-case/open', { id: f.station.id, connectorId: 1, maxDurationMinutes: 5 });
    assert.equal(openedResponse.status, 202); const opened = await openedResponse.json();
    for (let i = 0; i < 20; i++) { const state = await (await fetch(base + '/api/state')).json(); if (state.recovery.cases[0]?.status === 'observing') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    const state = await (await fetch(base + '/api/state')).json(); assert.equal(state.recovery.cases[0].status, 'observing');
    const closed = await post('/api/recovery-case/close', { caseId: opened.case.id }); assert.equal(closed.status, 200);
    assert.equal((await closed.json()).case.status, 'closed');
  } finally { await app.close(); }
});
