import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {defaults,calculate,validate,createEngine,simulatedFleet} from './ems.mjs';
import {assessMeterIdentity} from './connection-intelligence.mjs';
import {startEMS,privateIPv4,colourForStatus,assessService,extractMeterReadings,maximizeDiagnosticDebug,selectDiagnosticDebug,enhanceSelectedDiagnosticDebug,diagnosticConfigurationSnapshot,diagnosticTextWithSettings,diagnosticCaptureDurationMs,diagnosticSnapshotIsComplete,confirmedMeterIdentityFor,downloadableDiagnosticText,diagnosticTextFileName,DIAGNOSTIC_DEBUG_BASE,mergePrimaryFleetState} from './ems-server.mjs';
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
test('Diagnoseduur rekent seconden exact om naar milliseconden',()=>{
 assert.equal(diagnosticCaptureDurationMs({durationSeconds:10,fastScan:true}),10_000);
 assert.equal(diagnosticCaptureDurationMs({durationSeconds:30}),30_000);
 assert.equal(diagnosticCaptureDurationMs({durationSeconds:60}),60_000);
 assert.equal(diagnosticCaptureDurationMs({durationSeconds:300}),300_000);
});
test('Een groeiend FTP-bestand is leesbaar zodra alle gevraagde bytes binnen zijn',()=>{
 assert.equal(diagnosticSnapshotIsComplete(94*1024,94*1024),true);
 assert.equal(diagnosticSnapshotIsComplete(94*1024-1,94*1024),false);
 assert.equal(diagnosticSnapshotIsComplete(0,0),false);
});
test('Sterk bevestigde meteridentiteit blijft beschikbaar voor volgende logs',()=>{
 const confirmed={receivedAt:'2026-09-13T01:23:14Z',fileName:'confirmed.xls',meterIdentity:{model:'SDM72D',serial:'21280066',address:'1',baudrate:'9600',confidence:'strong'}};
 assert.deepEqual(confirmedMeterIdentityFor({meterIdentity:{model:null}},[confirmed]),{model:'SDM72D',serial:'21280066',address:'1',baudrate:'9600',confirmedAt:confirmed.receivedAt,sourceFile:'confirmed.xls',confidence:'strong'});
});
test('Downloadbare diagnosetekst verbergt binaire blokken en FTP-inloggegevens',()=>{
 const text=downloadableDiagnosticText('regel 1\n'+String.fromCharCode(0)+'������\nftp://gebruiker:geheim@ftp.example/log.xls\npassword=geheim');
 assert.match(text,/regel 1/);assert.match(text,/Binair meterblok verborgen/);assert.doesNotMatch(text,/geheim|gebruiker/);assert.match(text,/AFGESCHERMD/);
 assert.match(diagnosticTextFileName('RBC-1',{fileName:'diagnose.xls',receivedAt:'2026-09-13T12:00:00Z'}),/^LaadFix-RBC-1-diagnose-[a-f0-9]{12}\.txt$/);
});

