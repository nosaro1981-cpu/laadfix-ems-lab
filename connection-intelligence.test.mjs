import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeControllerLog,assessMeterIdentity,classifyGsmSignal,compactReadableControllerLog,diagnosticAnalysisWindow,extractCellularIdentity,extractControllerHealth,extractDiagnosticOverview,extractMeterIdentity,extractMeterIdentities,normalizeControllerLog,readableControllerLog} from './connection-intelligence.mjs';

test('Controllerlog leest SIM- en modemidentiteit uit Ecotap-opstartregels',()=>{
 const result=extractCellularIdentity('GSM Modem: BG95-M3\nGSM IMEI[111111111111111]\nGSM IMSI: 222222222222222\nGSM CCID[33333333333333333333]\nGSM REG:5, SQ:23,');
 assert.deepEqual(result,{modem:'BG95-M3',imei:'111111111111111',imsi:'222222222222222',iccid:'33333333333333333333',operator:null,signal:'23',signalQuality:{value:23,percent:74,label:'Sterk',level:'ok'},registrationCode:'5',registration:'Geregistreerd via roaming',registered:true});
});

test('GSM-signaalkwaliteit vertaalt de controllerwaarde naar een duidelijke beoordeling',()=>{
 assert.deepEqual(classifyGsmSignal(3),{value:3,percent:10,label:'Zeer zwak',level:'critical'});
 assert.deepEqual(classifyGsmSignal(14),{value:14,percent:45,label:'Redelijk',level:'warning'});
 assert.deepEqual(classifyGsmSignal(23),{value:23,percent:74,label:'Sterk',level:'ok'});
 assert.equal(classifyGsmSignal(99).label,'Onbekend');
});

