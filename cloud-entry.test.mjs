import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileGatewayState} from './cloud-entry.mjs';

test('Actuele Cloudflare-status corrigeert een verweesde open Render-socket',()=>{
  const now=Date.now();
  const state=reconcileGatewayState({id:'RBC-0000033',chargerConnected:true,backendConnected:true},{ok:true,chargerConnected:false,backendConnected:false,socketCount:0,gatewayVersion:'2026-09-14.2',checkedAt:now},now);
  assert.equal(state.chargerConnected,false);
  assert.equal(state.backendConnected,false);
  assert.equal(state.gatewayHealth.verified,true);
  assert.equal(state.gatewayHealth.socketCount,0);
});

test('Verouderde gatewaystatus overschrijft de lokale status niet',()=>{
  const now=Date.now();
  const local={id:'RBC-0000033',chargerConnected:true,backendConnected:true};
  assert.equal(reconcileGatewayState(local,{ok:true,chargerConnected:false,checkedAt:now-7000},now),local);
});

test('Vers OCPP-verkeer weegt zwaarder dan een fout-negatieve gatewaycontrole',()=>{
  const now=Date.now();
  const state=reconcileGatewayState({id:'RBC-0000033',chargerConnected:true,backendConnected:true,lastSeen:new Date(now-30000).toISOString()},{ok:true,chargerConnected:false,backendConnected:false,socketCount:0,checkedAt:now},now);
  assert.equal(state.chargerConnected,true);
  assert.equal(state.backendConnected,true);
  assert.equal(state.gatewayHealth.disagreesWithTraffic,true);
});