test('Uitgebreide diagnose maximaliseert modules en bewaart logvlaggen',()=>{
 const original='warn=1,error=1,date=1,syslog=1,gsm=3,events=1,com=1,ocpp=7,eth=1,grid=1,ctrl=3,general=1,sensors=0,fw=1,modbus=3,canbus=3,sys=0';
 const maximum=maximizeDiagnosticDebug(original);assert.equal(maximum,DIAGNOSTIC_DEBUG_BASE);
});
test('Gerichte diagnose verhoogt alleen gekozen modules boven het basisprofiel',()=>{
 const profile=selectDiagnosticDebug(['modbus','canbus']);
 assert.match(profile,/modbus=3/);assert.match(profile,/canbus=3/);
 for(const key of ['warn','error','date','syslog','gsm','events','com','ocpp','eth','grid','ctrl','general','sensors','fw','sys'])assert.match(profile,new RegExp(`${key}=0`));
});
test('Lange gerichte diagnose behoudt niet-geselecteerde debugwaarden',()=>{
 const original='warn=1,error=1,date=1,syslog=1,gsm=1,events=0,com=1,ocpp=2,eth=1,grid=0,ctrl=1,general=1,sensors=0,fw=1,modbus=0,canbus=0,sys=0';
 const profile=enhanceSelectedDiagnosticDebug(original,['modbus','canbus']);
 assert.match(profile,/modbus=3/);assert.match(profile,/canbus=3/);assert.match(profile,/ocpp=2/);assert.match(profile,/gsm=1/);assert.match(profile,/events=0/);
});
test('Diagnose bewaart alleen de veilige relevante configuratie-instellingen',()=>{
 const snapshot=diagnosticConfigurationSnapshot([{key:'RestartTransOnBoot',value:'1'},{key:'UseTLS',value:'0'},{key:'FTPPassword',value:'geheim'},{key:'eth cfg',value:'type=dhcp,ip=0.0.0.0'}]);
 assert.deepEqual(snapshot.map(row=>row.key),['RestartTransOnBoot','UseTLS','eth cfg']);
 assert.equal(JSON.stringify(snapshot).includes('geheim'),false);
 const text=diagnosticTextWithSettings({diagnosticSettings:snapshot,diagnosticDebugPlan:{original:'modbus=0',temporary:'modbus=3'}},'MODBUS OK');
 assert.match(text,/RestartTransOnBoot=1/);assert.match(text,/chg_Debug tijdelijk=modbus=3/);assert.match(text,/MODBUS OK/);assert.doesNotMatch(text,/geheim/);
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
 const dashboardResponse=await fetch(base+'/');assert.equal(dashboardResponse.status,200);assert.match(dashboardResponse.headers.get('cache-control'),/no-store/);const appResponse=await fetch(base+'/app.mjs');assert.equal(appResponse.status,200);assert.match(appResponse.headers.get('cache-control'),/no-store/);
 assert.equal((await fetch(base+'/configuration-help.mjs')).status,200);
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
    let response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'DIAG-1',action:'diagnostics',enhancedDebug:false})});assert.equal(response.status,200);assert.equal(command.action,'GetDiagnostics');assert.ok(command.payload.startTime);assert.ok(command.payload.stopTime);assert.equal(Date.parse(command.payload.stopTime)-Date.parse(command.payload.startTime),5*60_000);assert.equal(new URL(command.payload.location).hostname,'lab.example.test');assert.equal(command.payload.retries,2);
  const uploadPath=new URL(command.payload.location).pathname;response=await fetch(base+uploadPath,{method:'PUT',body:'MODBUS Thread active\nMeter detected: SDM630\nKWH:AD[1]RG[FC00]REC[9,9]ERR[TO]\nGSM Modem: BG95-M3\nGSM IMEI[111111111111111]\nGSM IMSI: 222222222222222\nGSM CCID[33333333333333333333]\nGSM REG:5, SQ:23,\n'});assert.equal(response.status,201);
    response=await fetch(base+'/api/state',{headers:{Authorization:authorization}});const state=await response.json(),report=state.diagnostics['DIAG-1'];assert.equal(report.status,'Ontvangen');assert.equal(report.quickMode,true);assert.equal(report.progress.label,'Snelle diagnose gereed');assert.equal(report.source,'LaadFix');assert.equal(report.destination,'LaadFix beveiligde upload');assert.equal(report.minutes,5);assert.equal(report.analysis.stats.meterTimeouts,1);assert.equal(report.meterConfiguration.type,'EASTR_SDM72D');assert.equal(report.meterConfiguration.address,'1');assert.equal(report.meterAssessment.configured,'SDM72D');assert.deepEqual(report.meterAssessment.observed,['SDM630']);assert.equal(report.meterAssessment.mismatch,true);assert.equal(report.cellular.iccid,'33333333333333333333');assert.equal(report.cellular.registration,'Geregistreerd via roaming');assert.equal(state.diagnosticHistory['DIAG-1'].length,1);assert.equal(state.diagnosticHistory['DIAG-1'][0].receivedAt,report.receivedAt);
  response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'DIAG-1',action:'meterIdentification'})});assert.equal(response.status,200);assert.equal(command.action,'DataTransfer');assert.deepEqual(command.payload,{vendorId:'Ecotap',messageId:'GetMeterInfo',data:'{}'});assert.equal((await response.json()).result.status,'UnknownMessageId');
  response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'DIAG-1',action:'diagnostics',enhancedDebug:false,allTime:true})});assert.equal(response.status,200);assert.equal(command.action,'GetDiagnostics');assert.equal(JSON.stringify(command.payload).includes('startTime'),false);assert.equal(JSON.stringify(command.payload).includes('stopTime'),false);
  response=await fetch(base+'/api/diagnostics-ftp-test',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,401);
 }finally{await app.close();}
});

