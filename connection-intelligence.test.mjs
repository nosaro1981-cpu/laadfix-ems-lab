import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeControllerLog,assessMeterIdentity,diagnosticAnalysisWindow,extractCellularIdentity,extractControllerHealth,extractDiagnosticOverview,extractMeterIdentity,normalizeControllerLog,readableControllerLog} from './connection-intelligence.mjs';

test('Controllerlog leest SIM- en modemidentiteit uit Ecotap-opstartregels',()=>{
 const result=extractCellularIdentity('GSM Modem: BG95-M3\nGSM IMEI[111111111111111]\nGSM IMSI: 222222222222222\nGSM CCID[33333333333333333333]\nGSM REG:5, SQ:23,');
 assert.deepEqual(result,{modem:'BG95-M3',imei:'111111111111111',imsi:'222222222222222',iccid:'33333333333333333333',operator:null,signal:'23',registrationCode:'5',registration:'Geregistreerd via roaming',registered:true});
});

test('Controllerlog verklaart een mislukte WebSocket-handshake na werkende GSM, DHCP en DNS',()=>{
 const log=`GSM REG:5, SQ:21,
DHCP: State BOUND
 IP address 192.168.1.168
 gateway 192.168.1.1
 DNS server 192.168.1.1
DNS RESOLVED:172.67.175.189
HTTP connect to [172.67.175.189][80][1]
WS CONNECTION ERROR 0
HTTP CLIENT CLOSE [5]
WS PONG TIMEOUT
2026-09-12 02:51:23:EV RETRY [4] DELAY [3] Min
KWH:AD[1]RG[FC00]REC[9,9]ERR[TO]
Reader init error (32);0,1,2,1`;
 const result=analyzeControllerLog(log);
 assert.equal(result.facts.localIp,'192.168.1.168');
 assert.equal(result.facts.gsmSignal,21);
 assert.equal(result.facts.retryDelayMinutes,3);
 assert.equal(result.stats.webSocketErrors,1);
 assert.equal(result.stats.webSocketPongTimeouts,1);
 assert.ok(result.findings.some(item=>item.code==='WS_HANDSHAKE'));
 assert.ok(result.findings.some(item=>item.code==='WS_PONG_TIMEOUT'));
 assert.ok(result.findings.some(item=>item.code==='METER_TIMEOUT'));
 assert.ok(result.timeline.some(item=>item.type==='websocket'));
});

test('Grote Ecotap-diagnose herkent de actief uitgelezen meter onafhankelijk van de instelling',()=>{
 const log='\0'.repeat(140000)+'Meter0:SN[21280066]Type[23]Speed[9600]Addr[1]Opt[0]\nKWH:AD[1]RG[FC00]R[1]OK\nKWH METER [CH][SERIAL][TYPE]:[0][21280066][Eastron SDM72D]\n'+
  '[2,"1","BootNotification",{"meterType":"Eastron SDM72D","meterSerialNumber":"21280066"}]\n'+
  '[3,"2",{"configurationKey":[{"key":"chg_KWH1","readonly":false,"value":"EASTR_SDM630,1,9600,N,1"}]}]'+'\n'.repeat(140000);
 const clean=normalizeControllerLog(log),window=diagnosticAnalysisWindow(clean),meter=extractMeterIdentity(clean),assessment=assessMeterIdentity(clean,'EASTR_SDM630,1,9600,N,1',analyzeControllerLog(window));
 assert.ok(window.length<=250000);assert.equal(meter.model,'SDM72D');assert.equal(meter.serial,'21280066');assert.equal(meter.address,'1');assert.equal(meter.baudrate,'9600');assert.equal(meter.successfulReads,1);assert.equal(meter.confidence,'strong');
 assert.equal(assessment.configured,'SDM630');assert.deepEqual(assessment.observed,['SDM72D']);assert.equal(assessment.mismatch,true);
});

