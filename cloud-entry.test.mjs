import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileGatewayState} from './cloud-entry.mjs';

test('Een open lokale OCPP-socket blijft zonder tijdslimiet leidend',()=>{
  const now=Date.now();
  const state=reconcileGatewayState({id:'RBC-0000033',chargerConnected:true,backendConnected:true,lastSeen:new Date(now-600000).toISOString()},{ok:true,chargerConnected:false,backendConnected:false,socketCount:0,gatewayVersion:'2026-09-14.3',checkedAt:now},now);
  assert.equal(state.chargerConnected,true);
  assert.equal(state.backendConnected,true);
  assert.equal(state.gatewayHealth.verified,true);
  assert.equal(state.gatewayHealth.socketCount,0);
  assert.equal(state.gatewayHealth.disagreesWithLocal,true);
});

test('Verouderde gatewaystatus overschrijft de lokale status niet',()=>{
  const now=Date.now();
  const local={id:'RBC-0000033',chargerConnected:true,backendConnected:true};
  assert.equal(reconcileGatewayState(local,{ok:true,chargerConnected:false,checkedAt:now-46000},now),local);
});

test('Positieve gatewaystatus kan een nog niet bijgewerkte lokale status aanvullen',()=>{
  const now=Date.now();
  const state=reconcileGatewayState({id:'RBC-0000033',chargerConnected:false,backendConnected:false},{ok:true,chargerConnected:true,backendConnected:true,socketCount:1,checkedAt:now},now);
  assert.equal(state.chargerConnected,true);
  assert.equal(state.backendConnected,true);
  assert.equal(state.gatewayHealth.disagreesWithLocal,false);
});