test('Meteridentiteit maakt geen modelgok bij alleen Modbus time-outs',()=>{
 const analysis={stats:{meterTimeouts:4}};
 const unknown=assessMeterIdentity('KWH:AD[1]ERR[TO]','EASTR_SDM72D,1,9600,N,1',analysis);
 assert.equal(unknown.configured,'SDM72D');assert.deepEqual(unknown.observed,[]);assert.equal(unknown.mismatch,false);assert.equal(unknown.label,'Niet bevestigd');
 const confirmed=assessMeterIdentity('KWH meter SDM72D ready','EASTR_SDM72D,1,9600,N,1',analysis);
 assert.equal(confirmed.confirmed,true);assert.equal(confirmed.level,'ok');
});

test('Lokale diagnose-ontvanger gebruikt een eenmalig token en levert online analyse op',async()=>{
 let command=null;const fleet=[{id:'DIAGLOCAL',chargerConnected:true,backendConnected:true,status:'Available',activeTransaction:false,configuration:[{key:'chg_KWH1',value:'EASTR_SDM630,1,9600,N,1',readonly:false}]}];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',fleetProvider:()=>fleet,fleetCommander:async(id,action,payload)=>{command={id,action,payload};return{fileName:'DIAGLOCALDiag123.xls'};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
 try{
  let response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'DIAGLOCAL',action:'diagnostics',localReceiverIp:'192.168.43.20',localReceiverPort:2121,enhancedDebug:false,durationSeconds:30})});assert.equal(response.status,200);
  assert.equal(Date.parse(command.payload.stopTime)-Date.parse(command.payload.startTime),30_000);
  const location=new URL(command.payload.location);assert.equal(location.protocol,'ftp:');assert.equal(location.hostname,'192.168.43.20');assert.equal(location.port,'2121');assert.match(location.username,/^[a-f0-9]{48}$/);assert.equal(location.password,'DIAGLOCAL');
  const upload=`${base}/api/diagnostics-upload/${location.username}/${location.password}`;
  response=await fetch(upload,{method:'PUT',body:'Meter0:SN[21280066]Type[23]Speed[9600]Addr[1]Opt[0]\nKWH:AD[1]RG[FC00]R[1]OK\nKWH METER [CH][SERIAL][TYPE]:[0][21280066][Eastron SDM72D]\n'});assert.equal(response.status,201);
  response=await fetch(base+'/api/state',{headers:{Authorization:authorization}});let report=(await response.json()).diagnostics.DIAGLOCAL;assert.equal(report.status,'Ontvangen');assert.equal(report.destination,'Lokale ontvanger (192.168.43.20)');assert.equal(report.durationSeconds,30);assert.equal(report.minutes,0.5);assert.equal(report.meterIdentity.model,'SDM72D');assert.equal(report.meterIdentity.serial,'21280066');assert.equal(report.meterAssessment.mismatch,true);
  response=await fetch(base+'/api/diagnostics-manual',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/octet-stream','X-Charger-Id':'DIAGLOCAL','X-File-Name':encodeURIComponent('handmatig.xls')},body:'KWH METER [CH][SERIAL][TYPE]:[0][9988][Eastron SDM630]\nKWH:AD[1]RG[0]R[1]OK\nftp://user:secret@example.test/file.xls'});assert.equal(response.status,201);report=(await response.json()).report;assert.equal(report.source,'Handmatige browserupload');assert.equal(report.meterIdentity.model,'SDM630');assert.equal(report.meterIdentity.serial,'9988');
  response=await fetch(base+'/api/diagnostics-text/DIAGLOCAL?receivedAt='+encodeURIComponent(report.receivedAt),{headers:{Authorization:authorization}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/plain/);assert.match(response.headers.get('content-disposition'),/handmatig\.txt/);const text=await response.text();assert.match(text,/Eastron SDM630/);assert.doesNotMatch(text,/secret|user/);assert.match(text,/FTP-adres/);
 }finally{await app.close();}
});

