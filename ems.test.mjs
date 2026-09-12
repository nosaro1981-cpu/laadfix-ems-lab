import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {defaults,calculate,validate,createEngine,simulatedFleet} from './ems.mjs';
import {assessMeterIdentity} from './connection-intelligence.mjs';
import {startEMS,privateIPv4,colourForStatus,assessService,extractMeterReadings,mergePrimaryFleetState} from './ems-server.mjs';
import {recoveryDecision,createRecoveryMonitor} from './power-recovery.mjs';
test('Laadpaalstatus kiest de juiste lampkleur',()=>{
 assert.equal(colourForStatus('Available'), 'green');
 assert.equal(colourForStatus('Faulted'), 'red');
 assert.equal(colourForStatus('Unavailable'), 'red');
 assert.equal(colourForStatus('Charging'), 'blue');
 assert.equal(colourForStatus('SuspendedEV'), 'blue');
 assert.equal(colourForStatus('Available',false,true), 'red');
});
test('Servicediagnose onderscheidt proxy, Homebox, backoffice en storing',()=>{
 const now=Date.parse('2026-09-10T10:00:00Z');
 const base={relayReachable:true,chargerConnected:true,backendConnected:true,status:'Available',effectiveStatus:'Available',errorCode:'NoError',lastSeen:'2026-09-10T09:59:30Z'};
 assert.equal(assessService(base,now).severity,'ok');
 assert.match(assessService({...base,chargerConnected:false},now).summary,/Homebox/);
 assert.match(assessService({...base,backendConnected:false},now).summary,/Robo Charge/);
 assert.equal(assessService({...base,status:'Faulted',effectiveStatus:'Faulted',errorCode:'PowerMeterFailure'},now).severity,'warning');
 assert.equal(assessService({...base,activeTransaction:true},now).activeTransaction,true);
});
test('Fysieke herstart komt pas na vijf minuten en nooit tijdens laden',()=>{
 const now=Date.parse('2026-09-10T10:00:00Z'),offline={chargerConnected:false,status:'Offline',activeTransaction:false};
 assert.equal(recoveryDecision(offline,{now,offlineSince:now-299000,configured:true}).stage,'waiting');
 assert.equal(recoveryDecision(offline,{now,offlineSince:now-301000,configured:false}).stage,'relay-needed');
 assert.equal(recoveryDecision(offline,{now,offlineSince:now-301000,configured:true}).ready,true);
 assert.equal(recoveryDecision({...offline,status:'Charging'},{now,offlineSince:now-600000,configured:true}).stage,'blocked');
 assert.equal(recoveryDecision({chargerConnected:true,backendConnected:false,status:'Available'},{now,configured:true}).stage,'upstream');
 const monitor=createRecoveryMonitor();monitor.observe(offline,now-301000);assert.equal(monitor.snapshot(offline,now).stage,'relay-needed');
});
test('OCPP MeterValues worden uit de proxywaarde gelezen en op ouderdom bewaakt',()=>{
 const now=Date.parse('2026-09-10T10:02:00Z');
 const meter={time:'2026-09-10T10:00:00Z',meterValue:[{timestamp:'2026-09-10T10:00:00Z',sampledValue:[{value:'12345',measurand:'Energy.Active.Import.Register',unit:'Wh'},{value:'6900',measurand:'Power.Active.Import',unit:'W'},{value:'10',measurand:'Current.Import',unit:'A'}]}]};
 const result=extractMeterReadings(meter,null,now);assert.equal(result.energy.value,12345);assert.equal(result.power.value,6900);assert.equal(result.current.value,10);assert.equal(result.ageSeconds,120);assert.equal(result.stale,true);
 assert.equal(extractMeterReadings(null,null,now).sampleCount,0);
});
test('Zonne-overschot, fasegrens en ontbrekende meetgegevens',()=>{
 const s=structuredClone(defaults);let r=calculate(s);assert.equal(r.desiredA,7.2);assert.ok(r.chargeW<=5000);assert.ok(r.gridW<=0);
 s.pvW=1000;assert.equal(calculate(s).desiredA,0);
 s.mode='fast';s.pvW=0;s.homeW=[5000,0,0];assert.equal(calculate(s).desiredA,0);
 s.homeW=[2000,0,0];r=calculate(s);assert.ok(r.gridPhaseA[0]<=24);
 s.meterOk=false;assert.equal(calculate(s).desiredA,0);
 s.meterOk=true;s.connected=false;assert.equal(calculate(s).desiredA,0);
 s.connected=true;s.mode='off';assert.equal(calculate(s).desiredA,0);
 assert.throws(()=>validate({...s,limitA:NaN}));assert.throws(()=>validate({...s,homeW:[0]}));
});
test('Startvertraging, onmiddellijke stop en veilige fasewisseling in simulatie',()=>{
 const e=createEngine();assert.equal(e.tick(0).result.actualA,0);assert.equal(e.tick(4999).result.actualA,0);assert.equal(e.tick(5000).result.actualA,7.2);
 e.set({...structuredClone(defaults),pvW:0});assert.equal(e.tick(6000).result.actualA,0);
 e.set({...structuredClone(defaults),mode:'fast'});assert.equal(e.tick(7000).result.actualA,0);assert.equal(e.tick(12000).result.actualA,16);
 e.set({...structuredClone(defaults),mode:'fast',phases:1});assert.equal(e.tick(13000).result.actualA,0);
});
test('Primaire dashboardstatus neemt OCPP-diagnose uit de actuele vloot over',()=>{
 const charger={id:'RBC-1',chargerConnected:true,backendConnected:true};
 const diagnostics={bootAccepted:false,chargerTrafficSeen:true,backendTrafficSeen:true};
 const merged=mergePrimaryFleetState(charger,[{id:'RBC-1',chargerConnected:true,backendConnected:true,status:'Available',connectionDiagnostics:diagnostics}]);
 assert.equal(merged.status,'Available');assert.equal(merged.connectionDiagnostics,diagnostics);assert.equal(merged.relayReachable,true);
});
test('Vier virtuele laders delen de beschikbare stroom en tonen meetwaarden',()=>{
 const s={...structuredClone(defaults),mode:'fast',simulatedChargers:4,fuseA:50,limitA:32,homeW:[0,0,0],pvW:0};
 const result={...calculate(s),actualA:10,energyWh:4000};
 const fleet=simulatedFleet(s,result);assert.equal(fleet.length,4);assert.ok(fleet.every(row=>row.status==='Charging'));assert.ok(fleet.every(row=>row.offeredA===10&&row.measuredA===10));assert.equal(fleet.reduce((sum,row)=>sum+row.energyWh,0),4000);
 s.simulatedChargers=2;const partial=simulatedFleet(s,result);assert.equal(partial.filter(row=>row.status==='Stand-by').length,2);
});
test('Geen netimport door solar-regeling, ook bij veel verschillende belastingen',()=>{
 for(let pv=0;pv<=15000;pv+=500)for(let home=0;home<=8000;home+=400){const s={...structuredClone(defaults),pvW:pv,homeW:[home,600,900]};const r=calculate(s);if(r.desiredA>0){assert.ok(r.gridW<=0.001);assert.ok(r.gridPhaseA.every(a=>a<=24.001));assert.ok(r.desiredA>=6);}}
});
test('Lokale webinterface weigert externe aanvragen en ongeldige bestemmingen',async()=>{
 const app=await startEMS({port:0,hardware:false}),base='http://127.0.0.1:'+app.port;
 try{let r=await fetch(base+'/api/state');assert.equal((await r.json()).liveControl,false);
 r=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://evil.example'},body:JSON.stringify(defaults)});assert.equal(r.status,403);
 r=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({...defaults,mode:'off'})});assert.equal((await r.json()).settings.mode,'off');
 r=await fetch(base+'/api/connection',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({ip:'8.8.8.8'})});assert.equal(r.status,400);
 r=await fetch(base+'/api/led',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({action:'on'})});assert.equal(r.status,400);
 assert.equal(privateIPv4('127.0.0.1'),false);assert.equal(privateIPv4('192.168.1.50'),true);assert.equal(privateIPv4('localhost'),false);
 assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/app.mjs')).status,200);
 assert.equal((await fetch(base+'/dashboard.css')).status,200);
 }finally{await app.close();}
});
test('Openbaar dashboard vereist login en accepteert alleen de ingestelde host',async()=>{
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord'}),base='http://127.0.0.1:'+app.port;
 try{
  let r=await fetch(base+'/api/state',{headers:{Host:'lab.example.test'}});assert.equal(r.status,401);
  const authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
  r=await fetch(base+'/api/state',{headers:{Host:'lab.example.test',Authorization:authorization}});assert.equal(r.status,200);
  const status=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:app.port,path:'/api/state',headers:{Host:'evil.example.test',Authorization:authorization}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(status,403);
 }finally{await app.close();}
});

