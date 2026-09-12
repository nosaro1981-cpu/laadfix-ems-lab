import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {startRelay,normalizeUpstream,classifyConnectionFailure,sanitizeOcppPayload} from './relay.mjs';
test('Proxybestemming accepteert alleen OCPP WebSocket-routes met laadpaal-ID',()=>{
 assert.equal(normalizeUpstream('wss://example.test/ocpp/#OSN#','TEST'),'wss://example.test/ocpp/TEST');
 assert.throws(()=>normalizeUpstream('https://example.test/TEST','TEST'));
 assert.throws(()=>normalizeUpstream('ws://user:secret@example.test/TEST','TEST'));
 assert.throws(()=>normalizeUpstream('ws://example.test/OTHER','TEST'));
});
test('Verbindingsfouten krijgen een begrijpelijke oorzaak',()=>{
 assert.equal(classifyConnectionFailure('Robo Charge','getaddrinfo ENOTFOUND ocpp.example').type,'dns');
 assert.equal(classifyConnectionFailure('Robo Charge','Unexpected server response: 403').type,'handshake');
 assert.equal(classifyConnectionFailure('Homebox','socket hang up').type,'charger');
});
test('OCPP-verkeerslog schermt passen en FTP-wachtwoorden af',()=>{
 const value=sanitizeOcppPayload({idTag:'PRIVATE-TAG',location:'ftp://user:password@example.test/log.txt'});
 assert.equal(value.idTag,'[afgeschermd]');assert.equal(value.location,'ftp://***:***@example.test/log.txt');
});
test('Homebox en backoffice ontvangen exact dezelfde berichten via relay', {timeout:10000},async()=>{
 const backend=new WebSocketServer({port:0,host:'127.0.0.1',handleProtocols:()=> 'ocpp1.6'});await once(backend,'listening');
 const app=await startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'127.0.0.1',id:'TEST',upstream:'ws://127.0.0.1:'+backend.address().port+'/TEST',meterLogFile:null});
 let charger,up,charger2,up2;
 try{
 const connected=once(backend,'connection');charger=new WebSocket('ws://127.0.0.1:'+app.port+'/ocpp/TEST','ocpp1.6');await once(charger,'open');[up]=await connected;
 async function forward(sender,receiver,raw){const received=once(receiver,'message');sender.send(raw);assert.equal((await received)[0].toString(),raw);}
 await forward(charger,up,'[2,"boot-1","BootNotification",{"chargePointVendor":"Ecotap","chargePointModel":"TEST","firmwareVersion":"TEST","iccid":"89462038075016961884","imsi":"240075823773701","meterType":"Eastron SDM72D","meterSerialNumber":"21280066"}]');
 await forward(up,charger,'[3,"boot-1",{"status":"Accepted","currentTime":"2026-09-09T00:00:00Z","interval":60}]');
 await forward(charger,up,'[2,"auth","Authorize",{"idTag":"TEST-TAG"}]');
 await forward(up,charger,'[3,"auth",{"idTagInfo":{"status":"Accepted"}}]');
 await forward(up,charger,'[2,"read-1","GetConfiguration",{"key":["HeartbeatInterval"]}]');
 await forward(charger,up,'[3,"read-1",{"configurationKey":[]}]');
 await forward(up,charger,'[2,"diag-1","GetDiagnostics",{"location":"ftp://diagnostics:topsecret@example.test","startTime":"2026-09-11T22:00:00Z","stopTime":"2026-09-11T22:05:00Z"}]');
 await forward(charger,up,'[3,"diag-1",{"fileName":"TEST-diag.txt"}]');
 await forward(charger,up,'[2,"status-1","StatusNotification",{"connectorId":1,"status":"Faulted","errorCode":"PowerMeterFailure"}]');
 await forward(charger,up,'[2,"meter-1","MeterValues",{"connectorId":1,"meterValue":[{"timestamp":"2026-09-10T07:16:54Z","sampledValue":[{"measurand":"Energy.Active.Import.Register","unit":"Wh","value":"149"},{"measurand":"Voltage","phase":"L1","unit":"V","value":"232.8"}]}]}]');
 assert.equal(app.state.connectors[1].errorCode,'PowerMeterFailure');assert.equal(app.state.forwarded,10);assert.equal(app.state.meterHistory[0].energy.value,149);assert.ok(app.state.meterHistory[0].forwardedAt);assert.equal(app.state.remoteDiagnostics.fileName,'TEST-diag.txt');assert.equal(app.state.remoteDiagnostics.locationHost,'example.test');assert.equal(app.state.boot.meterType,'Eastron SDM72D');assert.equal(app.state.boot.meterSerialNumber,'21280066');assert.equal(app.state.boot.iccid,'89462038075016961884');assert.ok(!JSON.stringify(app.state).includes('TEST-TAG'));assert.ok(!JSON.stringify(app.state).includes('topsecret'));
 const disconnected=once(charger,'close');up.close();await disconnected;assert.equal(app.state.backendConnected,false);
 const reconnected=once(backend,'connection');charger2=new WebSocket('ws://127.0.0.1:'+app.port+'/ocpp/TEST','ocpp1.6');await once(charger2,'open');[up2]=await reconnected;
 await forward(charger2,up2,'[2,"boot-2","BootNotification",{"chargePointVendor":"Ecotap","chargePointModel":"TEST"}]');
 assert.equal(app.state.chargerConnected,true);assert.equal(app.state.backendConnected,true);assert.equal(app.state.connectionDiagnostics.stage,'online');assert.ok(app.state.connectionDiagnostics.lastIngressAt);assert.ok(app.state.connectionDiagnostics.lastBackendConnectedAt);assert.ok(app.state.connectionTimeline.some(row=>row.type==='backend_connected'));assert.ok(app.state.connectionTimeline.some(row=>row.type==='charger_traffic'));
 }finally{charger?.terminate();up?.terminate();charger2?.terminate();up2?.terminate();await app.close();await new Promise(r=>backend.close(r));}
});
test('Relay wijst een andere laadpaal-ID af', {timeout:5000},async()=>{
 const app=await startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'127.0.0.1',id:'TEST',upstream:'ws://127.0.0.1/TEST',meterLogFile:null});
 try{const ws=new WebSocket('ws://127.0.0.1:'+app.port+'/ocpp/OTHER','ocpp1.6');ws.on('error',()=>{});const [,res]=await once(ws,'unexpected-response');assert.equal(res.statusCode,403);ws.terminate();assert.equal(app.state.chargerConnected,false);assert.equal(app.state.connectionDiagnostics.lastFailureType,'path');assert.equal(app.state.connectionDiagnostics.rejectedUpgrades,1);assert.ok(app.state.connectionTimeline.some(row=>row.type==='rejected'));}finally{await app.close();}
});
test('Online relay vereist ook het geheime OCPP-pad', {timeout:5000},async()=>{
 const app=await startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'*',id:'TEST',pathSecret:'geheim-pad-met-minimaal-24-tekens',upstream:'ws://127.0.0.1/TEST',meterLogFile:null});
 try{const ws=new WebSocket('ws://127.0.0.1:'+app.port+'/ocpp/TEST','ocpp1.6');ws.on('error',()=>{});const [,res]=await once(ws,'unexpected-response');assert.equal(res.statusCode,403);ws.terminate();}finally{await app.close();}
});
test('Lokale serviceopdracht gaat alleen naar de Homebox en verwerkt antwoord', {timeout:5000},async()=>{
 const backend=new WebSocketServer({port:0,host:'127.0.0.1',handleProtocols:()=> 'ocpp1.6'});await once(backend,'listening');
 const app=await startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'127.0.0.1',id:'TEST',upstream:'ws://127.0.0.1:'+backend.address().port+'/TEST',meterLogFile:null});
 let charger,up;
 try{
  const connected=once(backend,'connection');charger=new WebSocket('ws://127.0.0.1:'+app.port+'/ocpp/TEST','ocpp1.6');await once(charger,'open');[up]=await connected;
  const incoming=once(charger,'message');
  const request=fetch('http://127.0.0.1:'+app.monitorPort+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'TriggerMessage',payload:{requestedMessage:'StatusNotification',connectorId:1}})});
  const call=JSON.parse((await incoming)[0].toString());assert.equal(call[2],'TriggerMessage');charger.send(JSON.stringify([3,call[1],{status:'Accepted'}]));
  const response=await request;assert.equal(response.status,200);assert.equal((await response.json()).result.status,'Accepted');
  let forwarded=false;up.once('message',()=>forwarded=true);await new Promise(r=>setTimeout(r,30));assert.equal(forwarded,false);
 }finally{charger?.terminate();up?.terminate();await app.close();await new Promise(r=>backend.close(r));}
});