test('Uitgebreide lokale diagnose herstelt chg_Debug na de upload',async()=>{
 const original='warn=1,error=1,date=1,syslog=1,gsm=3,events=1,com=1,ocpp=7,eth=1,grid=1,ctrl=3,general=1,sensors=0,fw=1,modbus=3,canbus=3,sys=0',calls=[],fleet=[{id:'DIAGMAX',chargerConnected:true,backendConnected:true,status:'Available',activeTransaction:false,configuration:[{key:'chg_KWH1',value:'EASTR_SDM72D,1,9600,N,1'}]}];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:10,fleetProvider:()=>fleet,fleetCommander:async(id,action,payload)=>{calls.push({action,payload});if(action==='GetConfiguration')return payload.key?{configurationKey:[]}:{configurationKey:[{key:'chg_Debug',value:original}]};return action==='GetDiagnostics'?{fileName:'DIAGMAX.xls'}:{status:'Accepted'};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
 try{let response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'DIAGMAX',action:'diagnostics',localReceiverIp:'192.168.1.20',localReceiverPort:2121,debugModules:['modbus']})});assert.equal(response.status,202);for(let i=0;i<30&&!calls.some(row=>row.action==='GetDiagnostics');i++)await new Promise(resolve=>setTimeout(resolve,10));const request=calls.find(row=>row.action==='GetDiagnostics'),maximum=calls.find(row=>row.action==='ChangeConfiguration');assert.ok(request);assert.match(maximum.payload.value,/modbus=3/);assert.match(maximum.payload.value,/canbus=0/);assert.ok(calls.some(row=>row.action==='TriggerMessage'&&row.payload.requestedMessage==='MeterValues'));const location=new URL(request.payload.location);response=await fetch(`${base}/api/diagnostics-upload/${location.username}/${location.password}`,{method:'PUT',body:'KWH METER [CH][SERIAL][TYPE]:[0][123][Eastron SDM72D]\nKWH:AD[1]RG[0]R[1]OK'});assert.equal(response.status,201);assert.equal(calls.at(-1).action,'ChangeConfiguration');assert.equal(calls.at(-1).payload.value,original);response=await fetch(base+'/api/state',{headers:{Authorization:authorization}});const report=(await response.json()).diagnostics.DIAGMAX;assert.equal(report.debugRestoreStatus,'Originele debuginstelling hersteld');}
 finally{await app.close();}
});

test('Lopende diagnose blokkeert dubbele opdrachten en ongeldige selecties',async()=>{
 const original='warn=1,error=1,date=1,syslog=1,gsm=3,events=1,com=1,ocpp=7,eth=1,grid=1,ctrl=3,general=1,sensors=0,fw=1,modbus=3,canbus=3,sys=0',fleet=[{id:'LOCKED',chargerConnected:true,backendConnected:true,status:'Available',activeTransaction:false}];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:1000,fleetProvider:()=>fleet,fleetCommander:async(id,action)=>action==='GetConfiguration'?{configurationKey:[{key:'chg_Debug',value:original}]}:{status:'Accepted'}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64'),request=body=>fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{let response=await request({id:'LOCKED',action:'diagnostics',durationSeconds:30,debugModules:['modbus']});assert.equal(response.status,202);response=await request({id:'LOCKED',action:'diagnostics',durationSeconds:30,debugModules:['canbus']});assert.equal(response.status,409);assert.match((await response.json()).error,/loopt al een diagnose/);response=await request({id:'LOCKED',action:'diagnostics',durationSeconds:10,debugModules:['onbekend']});assert.equal(response.status,409);}
 finally{await app.close();}
});

