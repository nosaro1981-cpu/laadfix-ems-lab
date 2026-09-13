import test from 'node:test';
import assert from 'node:assert/strict';
import {OcppGateway} from './cloudflare/worker.js';

test('Cloudflare gateway heropent Render zonder op een nieuw laderbericht te wachten', async () => {
  const alarms=[];
  const charger={readyState:1,deserializeAttachment:()=>({path:'/ocpp/test/charger'})};
  const ctx={
    getWebSockets:()=>[charger],
    waitUntil:promise=>promise.catch(()=>{}),
    storage:{setAlarm:async value=>alarms.push(value),deleteAlarm:async()=>{}}
  };
  const gateway=new OcppGateway(ctx);
  let openedPath=null;
  gateway.openBackend=async path=>{openedPath=path;gateway.backend={readyState:1};};
  await gateway.scheduleBackendReconnect(1000);
  assert.equal(alarms.length,1);
  await gateway.alarm();
  assert.equal(openedPath,'/ocpp/test/charger');
  assert.equal(gateway.activeCharger,charger);
});

test('Cloudflare gateway plant na een mislukte herstelpoging snel een nieuwe poging', async () => {
  const alarms=[];
  const charger={readyState:1,deserializeAttachment:()=>({path:'/ocpp/test/charger'})};
  const ctx={
    getWebSockets:()=>[charger],
    waitUntil:promise=>promise.catch(()=>{}),
    storage:{setAlarm:async value=>alarms.push(value),deleteAlarm:async()=>{}}
  };
  const gateway=new OcppGateway(ctx);
  gateway.openBackend=async()=>{throw Error('Render start nog op');};
  await gateway.alarm();
  assert.equal(gateway.backendRetryAttempt,1);
  assert.equal(alarms.length,1);
  assert.ok(alarms[0]-Date.now()<=2500);
});

test('Cloudflare gateway vervangt ook een stille backendverbinding zonder laderbericht', async () => {
  const alarms=[];
  let closed=false,opened=0;
  const charger={readyState:1,deserializeAttachment:()=>({path:'/ocpp/test/charger'})};
  const ctx={
    getWebSockets:()=>[charger],
    waitUntil:promise=>promise.catch(()=>{}),
    storage:{setAlarm:async value=>alarms.push(value),deleteAlarm:async()=>{}}
  };
  const gateway=new OcppGateway(ctx);
  gateway.backend={readyState:1,close:()=>{closed=true;}};
  gateway.backendHealthy=async()=>false;
  gateway.openBackend=async()=>{opened+=1;gateway.backend={readyState:1};};
  await gateway.alarm();
  assert.equal(closed,true);
  assert.equal(opened,1);
});

test('Cloudflare wake activeert herstel voor een bewaarde Homeboxsocket', async () => {
  const alarms=[];
  const charger={readyState:1,deserializeAttachment:()=>({path:'/ocpp/test/charger'})};
  const ctx={
    getWebSockets:()=>[charger],
    waitUntil:promise=>promise.catch(()=>{}),
    storage:{setAlarm:async value=>alarms.push(value),deleteAlarm:async()=>{}}
  };
  const gateway=new OcppGateway(ctx);
  const response=await gateway.fetch(new Request('https://ocpp-gateway.internal/_wake'));
  const status=await response.json();
  assert.equal(status.chargerConnected,true);
  assert.equal(status.backendConnected,false);
  assert.equal(alarms.length,1);
});