test('GetDiagnostics ontvangt en analyseert een controllerbestand zonder dashboardlogin',async()=>{
 let command=null;const fleet=[{id:'DIAG-1',chargerConnected:true,backendConnected:true,status:'Available',activeTransaction:false,configuration:[{key:'chg_KWH1',value:'EASTR_SDM72D,1,9600,N,1',readonly:false}]}];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',fleetProvider:()=>fleet,fleetCommander:async(id,action,payload)=>{command={id,action,payload};return action==='DataTransfer'?{status:'UnknownMessageId'}:{fileName:'controller.log'};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
 try{
  let response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'DIAG-1',action:'diagnostics'})});assert.equal(response.status,200);assert.equal(command.action,'GetDiagnostics');assert.ok(command.payload.startTime);assert.ok(command.payload.stopTime);assert.equal(command.payload.retries,2);
  const uploadPath=new URL(command.payload.location).pathname;response=await fetch(base+uploadPath,{method:'PUT',body:'MODBUS Thread active\nMeter detected: SDM630\nKWH:AD[1]RG[FC00]REC[9,9]ERR[TO]\nGSM Modem: BG95-M3\nGSM IMEI[111111111111111]\nGSM IMSI: 222222222222222\nGSM CCID[33333333333333333333]\nGSM REG:5, SQ:23,\n'});assert.equal(response.status,201);
  response=await fetch(base+'/api/state',{headers:{Authorization:authorization}});const state=await response.json(),report=state.diagnostics['DIAG-1'];assert.equal(report.status,'Ontvangen');assert.equal(report.analysis.stats.meterTimeouts,1);assert.equal(report.meterConfiguration.type,'EASTR_SDM72D');assert.equal(report.meterConfiguration.address,'1');assert.equal(report.meterAssessment.configured,'SDM72D');assert.deepEqual(report.meterAssessment.observed,['SDM630']);assert.equal(report.meterAssessment.mismatch,true);assert.equal(report.cellular.iccid,'33333333333333333333');assert.equal(report.cellular.registration,'Geregistreerd via roaming');
  response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'DIAG-1',action:'meterIdentification'})});assert.equal(response.status,200);assert.equal(command.action,'DataTransfer');assert.deepEqual(command.payload,{vendorId:'Ecotap',messageId:'GetMeterInfo',data:'{}'});assert.equal((await response.json()).result.status,'UnknownMessageId');
 }finally{await app.close();}
});

test('Meteridentiteit maakt geen modelgok bij alleen Modbus time-outs',()=>{
 const analysis={stats:{meterTimeouts:4}};
 const unknown=assessMeterIdentity('KWH:AD[1]ERR[TO]','EASTR_SDM72D,1,9600,N,1',analysis);
 assert.equal(unknown.configured,'SDM72D');assert.deepEqual(unknown.observed,[]);assert.equal(unknown.mismatch,false);assert.equal(unknown.label,'Niet bevestigd');
 const confirmed=assessMeterIdentity('KWH meter SDM72D ready','EASTR_SDM72D,1,9600,N,1',analysis);
 assert.equal(confirmed.confirmed,true);assert.equal(confirmed.level,'ok');
});