test('Diagnose weigert lege, onbekende en te lange keuzes',async()=>{
 const fleet=[{id:'VALIDATE',chargerConnected:true,backendConnected:true,status:'Available'}],app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',fleetProvider:()=>fleet,fleetCommander:async(id,action)=>action==='GetConfiguration'?{configurationKey:[{key:'chg_Debug',value:DIAGNOSTIC_DEBUG_BASE}]}:{status:'Accepted'}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64'),request=body=>fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{assert.equal((await request({id:'VALIDATE',action:'diagnostics',durationSeconds:10,debugModules:['modbus']})).status,400);assert.equal((await request({id:'VALIDATE',action:'diagnostics',durationSeconds:30,debugModules:[]})).status,400);assert.equal((await request({id:'VALIDATE',action:'diagnostics',durationSeconds:30,debugModules:['onbekend']})).status,400);assert.equal((await request({id:'VALIDATE',action:'diagnostics',durationSeconds:10,debugModules:['modbus','canbus'],fastScan:true})).status,202);}
 finally{await app.close();}
});

test('Niet beantwoorde configuratie blokkeert de diagnose niet en laat debug ongewijzigd',async()=>{
 const fleet=[{id:'RETRY',chargerConnected:true,backendConnected:true,status:'Available',configuration:[]}],calls=[];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:1,diagnosticConfigurationTimeoutMs:10,fleetProvider:()=>fleet,fleetCommander:async(id,action)=>{calls.push(action);if(action==='GetConfiguration')throw Error('Geen antwoord van de Homebox');if(action==='GetDiagnostics')return{fileName:'FALLBACK.xls'};return{status:'Accepted'};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64'),request=()=>fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'RETRY',action:'diagnostics',durationSeconds:30,debugModules:['modbus']})});
 try{const response=await request();assert.equal(response.status,202);const body=await response.json();assert.equal(body.serviceResult.status,'Standaardlog gestart');for(let i=0;i<30&&!calls.includes('GetDiagnostics');i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(calls.includes('GetDiagnostics'));assert.ok(!calls.includes('ChangeConfiguration'));const state=await(await fetch(base+'/api/state',{headers:{Authorization:authorization}})).json();assert.equal(state.diagnostics.RETRY.enhancedDebug,false);assert.match(state.diagnostics.RETRY.configurationWarning,/standaardlog/);}
 finally{await app.close();}
});

test('Ontbrekend GetDiagnostics-antwoord gaat door zodra het nieuwe FTP-bestand verschijnt',async()=>{
 const fleet=[{id:'FTP-FALLBACK',chargerConnected:true,backendConnected:true,status:'Available',configuration:[]}],calls=[];let lists=0,app;
 try{
  app=await startEMS({port:0,host:'127.0.0.1',hardware:false,authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:1,diagnosticConfigurationTimeoutMs:10,diagnosticFtpUrlOverride:'ftp://test:test@127.0.0.1:9/',diagnosticFtpLister:async()=>++lists===1?[]:[{name:'FTP-FALLBACKDiag1.xls',size:4096,isFile:true,modifiedAt:new Date()}],fleetProvider:()=>fleet,fleetCommander:async(id,action)=>{calls.push(action);if(action==='GetConfiguration')throw Error('Geen configuratieantwoord');if(action==='GetDiagnostics')throw Error('Geen antwoord van de Homebox binnen 120 seconden');return{status:'Accepted'};}});
  const base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
  const response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'FTP-FALLBACK',action:'diagnostics',durationSeconds:10,fastScan:true,debugModules:['modbus']})});
  assert.equal(response.status,202);
  let report;for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,10));report=(await(await fetch(base+'/api/state',{headers:{Authorization:authorization}})).json()).diagnostics['FTP-FALLBACK'];if(report?.fileName)break;}
  assert.equal(report.fileName,'FTP-FALLBACKDiag1.xls');assert.equal(report.fileDiscoveredWithoutResponse,true);assert.equal(report.progress.phase,'uploading');assert.equal(report.error,null);assert.equal(calls.filter(action=>action==='GetDiagnostics').length,2);
 }finally{if(app)await app.close();}
});