test('GetConfiguration wordt opgeslagen en ChangeConfiguration werkt de actuele waarde bij', {timeout:5000},async()=>{
 const backend=new WebSocketServer({port:0,host:'127.0.0.1',handleProtocols:()=> 'ocpp1.6'});await once(backend,'listening');
 const app=await startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'127.0.0.1',id:'CONFIG',upstream:'ws://127.0.0.1:'+backend.address().port+'/CONFIG',meterLogFile:null});
 let charger,up;
 try{
  const connected=once(backend,'connection');charger=new WebSocket('ws://127.0.0.1:'+app.port+'/ocpp/CONFIG','ocpp1.6');await once(charger,'open');[up]=await connected;
  const call=async(action,payload,result)=>{const incoming=once(charger,'message'),request=fetch('http://127.0.0.1:'+app.monitorPort+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});const frame=JSON.parse((await incoming)[0].toString());assert.equal(frame[2],action);charger.send(JSON.stringify([3,frame[1],result]));assert.equal((await request).status,200);};
  await call('GetConfiguration',{}, {configurationKey:[{key:'HeartbeatInterval',readonly:false,value:'900'},{key:'NumberOfConnectors',readonly:true,value:'1'}],unknownKey:[]});
  assert.deepEqual(app.state.configuration,[{key:'HeartbeatInterval',readonly:false,value:'900'},{key:'NumberOfConnectors',readonly:true,value:'1'}]);
  await call('ChangeConfiguration',{key:'HeartbeatInterval',value:'60'},{status:'Accepted'});
  assert.equal(app.state.configuration.find(row=>row.key==='HeartbeatInterval').value,'60');assert.ok(app.state.configurationUpdatedAt);
 }finally{charger?.terminate();up?.terminate();await app.close();await new Promise(r=>backend.close(r));}
});