test('Onbekende toekomstige kWh-meter wordt uit controllerinitialisatie gelezen',()=>{
  const log='KWH METER [CH][SERIAL][TYPE]:[1][A23-9988][ABB B23 112-100]\nKWH:AD[2]RG[0]R[7]OK';
  const identity=extractMeterIdentity(log,'ABB_B23,2,9600,E,1'),assessment=assessMeterIdentity(log,'ABB_B23,2,9600,E,1');
  assert.equal(identity.model,'ABB B23 112 100');assert.equal(identity.serial,'A23-9988');assert.equal(identity.confidence,'strong');assert.equal(assessment.confirmed,true);
});

test('Diagnose-overzicht signaleert een meteradres dat niet bij de socket past',()=>{
  const log='KWH METER [CH][SERIAL][TYPE]:[1][M-2][ABB B23]\nMeter1:SN[M-2]Type[44]Speed[9600]Addr[1]Opt[0]\n'+JSON.stringify({configurationKey:[{key:'chg_KWH2',readonly:false,value:'ABB_B23,1,9600,E,1'},{key:'grid_SupervisorClientCount',readonly:false,value:'2'}]});
  const overview=extractDiagnosticOverview(log);assert.equal(overview.activeMeterCount,1);assert.equal(overview.supervisorClientCount,2);assert.deepEqual(overview.addressMismatches.map(row=>[row.slot,row.address]),[[2,1]]);assert.deepEqual(overview.observedAddressMismatches.map(row=>[row.slot,row.address]),[[2,1]]);
});

test('Leesbare logweergave verbergt binaire diagnoseblokken',()=>{
 const readable=readableControllerLog(`23:16:06:KWH:AD[1]JU:\n[237,0,0]\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\n23:16:07:KWH:AD[1]RG[48]R[1]OK`);
 assert.match(readable,/KWH:AD\[1\]JU/);
 assert.match(readable,/Binair meterblok verborgen · 6 onleesbare tekens/);
 assert.match(readable,/KWH:AD\[1\]RG\[48\]R\[1\]OK/);
 assert.doesNotMatch(readable,/\uFFFD/);
});

test('Controllergeheugen toont vrije RAM, flash, heap en eventopslag',()=>{
 const log='RAM SIZE/CEILING:128KB/122732\nFLASH SIZE/CEILING:4096KB/3674112\nIP free Heap : 7k\nIP free Heap : 5k\nStack size : 0k, max:5.0kb Gap:4.9kb\nEVENT FLASH MANAGER START [WRID:683][0/2048]MEM USAGE[0]';
 const health=extractControllerHealth(log),overview=extractDiagnosticOverview(log);
 assert.deepEqual(health.ram,{totalKb:128,ceilingBytes:122732,usedKb:119.9,usedPercent:93.6,freeKb:8.1,freePercent:6.4});
 assert.deepEqual(health.flash,{totalKb:4096,ceilingBytes:3674112,usedKb:3588,usedPercent:87.6,freeKb:508,freePercent:12.4});
 assert.equal(health.minIpHeapKb,5);assert.equal(health.minStackGapKb,4.9);assert.equal(health.level,'ok');assert.deepEqual(health.eventFlash,{writeIndex:683,used:0,capacity:2048,memoryUsage:0});assert.equal(overview.controllerHealth.minIpHeapKb,5);
});

test('Controllergeheugen waarschuwt bij volle flash en geheugenfouten',()=>{
 const log='RAM SIZE/CEILING:128KB/130000\nFLASH SIZE/CEILING:4096KB/4150000\nIP free Heap : 1k\nStack overflow\nout of memory',health=extractControllerHealth(log),analysis=analyzeControllerLog(log);
 assert.equal(health.level,'critical');assert.equal(health.memoryFaults,2);assert.ok(health.ram.freePercent<3);assert.ok(health.flash.freePercent<3);
 assert.ok(analysis.findings.some(item=>item.code==='CONTROLLER_MEMORY'&&item.level==='critical'));
});