for(const mode of [
 {name:'bestaande log',body:{enhancedDebug:false,quickMode:true,fastScan:true,durationSeconds:30}},
 {name:'snelle log',body:{fastScan:true,durationSeconds:10,debugModules:['modbus']}},
 {name:'normale log',body:{enhancedDebug:false,quickMode:false,fastScan:true,durationSeconds:30}},
 {name:'lange log',body:{fastScan:true,longMode:true,durationSeconds:60,debugModules:['modbus'],preserveUnselectedDebug:true}}
])test(`${mode.name} verwerkt een FTP-bestand zonder GetDiagnostics-antwoord`,async()=>{
 let lists=0,calls=[],app;const id='ALL-ROUTES-'+mode.name.replace(/\W/g,'').toUpperCase(),fileName=`${id}Diag1789370000.xls`,fleet=[{id,chargerConnected:true,backendConnected:true,status:'Available',activeTransaction:false,configuration:[]}];
 app=await startEMS({port:0,host:'127.0.0.1',hardware:false,authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:1,diagnosticConfigurationTimeoutMs:10,diagnosticFtpUrlOverride:'ftp://test:test@127.0.0.1:9/',diagnosticFtpLister:async()=>++lists===1?[]:[{name:fileName,size:4096,isFile:true,modifiedAt:new Date()}],fleetProvider:()=>fleet,fleetCommander:async(id,action)=>{calls.push(action);if(action==='GetConfiguration')throw Error('Geen configuratieantwoord');if(action==='GetDiagnostics')throw Error('Geen antwoord van de Homebox binnen 120 seconden');return{status:'Accepted'};}});
 const base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
 try{const response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id,action:'diagnostics',...mode.body})});assert.ok([200,202].includes(response.status));for(let i=0;i<60;i++){const state=await(await fetch(base+'/api/state',{headers:{Authorization:authorization}})).json(),report=state.diagnostics[id];if(report?.fileName===fileName){assert.notEqual(report.progress?.phase,'failed');assert.ok(calls.includes('GetDiagnostics'));return;}await new Promise(resolve=>setTimeout(resolve,10));}assert.fail(`${mode.name} koppelde het nieuwe FTP-bestand niet`);}finally{await app.close();}
});

test('Lokale upload-time-out herstelt debug en geeft een nieuwe diagnose vrij',async()=>{
 const original=DIAGNOSTIC_DEBUG_BASE,calls=[],fleet=[{id:'LOCALTIMEOUT',chargerConnected:true,backendConnected:true,status:'Available'}];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:1,diagnosticLocalTimeoutMs:25,fleetProvider:()=>fleet,fleetCommander:async(id,action,payload)=>{calls.push({action,payload});if(action==='GetConfiguration')return{configurationKey:[{key:'chg_Debug',value:original}]};if(action==='GetDiagnostics')return{fileName:'NOUPLOAD.xls'};return{status:'Accepted'};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64'),request=()=>fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'LOCALTIMEOUT',action:'diagnostics',durationSeconds:30,localReceiverIp:'192.168.1.20',debugModules:['modbus']})});
 try{let response=await request();assert.equal(response.status,202);let report;for(let i=0;i<30;i++){await new Promise(resolve=>setTimeout(resolve,10));report=(await(await fetch(base+'/api/state',{headers:{Authorization:authorization}})).json()).diagnostics.LOCALTIMEOUT;if(report?.progress?.phase==='failed')break;}assert.equal(report.progress.phase,'failed');assert.match(report.error,/veilige wachttijd/);assert.equal(calls.at(-1).action,'ChangeConfiguration');assert.equal(calls.at(-1).payload.value,original);response=await request();assert.equal(response.status,202);}
 finally{await app.close();}
});

test('Frisse lokale diagnose herstart eerst en leest daarna de actuele meterconfiguratie',async()=>{
 const original='warn=1,error=1,modbus=3,canbus=3',calls=[],fleet=[{id:'FRESH',chargerConnected:true,backendConnected:true,status:'Available',activeTransaction:false,connectionDiagnostics:{sessionId:1},configuration:[]}];
 let diagnosticsPayload=null;
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:1,fleetProvider:()=>fleet,fleetCommander:async(id,action,payload)=>{calls.push(action);if(action==='Reset'){fleet[0].connectionDiagnostics.sessionId=2;return{status:'Accepted'};}if(action==='GetConfiguration')return{configurationKey:[{key:'chg_Debug',value:original},{key:'chg_KWH1',value:'EASTR_SDM630,1,9600,N,1'}]};if(action==='GetDiagnostics'){diagnosticsPayload=payload;return{fileName:'FRESH.xls'};}return{status:'Accepted'};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
 try{const response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'FRESH',action:'diagnostics',localReceiverIp:'192.168.1.20',localReceiverPort:2121,durationSeconds:30,freshStart:true})});assert.equal(response.status,202);assert.deepEqual(calls.slice(0,3),['Reset','GetConfiguration','ChangeConfiguration']);for(let i=0;i<30&&!diagnosticsPayload;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(diagnosticsPayload);assert.ok(Date.parse(diagnosticsPayload.stopTime)-Date.parse(diagnosticsPayload.startTime)>=2_000);const state=await (await fetch(base+'/api/state',{headers:{Authorization:authorization}})).json();assert.equal(state.diagnostics.FRESH.freshStart,true);assert.equal(state.diagnostics.FRESH.meterSettings[0].value,'EASTR_SDM630,1,9600,N,1');}
 finally{await app.close();}
});

