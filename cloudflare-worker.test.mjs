import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{OcppGateway,parseChargerId} from './cloudflare/worker.js';

test('Cloudflare accepteert meerdere geldige OCPP-IDs en isoleert hun verbindingen', async () => {
  const names=[];
  const env={OCPP_GATEWAY:{idFromName:name=>{names.push(name);return name;},get:id=>({fetch:async()=>new Response(id)})}};
  for(const stationId of ['RBC-0000032','RBC-0000099']){
    const request={url:`https://gateway.example/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/${stationId}`,headers:new Headers({Upgrade:'websocket','Sec-WebSocket-Protocol':'ocpp1.6'})};
    const response=await worker.fetch(request,env);
    assert.match(await response.text(),new RegExp(stationId+'$'));
  }
  assert.notEqual(names[0],names[1]);
  assert.equal(parseChargerId('/ocpp/verkeerd/RBC-0000099'),null);
  assert.equal(parseChargerId('/ocpp/lfx-ocpp-2026-RBC0000032-7Qm9Xp4Vt8Ks/ongeldig/id'),null);
});

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

test('Cloudflare health kan ieder geregistreerd serienummer gericht wakker maken', async () => {
  const names=[];
  const env={OCPP_GATEWAY:{
    idFromName:name=>{names.push(name);return name;},
    get:()=>({fetch:async()=>Response.json({ok:true,chargerConnected:true,backendConnected:false})})
  }};
  const response=await worker.fetch(new Request('https://gateway.example/health?station=ELC-4202370'),env);
  const status=await response.json();
  assert.equal(status.station,'ELC-4202370');
  assert.equal(status.chargerConnected,true);
  assert.match(names[0],/ELC-4202370$/);
});

test('Cloudflare bewaart de BootNotification zonder de ladersocket te sluiten', async () => {
  const stored=[];
  const message='[2,"boot-1","BootNotification",{"chargePointModel":"DUO2"}]';
  const charger={readyState:1,deserializeAttachment:()=>({path:'/ocpp/test/charger'}),serializeAttachment:()=>{}};
  const ctx={
    getWebSockets:()=>[charger],
    waitUntil:promise=>promise.catch(()=>{}),
    storage:{put:async(key,value)=>stored.push({key,value}),setAlarm:async()=>{},deleteAlarm:async()=>{}}
  };
  const gateway=new OcppGateway(ctx);
  gateway.activeCharger=charger;
  gateway.backend={readyState:1,send:()=>{}};
  await gateway.webSocketMessage(charger,message);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(stored,[{key:'lastBootMessage',value:message}]);
  assert.equal(gateway.activeCharger,charger);
});

test('Cloudflare speelt de bewaarde BootNotification af na alleen een serverherstart', async () => {
  const sent=[];
  const cached='[2,"boot-old","BootNotification",{"chargePointModel":"DUO2"}]';
  const ctx={
    getWebSockets:()=>[],
    waitUntil:promise=>promise.catch(()=>{}),
    storage:{get:async key=>key==='lastBootMessage'?cached:null,setAlarm:async()=>{},deleteAlarm:async()=>{}}
  };
  const gateway=new OcppGateway(ctx);
  gateway.queue.push('[2,"heartbeat-1","Heartbeat",{}]');
  await gateway.flushBackendQueue({send:message=>sent.push(message)});
  assert.deepEqual(sent,[cached,'[2,"heartbeat-1","Heartbeat",{}]']);
});

test('Abnormale Homeboxsluiting sluit ook de Render-socket met een geldige code', async () => {
  const closed=[];
  const charger={readyState:1};
  const ctx={
    getWebSockets:()=>[],
    waitUntil:promise=>promise.catch(()=>{}),
    storage:{setAlarm:async()=>{},deleteAlarm:async()=>{}}
  };
  const gateway=new OcppGateway(ctx);
  gateway.activeCharger=charger;
  gateway.backend={close:(code,reason)=>closed.push({code,reason})};
  gateway.webSocketClose(charger,1006,'WebSocket disconnected without sending Close frame.');
  assert.equal(closed.length,1);
  assert.equal(closed[0].code,1012);
  assert.match(closed[0].reason,/disconnected/i);
  assert.equal(gateway.backend,null);
});
