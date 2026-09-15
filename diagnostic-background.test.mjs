import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {diagnosticFastScanEnabled,diagnosticFinishUsesCompactMode,startEMS} from './ems-server.mjs';

test('normal diagnostics always preserve the complete received file',()=>{
  assert.equal(diagnosticFastScanEnabled({normalMode:true,fastScan:true}),false);
  assert.equal(diagnosticFastScanEnabled({normalMode:true,fastScan:false}),false);
  assert.equal(diagnosticFastScanEnabled({fastScan:true}),true);
});

test('finishing a normal diagnosis keeps full-file processing active',()=>{
  assert.equal(diagnosticFinishUsesCompactMode({normalMode:true}),false);
  assert.equal(diagnosticFinishUsesCompactMode({normalMode:false}),true);
});

for (const quietDiagnostics of [false, true]) test(`automatic meter requests respect optional upload quiet mode: ${quietDiagnostics}`, async () => {
  const station={id:'QUIET-TEST',chargerConnected:true,backendConnected:true,status:'Available',configuration:[{key:'chg_KWH1',value:'TEST'}]};
  const readings=[];
  let diagnostic;
  const relay=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/state') return res.end(JSON.stringify(station));
    let raw='';for await(const chunk of req)raw+=chunk;
    readings.push(JSON.parse(raw));res.end(JSON.stringify({result:{status:'Accepted'}}));
  });
  await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
  const app=await startEMS({port:0,hardware:true,ledHardware:false,publicHost:'quiet.example.test',authUser:'test',authPassword:'test',relayMonitorPort:relay.address().port,meterPollIntervalMs:500,fleetProvider:()=>[station],fleetCommander:async(id,action,payload)=>{diagnostic=payload;return{fileName:'QUIET-TESTDiag1.xls'};}});
  const base=`http://127.0.0.1:${app.port}`,authorization='Basic '+Buffer.from('test:test').toString('base64');
  try {
    const request=await fetch(base+'/api/fleet-command',{method:'POST',headers:{Authorization:authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:station.id,action:'diagnostics',quietDiagnostics,enhancedDebug:false})});
    assert.equal(request.status,200);
    await new Promise(resolve=>setTimeout(resolve,650));
    assert.equal(readings.length,quietDiagnostics?0:1,'ordinary uploads keep background communication; only the explicit quiet experiment pauses it');
    const upload=await fetch(base+new URL(diagnostic.location).pathname,{method:'PUT',body:'Controller diagnostic test\n'});
    assert.equal(upload.status,201);
    await new Promise(resolve=>setTimeout(resolve,650));
    assert.equal(readings.length,1);
    assert.equal(readings[0].action,'TriggerMessage');
    assert.equal(readings[0].payload.requestedMessage,'MeterValues');
  } finally {
    await app.close();await new Promise(resolve=>relay.close(resolve));
  }
});