test('FTP-belaste WebSocket blijft als vertraagd maar actief zichtbaar na OCPP-herstel',()=>{
 const delayed=Array.from({length:28},()=> '19:31:00:WS ERROR RX FRAME TO').join('\n');
 const configuration=JSON.stringify({configurationKey:[{key:'chg_Reader1',value:'none,CH1'},{key:'chg_Reader2',value:'none,CH2'},{key:'chg_SktType',value:'NoLock+CP-PP,Off'}]});
 const log=`${delayed}\n19:32:06:WS PONG TIMEOUT\n19:32:07:OCPP RESP:[3,"heartbeat",{}]\n19:32:07:WS PING:[50s]\n19:32:07:GSM REG:5, SQ:23,\n${configuration}\n19:32:08:LEDSTATE CH[0] state[Ready(1)]\n19:32:09:PP[0]state[16][0.00]`;
 const result=analyzeControllerLog(log);
 assert.equal(result.stats.webSocketRxFrameTimeouts,28);
 assert.equal(result.stats.webSocketPongTimeouts,1);
 assert.equal(result.stats.ocppRecoveredAfterTimeout,true);
 assert.equal(result.facts.webSocketStatus,'Time-out gezien · OCPP bleef actief');
 assert.equal(result.facts.webSocketPingInterval,50);
 assert.equal(result.facts.gsmQuality.label,'Sterk');
 assert.equal(result.facts.rfidStatus,'Niet geconfigureerd');
 assert.equal(result.facts.ledState,'Ready(1)');
 assert.equal(result.facts.ppChannel,1);
 assert.equal(result.facts.socketType,'NoLock+CP-PP,Off');
 assert.ok(result.findings.some(item=>item.code==='WS_RX_FRAME_DELAY'&&item.level==='warning'));
 assert.ok(result.findings.some(item=>item.code==='WS_PONG_TIMEOUT'&&item.level==='warning'));
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
 assert.deepEqual(meter.respondingAddresses,[{address:'1',count:1}]);assert.equal(meter.configuredAddress,'1');assert.equal(meter.initializedAddress,'1');
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

test('Runtime SLAVECOUNT weegt zwaarder dan de supervisorconfiguratie',()=>{
 const log='PGrid[3:MASTER]MIN.I[6]STATION[16]INSTALLATION[60]SUPERVISOR[0]\nSLAVECOUNT[2]\n'+JSON.stringify({configurationKey:[{key:'grid_CommChannel',readonly:false,value:'canbus'},{key:'grid_Role',readonly:false,value:'master'},{key:'grid_SupervisorClientCount',readonly:false,value:'0'}]});
 const overview=extractDiagnosticOverview(log);
 assert.equal(overview.runtimeSlaveCount,2);assert.equal(overview.supervisorClientCount,0);assert.equal(overview.runtimeSupervisor,0);assert.equal(overview.canPeerDetected,true);assert.equal(overview.loadBalancingDetected,true);
});

test('CAN-status onderscheidt alleen initialisatie van echte master-slavecommunicatie',()=>{
 const idle=extractDiagnosticOverview('CAN RX RINGBUFFER CTX: 0x1000\nCAN TX RINGBUFFER CTX: 0x2000\n'+JSON.stringify({configurationKey:[{key:'grid_CommChannel',readonly:false,value:'canbus'},{key:'grid_Role',readonly:false,value:'master'},{key:'grid_SupervisorClientCount',readonly:false,value:'0'}]}));
 assert.equal(idle.canConfigured,true);assert.equal(idle.canPeerExpected,true);assert.equal(idle.canPeerDetected,false);assert.equal(idle.canLevel,'critical');assert.equal(idle.canRxFrames,0);
 const active=extractDiagnosticOverview('CAN RX ID[102] DATA[01,02]\n'+JSON.stringify({configurationKey:[{key:'grid_CommChannel',readonly:false,value:'canbus'},{key:'grid_Role',readonly:false,value:'slave'}]}));
 assert.equal(active.canPeerDetected,true);assert.equal(active.canLevel,'ok');assert.equal(active.canRxFrames,1);
});

test('Vast canbus-kanaal bij station_ctrl geldt niet als aangesloten CAN-peer',()=>{
 const standalone=extractDiagnosticOverview('CAN RX RINGBUFFER CTX: 0x1000\n'+JSON.stringify({configurationKey:[{key:'grid_CommChannel',readonly:false,value:'canbus'},{key:'grid_Role',readonly:false,value:'station_ctrl'},{key:'grid_SupervisorClientCount',readonly:false,value:'2'}]}));
 assert.equal(standalone.canConfigured,true);assert.equal(standalone.canPeerExpected,false);assert.equal(standalone.canPeerDetected,false);assert.equal(standalone.canLevel,'neutral');assert.equal(standalone.canStatus,'Geen CAN-controller gedetecteerd');
});

test('Antwoordend Modbus-adres weegt zwaarder dan alleen de instelling',()=>{
 const identity=extractMeterIdentity('Meter0:SN[9988]Type[23]Speed[9600]Addr[1]Opt[0]\nKWH:AD[2]RG[0]R[1]OK\nKWH:AD[2]RG[48]R[1]OK','EASTR_SDM72D,1,9600,N,1');
 assert.equal(identity.address,'2');assert.equal(identity.configuredAddress,'1');assert.equal(identity.initializedAddress,'1');assert.deepEqual(identity.respondingAddresses,[{address:'2',count:2}]);
});

test('Een Homebox met één meter toont een antwoord op adres 2 als adresfout voor socket 1',()=>{
 const meters=extractMeterIdentities('Meter0:SN[HB-1]Type[23]Speed[9600]Addr[1]Opt[0]\nKWH:AD[2]RG[0]R[1]OK',[{key:'chg_KWH1',value:'EASTR_SDM72D,1,9600,N,1'}]);
 assert.equal(meters.length,1);assert.equal(meters[0].slot,1);assert.equal(meters[0].address,'2');assert.equal(meters[0].addressMatches,false);assert.deepEqual(meters[0].respondingAddresses,[{address:'2',count:1}]);
});

test('Een lader met twee sockets koppelt adres 1 en 2 aan de juiste meter',()=>{
 const log='Meter0:SN[A]Type[23]Speed[9600]Addr[1]Opt[0]\nMeter1:SN[B]Type[23]Speed[9600]Addr[2]Opt[0]\nKWH:AD[1]RG[0]R[1]OK\nKWH:AD[2]RG[0]R[1]OK',settings=[{key:'chg_KWH1',value:'EASTR_SDM72D,1,9600,N,1'},{key:'chg_KWH2',value:'EASTR_SDM72D,2,9600,N,1'}],meters=extractMeterIdentities(log,settings);
 assert.deepEqual(meters.map(row=>[row.slot,row.address,row.addressMatches,row.successfulReads]),[[1,'1',true,1],[2,'2',true,1]]);
});

test('Afgebroken FTP-logregels worden niet als Modbus-adres gezien',()=>{
 const log='Meter0:SN[21280066]Type[23]Speed[9600]Addr[1]Opt[0]\nKWH:AD[1]RG[48]R[1]OK\nKWH:AD[1 03:16:38:KWH:AD[1 FTP SND 2EA108, 2342570217, 256]OK';
 const meter=extractMeterIdentity(log,'EASTR_SDM630,1,9600,N,1');
 assert.deepEqual(meter.respondingAddresses,[{address:'1',count:1}]);
 assert.equal(meter.address,'1');
});

test('Leesbare logweergave verbergt binaire diagnoseblokken',()=>{
 const readable=readableControllerLog(`23:16:06:KWH:AD[1]JU:\n[237,0,0]\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\n23:16:07:KWH:AD[1]RG[48]R[1]OK`);
 assert.match(readable,/KWH:AD\[1\]JU/);
 assert.match(readable,/Binair meterblok verborgen · 6 onleesbare tekens/);
 assert.match(readable,/KWH:AD\[1\]RG\[48\]R\[1\]OK/);
 assert.doesNotMatch(readable,/\uFFFD/);
});

test('Compacte diagnose telt alleen originele controllerregels mee',()=>{
 const original='18:02:55:Model Name [DUO2]\n18:02:55:Meter0:SN[21280066]Type[23]Speed[9600]Addr[1]Opt[0]\n18:03:01:KWH METER [CH][SERIAL][TYPE]:[0][21280066][Eastron SDM72D]\n';
 const compact=compactReadableControllerLog(Buffer.concat([Buffer.alloc(24*1024,0xff),Buffer.from(original)]),20*1024).toString('utf8');
 assert.equal(compact,original);
 assert.doesNotMatch(compact,/Binair meterblok/);
});

test('Compacte diagnose bewaart begin en einde van een lange controllerlog',()=>{
 const lines=['00:00:03:===== BOOTLOADER INFO =====',...Array.from({length:900},(_,index)=>`18:03:${String(index%60).padStart(2,'0')}:KWH:AD[1]RG[48]R[1]OK`),'18:03:59:CAN RX FRAMES[42]'];
 const compact=compactReadableControllerLog(lines.join('\n'),20*1024).toString('utf8');
 assert.match(compact,/BOOTLOADER INFO/);
 assert.match(compact,/CAN RX FRAMES\[42\]/);
 assert.ok(Buffer.byteLength(compact)<=20*1024);
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