test('Werkelijke herstart wordt gevolgd wanneer de Homebox soft reset als Rejected meldt',async()=>{
 const calls=[],fleet=[{id:'RESETFALLBACK',chargerConnected:true,backendConnected:true,status:'Available',activeTransaction:false,connectionDiagnostics:{sessionId:1},configuration:[]}];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',diagnosticCaptureMs:1,fleetProvider:()=>fleet,fleetCommander:async(id,action,payload)=>{calls.push({action,payload});if(action==='Reset'){fleet[0].connectionDiagnostics.sessionId=2;return{status:'Rejected'};}if(action==='GetConfiguration')return{configurationKey:[{key:'chg_Debug',value:DIAGNOSTIC_DEBUG_BASE},{key:'chg_KWH1',value:'EASTR_SDM630,1,9600,N,1'}]};if(action==='GetDiagnostics')return{fileName:'RESETFALLBACK.xls'};return{status:'Accepted'};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
 try{const response=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'RESETFALLBACK',action:'diagnostics',localReceiverIp:'192.168.1.20',durationSeconds:30,freshStart:true,debugModules:['modbus']})});assert.equal(response.status,202);const body=await response.json();assert.match(body.serviceResult.steps[0],/werkelijke herstart is gedetecteerd/);for(let i=0;i<30&&!calls.some(row=>row.action==='GetDiagnostics');i++)await new Promise(resolve=>setTimeout(resolve,10));const diagnostics=calls.find(row=>row.action==='GetDiagnostics');assert.ok(diagnostics);assert.ok(Date.parse(diagnostics.payload.stopTime)-Date.parse(diagnostics.payload.startTime)>=2_000);const state=await(await fetch(base+'/api/state',{headers:{Authorization:authorization}})).json();assert.equal(state.diagnostics.RESETFALLBACK.freshStart,true);assert.match(state.diagnostics.RESETFALLBACK.sessionNote,/werkelijke herstart is gedetecteerd/);}
 finally{await app.close();}
});

test('Een nieuw serienummer wordt veilig toegevoegd en direct in de vloot getoond',async()=>{
 const fleet=[{id:'RBC-0000032',chargerConnected:false,backendConnected:false,status:'Onbekend'}];
 const app=await startEMS({port:0,host:'127.0.0.1',hardware:false,publicHost:'lab.example.test',authUser:'tester',authPassword:'sterk-wachtwoord',fleetProvider:()=>fleet,fleetRegistrar:async id=>{if(!fleet.some(row=>row.id===id))fleet.push({id,chargerConnected:false,backendConnected:false,status:'Onbekend',upstream:'ws://ocpp.robo-charge.net:80/'+id});return{id,endpoint:'gateway.example:80/ocpp/secret/'+id};}}),base='http://127.0.0.1:'+app.port,authorization='Basic '+Buffer.from('tester:sterk-wachtwoord').toString('base64');
 try{let response=await fetch(base+'/api/fleet-register',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'RBC-0000099'})});assert.equal(response.status,201);let body=await response.json();assert.equal(body.result.id,'RBC-0000099');assert.match(body.result.endpoint,/RBC-0000099$/);assert.ok(body.fleet.some(row=>row.id==='RBC-0000099'));response=await fetch(base+'/api/fleet-register',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'fout/id'})});assert.equal(response.status,400);}
 finally{await app.close();}
});
