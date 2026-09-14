import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileGatewayState} from './cloud-entry.mjs';

test('Een open lokale OCPP-socket met echt laderverkeer blijft leidend',()=>{
  const now=Date.now();
  const state=reconcileGatewayState({id:'RBC-0000033',chargerConnected:true,backendConnected:true,lastSeen:new Date(now-600000).toISOString(),connectionDiagnostics:{chargerTrafficSeen:true,lastChargerMessageAt:new Date(now-600000).toISOString()}},{ok:true,chargerConnected:false,backendConnected:false,socketCount:0,gatewayVersion:'2026-09-14.3',checkedAt:now},now);
  assert.equal(state.chargerConnected,true);
  assert.equal(state.backendConnected,true);
  assert.equal(state.commandRouteReady,true);
  assert.equal(state.gatewayHealth.verified,true);
  assert.equal(state.gatewayHealth.socketCount,0);
  assert.equal(state.gatewayHealth.disagreesWithLocal,true);
});

test('Een vastgelopen lokale commandoroute wordt pas na nieuw laderverkeer vrijgegeven',()=>{
  const now=Date.now(),gateway={ok:true,chargerConnected:true,backendConnected:true,socketCount:1,checkedAt:now};
  const stalled=reconcileGatewayState({chargerConnected:true,backendConnected:true,connectionDiagnostics:{chargerTrafficSeen:true,lastChargerMessageAt:new Date(now-30_000).toISOString()},commandHealth:{degraded:true,lastTimeoutAt:new Date(now-10_000).toISOString()}},gateway,now);
  assert.equal(stalled.commandRouteReady,false);
  const recovered=reconcileGatewayState({...stalled,connectionDiagnostics:{chargerTrafficSeen:true,lastChargerMessageAt:new Date(now-1_000).toISOString()}},gateway,now);
  assert.equal(recovered.commandRouteReady,true);
});

test('Verouderde gatewaystatus overschrijft de lokale status niet',()=>{
  const now=Date.now();
  const local={id:'RBC-0000033',chargerConnected:true,backendConnected:true};
  assert.deepEqual(reconcileGatewayState(local,{ok:true,chargerConnected:false,checkedAt:now-46000},now),{...local,commandRouteReady:false});
});

test('Ontbrekende gatewaystatus maakt een stille lokale socket niet diagnosegereed',()=>{
  const local={id:'RBC-0000033',chargerConnected:true,backendConnected:true,connectionDiagnostics:{chargerTrafficSeen:false,lastChargerMessageAt:null}};
  assert.equal(reconcileGatewayState(local,null).commandRouteReady,false);
});

test('Positieve gatewaystatus kan een nog niet bijgewerkte lokale status aanvullen',()=>{
  const now=Date.now();
  const state=reconcileGatewayState({id:'RBC-0000033',chargerConnected:false,backendConnected:false},{ok:true,chargerConnected:true,backendConnected:true,socketCount:1,checkedAt:now},now);
  assert.equal(state.chargerConnected,true);
  assert.equal(state.backendConnected,true);
  assert.equal(state.commandRouteReady,false);
  assert.equal(state.gatewayHealth.disagreesWithLocal,false);
});
