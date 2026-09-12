import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket, {WebSocketServer} from 'ws';
import {startCloud} from './cloud-entry.mjs';

test('cloud shutdown closes an active charger connection before waiting for HTTP shutdown', async () => {
  const backend = new WebSocketServer({port: 0, host: '127.0.0.1'});
  await once(backend, 'listening');
  const app = await startCloud({
    port: 0, host: '127.0.0.1', publicHost: 'example.test',
    id: 'shutdown-test', pathSecret: 'shutdown-test-secret',
    authUser: 'test', authPassword: 'test', meterLogFile: null,
    routingFile: 'nonexistent-shutdown-test-routing.json',
    upstream: `ws://127.0.0.1:${backend.address().port}/shutdown-test`
  });
  const backendConnected = once(backend, 'connection');
  const charger = new WebSocket(`ws://127.0.0.1:${app.port}/ocpp/shutdown-test-secret/shutdown-test`, 'ocpp1.6');
  await Promise.all([once(charger, 'open'), backendConnected]);
  const chargerClosed = once(charger, 'close');
  const shutdown = app.close();
  let deadline;
  try {
    await Promise.race([
      shutdown,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Shutdown waited for the charger to disconnect itself')), 1500); })
    ]);
    await chargerClosed;
    assert.equal(charger.readyState, WebSocket.CLOSED);
    assert.equal(app.relay.state.chargerConnected, false);
  } finally {
    clearTimeout(deadline);
    charger.terminate();
    for (const socket of backend.clients) socket.terminate();
    await shutdown;
    await new Promise(resolve => backend.close(resolve));
  }
});
