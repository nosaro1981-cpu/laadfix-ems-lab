import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryCenter, recoveryGuard } from './recovery-center.mjs';
import { startEMS } from './ems-server.mjs';

function fixture(override = {}) {
  const station = { id: 'TEST-B', chargerConnected: true, backendConnected: true, status: 'Available', activeTransaction: false, connectors: { 1: { status: 'Available', errorCode: 'NoError', time: 'old' }, 2: { status: 'Available', errorCode: 'NoError', time: 'old' } }, configuration: [{ key: 'NumberOfConnectors', value: '2' }, { key: 'MeterValueSampleInterval', value: '500' }, { key: 'grid_Role', value: 'master' }, { key: 'grid_SupervisorClientCount', value: '0' }], ...override };
  const calls = [];
  const command = async (id, action, payload) => {
    calls.push({ id, action, payload });
    if (action === 'GetConfiguration') return { configurationKey: structuredClone(station.configuration) };
    if (action === 'ChangeConfiguration') { station.configuration.find(r => r.key === payload.key).value = payload.value; return { status: 'Accepted' }; }
    if (action === 'TriggerMessage' && payload.requestedMessage === 'StatusNotification') station.connectors[payload.connectorId] = { status: 'Available', errorCode: 'NoError', time: String(calls.length) };
    if (action === 'TriggerMessage' && payload.requestedMessage === 'MeterValues') {
      station.lastMeterValues = String(calls.length); station.meterValues = { connectorId: payload.connectorId, meterValue: [{ sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '2345', unit: 'Wh' }] }] };
    }
    return { status: action === 'UnlockConnector' ? 'Unlocked' : 'Accepted' };
  };
  const center = createRecoveryCenter({ getStation: id => id === station.id ? station : null, command, checkNetwork: async () => ({ ok: true, host: 'backend.test', lines: ['DNS gecontroleerd'] }), waitMs: 5 });
  return { station, calls, command, center };
}
async function run(center, action, connectorId = 2) { const run = center.start({ stationId: 'TEST-B', connectorId, action }); await run.done; return run.job; }

