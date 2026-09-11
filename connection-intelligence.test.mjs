import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractCellularIdentity} from './connection-intelligence.mjs';

test('Controllerlog leest SIM- en modemidentiteit uit Ecotap-opstartregels',()=>{
 const result=extractCellularIdentity('GSM Modem: BG95-M3\nGSM IMEI[111111111111111]\nGSM IMSI: 222222222222222\nGSM CCID[33333333333333333333]\nGSM REG:5, SQ:23,');
 assert.deepEqual(result,{modem:'BG95-M3',imei:'111111111111111',imsi:'222222222222222',iccid:'33333333333333333333',operator:null,signal:'23',registrationCode:'5',registration:'Geregistreerd via roaming',registered:true});
});
