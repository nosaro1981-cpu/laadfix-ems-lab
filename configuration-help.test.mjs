import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configurationHelp} from './configuration-help.mjs';
test('Configuratiehulp verklaart samengestelde Ecotap-opties',()=>{
 const info=configurationHelp('com_Options','comMaster=0,Events=1,BlockBeforeBoot=1,Wdt=0,updSendInIdle=0,UseTLS=0,blockLgFull=0');
 assert.match(info.summary,/communicatieopties/i);assert.equal(info.details.length,7);assert.match(info.details[3],/watchdog/i);assert.match(info.details[3],/UIT/);
});
test('Configuratiehulp splitst meter- en faseconfiguratie',()=>{
 const meter=configurationHelp('chg_KWH1','EASTR_SDM72D,1,9600,N,1');assert.match(meter.summary,/fysiek/i);assert.match(meter.details[0],/SDM72D/);assert.match(meter.details[2],/9600/);
 const phase=configurationHelp('ConnectorPhaseRotation','1.RST,2.RTS');assert.equal(phase.details.length,2);assert.match(phase.summary,/geen fysieke draad/i);
});