test('Diagnose leest alleen uit en richt status en meterdata op de gekozen connector', async () => {
  const f = fixture(), job = await run(f.center, 'analyze');
  assert.equal(job.status, 'ok'); assert.equal(job.steps.length, 5);
  assert.ok(f.calls.every(c => c.id === 'TEST-B' && ['GetConfiguration', 'TriggerMessage'].includes(c.action)));
  assert.ok(f.calls.filter(c => c.action === 'TriggerMessage').every(c => c.payload.connectorId === 2));
  assert.match(job.steps[3].detail, /2345 Wh/);
});
test('Geaccepteerd verzoek zonder nieuwe waarden wordt geen geslaagde meting', async () => {
  const f = fixture(); const center = createRecoveryCenter({ getStation: () => f.station, command: async () => ({ status: 'Accepted' }), waitMs: 5 });
  const job = await run(center, 'status'); assert.equal(job.status, 'warning'); assert.match(job.steps[0].detail, /geen nieuw statusbericht/);
});
test('Status van andere connector bevestigt de gekozen connector niet', async () => {
  const f = fixture(); const center = createRecoveryCenter({ getStation: () => f.station, command: async () => { f.station.connectors[1].time = 'new'; return { status: 'Accepted' }; }, waitMs: 5 });
  assert.equal((await run(center, 'status', 2)).status, 'warning');
});
test('Rejected, NotImplemented en OCPP-fouten worden duidelijk als onvolledig of fout getoond', async () => {
  for (const response of [{ status: 'Rejected' }, { status: 'NotImplemented' }, { errorCode: 'InternalError' }]) {
    const f = fixture(), center = createRecoveryCenter({ getStation: () => f.station, command: async () => response, waitMs: 5 });
    const job = await run(center, 'status'); assert.notEqual(job.status, 'ok'); assert.match(job.steps[0].detail, /Rejected|NotImplemented|InternalError/);
  }
});
test('Gepauzeerde sessie op connector 2 blokkeert stationreset en ontgrendelen', () => {
  const f = fixture(); f.station.connectors[2].status = 'SuspendedEVSE';
  assert.match(recoveryGuard(f.station), /gepauzeerde/);
  for (const action of ['softReset', 'unlock', 'operative', 'clearCache', 'clearTestProfile', 'meterInterval']) assert.throws(() => f.center.start({ stationId: f.station.id, connectorId: 1, action }), /laadsessie/);
  assert.equal(f.calls.length, 0);
});
test('Unlock-resultaat gebruikt Unlocked; testprofiel wissen raakt alleen profiel 900001', async () => {
  const f = fixture(); assert.equal((await run(f.center, 'unlock')).status, 'ok');
  await run(f.center, 'clearTestProfile');
  assert.deepEqual(f.calls.at(-1), { id: 'TEST-B', action: 'ClearChargingProfile', payload: { id: 900001 } });
});
test('Meetinterval toont oude en werkelijk teruggelezen waarde', async () => {
  const f = fixture(), job = await run(f.center, 'meterInterval');
  assert.equal(job.status, 'ok'); assert.match(job.steps.at(-1).detail, /Oude waarde: 500.*Teruggelezen: 60/);
  assert.deepEqual(f.calls.filter(c => c.action === 'ChangeConfiguration').map(c => c.payload), [{ key: 'MeterValueSampleInterval', value: '60' }]);
});
test('Grid-rapport interpreteert supervisorclientcount niet als bevestigd aantal slaves', async () => {
  const f = fixture(), job = await run(f.center, 'grid');
  assert.match(job.steps[0].detail, /CAN-slaves: onbekend/);
  assert.match(job.steps[0].detail, /grid_SupervisorClientCount: 0/);
});
test('Geen automatische reset bij storing; geschiedenis blijft bewaard', async () => {
  const f = fixture({ status: 'Faulted' }); f.station.connectors[2] = { status: 'Faulted', errorCode: 'PowerMeterFailure', time: 'old' };
  const center = createRecoveryCenter({ getStation: () => f.station, command: async (id, action, payload) => { f.calls.push({ id, action, payload }); return action === 'GetConfiguration' ? { configurationKey: f.station.configuration } : { status: 'Rejected' }; }, waitMs: 5 });
  await run(center, 'analyze'); await run(center, 'grid');
  assert.equal(center.snapshot().jobs.length, 2); assert.ok(!f.calls.some(c => c.action === 'Reset'));
});
test('Herstel-API bewaart resultaat per station en weigert onbekende targets', async () => {
  const f = fixture(), app = await startEMS({ port: 0, hardware: false, fleetProvider: () => [f.station], fleetCommander: f.command });
  const base = `http://127.0.0.1:${app.port}`;
  const post = body => fetch(base + '/api/recovery', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ id: 'OTHER', action: 'softReset' })).status, 400);
    assert.equal((await post({ id: f.station.id, action: 'toString' })).status, 400);
    assert.equal((await post({ id: f.station.id, connectorId: 99, action: 'status' })).status, 400);
    const response = await post({ id: f.station.id, connectorId: 2, action: 'analyze' }); assert.equal(response.status, 202);
    for (let i = 0; i < 30; i++) { const state = await (await fetch(base + '/api/state')).json(); if (state.recovery.jobs[0]?.status !== 'running') break; await new Promise(r => setTimeout(r, 30)); }
    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.recovery.jobs[0].stationId, f.station.id); assert.equal(state.recovery.jobs[0].connectorId, 2); assert.equal(state.recovery.jobs[0].status, 'ok');
    assert.equal((await fetch(base + '/recovery-ui.mjs')).status, 200); assert.equal((await fetch(base + '/recovery.css')).status, 200);
    f.station.connectors[2].status = 'Charging'; assert.equal((await post({ id: f.station.id, connectorId: 1, action: 'softReset' })).status, 400);
  } finally { await app.close(); }
});

test('Een lopende controle blokkeert een tweede opdracht', async () => {
  const f = fixture(); let finish;
  const center = createRecoveryCenter({ getStation: () => f.station, command: () => new Promise(resolve => { finish = resolve; }) });
  const first = center.start({ stationId: f.station.id, connectorId: 1, action: 'configuration' });
  assert.throws(() => center.start({ stationId: f.station.id, connectorId: 2, action: 'softReset' }), /al een controle/);
  finish({ configurationKey: f.station.configuration }); await first.done;
  assert.equal(first.job.status, 'ok');
});
