import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticLocation, testDiagnosticFtp } from './diagnostic-ftp.mjs';

test('Compatibility variants preserve account and destination without accepting arbitrary targets', async () => {
  const configured='ftp://account%40example.test:password@ftp.example.test/';
  const resolve=async(host,options)=>{assert.equal(host,'ftp.example.test');assert.equal(options.family,4);return {address:'192.0.2.1'};};
  assert.equal(await diagnosticLocation(configured),configured);
  assert.equal(await diagnosticLocation(configured,'ipv4',resolve),'ftp://account%40example.test:password@192.0.2.1:21');
  assert.equal(await diagnosticLocation(configured,'ipv4-raw',resolve),'ftp://account@example.test:password@192.0.2.1:21');
  assert.equal(await diagnosticLocation('ftp://account:pw%40rd@ftp.example.test/','ipv4-raw',resolve),'ftp://account:pw@rd@192.0.2.1:21');
  await assert.rejects(diagnosticLocation('ftp://account:pw%23rd@ftp.example.test/','hostname-raw'),/account|inloggegevens/);
  await assert.rejects(diagnosticLocation(configured,'ftp://other.test'),/Onbekende/);
});

test('FTP check verifies transferred content and removes only its own test file',async()=>{
  let content,path,removed,closed=false;
  const fake={access:async()=>{},list:async()=>[{name:'RBC-1Diag123.xls',size:12},{name:'website',size:0}],uploadFrom:async(stream,p)=>{path=p;const chunks=[];for await(const c of stream)chunks.push(c);content=Buffer.concat(chunks);},downloadTo:async sink=>{sink.end(content);},remove:async p=>{removed=p;},close:()=>{closed=true;}};
  const result=await testDiagnosticFtp('ftp://user:password@ftp.example.test/',()=>fake);
  assert.equal(result.ok,true);assert.match(path,/^\/\.laadfix-ftp-check-.*\.txt$/);assert.equal(removed,path);assert.equal(closed,true);assert.equal(result.files.length,1);
});

test('Failed transfer reports completed stages and hides credentials',async()=>{
  const fake={access:async()=>{},list:async()=>{throw Error('password denied');},close:()=>{}};
  const result=await testDiagnosticFtp('ftp://user:password@ftp.example.test/',()=>fake);
  assert.equal(result.ok,false);assert.deepEqual(result.steps,['Inloggen geslaagd']);assert.equal(result.error.includes('password'),false);
});
