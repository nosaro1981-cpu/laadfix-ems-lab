import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from 'basic-ftp';

const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});server.on('error',reject);});
const waitFor=async(check,timeout=5000)=>{const end=Date.now()+timeout;while(Date.now()<end){try{const result=check();if(result)return result;}catch{}await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Testtimeout');};

test('lokale ontvanger stuurt een FTP-diagnose via HTTPS-token door',async()=>{
  const [controlPort,passivePort]=await Promise.all([freePort(),freePort()]),dataDir=mkdtempSync(join(tmpdir(),'laadfix-receiver-'));
  let received=null;
  const proxy=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);received={url:req.url,body:Buffer.concat(chunks)};res.writeHead(201);res.end('ok');});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const child=spawn(process.execPath,['receiver/receiver.mjs'],{cwd:new URL('.',import.meta.url),env:{...process.env,LAADFIX_LOCAL_IP:'127.0.0.1',LAADFIX_FTP_PORT:String(controlPort),LAADFIX_PASSIVE_PORT:String(passivePort),LAADFIX_PROXY_URL:`http://127.0.0.1:${proxy.address().port}`,LAADFIX_DATA_DIR:dataDir},stdio:'ignore'});
  try{
    await waitFor(()=>JSON.parse(readFileSync(join(dataDir,'status.json'))).state==='klaar');
    const token='a'.repeat(48),station='RBC-TEST',content=Buffer.from('KWH METER [CH][SERIAL][TYPE]:[0][1234][Eastron SDM72D]');
    const client=new Client();await client.access({host:'127.0.0.1',port:controlPort,user:token,password:station,secure:false});await client.uploadFrom(Readable.from(content),'diagnose.xls');client.close();
    await waitFor(()=>received);
    assert.equal(received.url,`/api/diagnostics-upload/${token}/${station}`);assert.deepEqual(received.body,content);
    const status=await waitFor(()=>{const value=JSON.parse(readFileSync(join(dataDir,'status.json')));return value.state==='gereed'&&value;});assert.equal(status.stationId,station);
  }finally{child.kill();await new Promise(resolve=>proxy.close(resolve));rmSync(dataDir,{recursive:true,force:true});}
});
