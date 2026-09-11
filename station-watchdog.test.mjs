import test from 'node:test';
import assert from 'node:assert/strict';
import {auditStation} from './station-watchdog.mjs';

test('bewaker vindt uitgeschakelde meter en traag meetinterval',()=>{
  const result=auditStation({chargerConnected:true,configuration:[{key:'chg_KWH1',value:'None,1,9600,N,1'},{key:'MeterValueSampleInterval',value:'500'}],meterHistory:[]});
  assert.equal(result.status,'critical');
  assert.ok(result.findings.some(row=>row.code==='METER_DISABLED'));
  assert.deepEqual(result.findings.find(row=>row.code==='SAMPLE_SLOW').repair,{key:'MeterValueSampleInterval',value:'60'});
});

test('bewaker vindt stilstaande energie tijdens een sessie',()=>{
  const now=Date.parse('2026-09-11T08:00:00Z');
  const result=auditStation({activeTransaction:true,lastMeterValues:'2026-09-11T08:00:00Z',configuration:[{key:'chg_KWH1',value:'EASTR_SDM72D,1,9600,N,1'},{key:'MeterValueSampleInterval',value:'60'},{key:'MeterValuesSampledData',value:'Energy.Active.Import.Register,Current.Import.L1'},{key:'SupportedFeatureProfiles',value:'Core,SmartCharging'}],meterHistory:[{time:'2026-09-11T08:00:00Z',energy:{value:100},currentL1:{value:8}},{time:'2026-09-11T07:58:00Z',energy:{value:100},currentL1:{value:8}}]},null,now);
  assert.ok(result.findings.some(row=>row.code==='ENERGY_FROZEN'));
});

test('bewaker bevestigt gezonde configuratie en meter',()=>{
  const now=Date.parse('2026-09-11T08:00:00Z');
  const result=auditStation({lastMeterValues:'2026-09-11T08:00:00Z',configuration:[{key:'chg_KWH1',value:'EASTR_SDM72D,1,9600,N,1'},{key:'MeterValueSampleInterval',value:'60'},{key:'ClockAlignedDataInterval',value:'60'},{key:'MeterValuesSampledData',value:'Energy.Active.Import.Register,Current.Import.L1'},{key:'SupportedFeatureProfiles',value:'Core,SmartCharging'}],meterHistory:[{time:'2026-09-11T08:00:00Z',energy:{value:102},currentL1:{value:0}},{time:'2026-09-11T07:58:00Z',energy:{value:100},currentL1:{value:0}}]},null,now);
  assert.equal(result.status,'ok');
});
