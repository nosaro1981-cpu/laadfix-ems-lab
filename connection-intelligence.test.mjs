import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeControllerLog,extractCellularIdentity} from './connection-intelligence.mjs';

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
2026-09-12 02:51:23:EV RETRY [4] DELAY [3] Min
KWH:AD[1]RG[FC00]REC[9,9]ERR[TO]
Reader init error (32);0,1,2,1`;
 const result=analyzeControllerLog(log);
 assert.equal(result.facts.localIp,'192.168.1.168');
 assert.equal(result.facts.gsmSignal,21);
 assert.equal(result.facts.retryDelayMinutes,3);
 assert.equal(result.stats.webSocketErrors,1);
 assert.ok(result.findings.some(item=>item.code==='WS_HANDSHAKE'));
 assert.ok(result.findings.some(item=>item.code==='METER_TIMEOUT'));
 assert.ok(result.timeline.some(item=>item.type==='websocket'));
});
