import net from 'node:net';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const host='0.0.0.0';
const controlPort=Number(process.env.LAADFIX_FTP_PORT||2121);
const passivePort=Number(process.env.LAADFIX_PASSIVE_PORT||50000);
const advertisedIp=process.env.LAADFIX_LOCAL_IP;
const proxyUrl=String(process.env.LAADFIX_PROXY_URL||'https://laadfix-ems-lab.onrender.com').replace(/\/$/,'');
const dataDir=process.env.LAADFIX_DATA_DIR||join(process.cwd(),'ontvangen');
const logFile=join(dataDir,'receiver.ndjson');
const statusFile=join(dataDir,'status.json');
mkdirSync(dataDir,{recursive:true});

if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(advertisedIp||''))throw Error('Geen bruikbaar lokaal IPv4-adres gevonden');
const status=(state,detail={})=>writeFileSync(statusFile,JSON.stringify({time:new Date().toISOString(),state,localAddress:`${advertisedIp}:${controlPort}`,...detail},null,2));
const log=(event,detail={})=>appendFileSync(logFile,JSON.stringify({time:new Date().toISOString(),event,...detail})+'\n');
const passiveReply=()=>{const octets=advertisedIp.split('.').map(Number);return `227 Entering Passive Mode (${octets.join(',')},${Math.floor(passivePort/256)},${passivePort%256})`;};

const server=net.createServer(control=>{
  const peer=control.remoteAddress;
  let buffer='',dataServer=null,dataSocketPromise=null,resolveDataSocket=null,uploadToken='',stationId='';
  const reply=message=>control.write(message+'\r\n');
  const closeData=()=>{dataServer?.close();dataServer=null;dataSocketPromise=null;resolveDataSocket=null;};
  const openPassive=async extended=>{
    closeData();
    dataSocketPromise=new Promise(resolve=>{resolveDataSocket=resolve;});
    dataServer=net.createServer(socket=>resolveDataSocket?.(socket));
    dataServer.on('error',error=>log('passive_error',{code:error.code}));
    await new Promise((resolve,reject)=>dataServer.listen(passivePort,host,resolve).once('error',reject));
    reply(extended?`229 Entering Extended Passive Mode (|||${passivePort}|)`:passiveReply());
  };
  reply('220 LaadFix diagnose-ontvanger gereed');
  log('control_connection',{peer});status('homebox-verbonden',{peer});
  control.on('data',chunk=>{
    buffer+=chunk.toString('utf8');
    while(buffer.includes('\n')){
      const newline=buffer.indexOf('\n'),line=buffer.slice(0,newline).replace(/\r$/,'');buffer=buffer.slice(newline+1);
      const space=line.indexOf(' '),command=(space<0?line:line.slice(0,space)).toUpperCase(),argument=space<0?'':line.slice(space+1);
      if(command==='USER'){uploadToken=argument;reply('331 Wachtwoord vereist');}
      else if(command==='PASS'){stationId=argument;reply('230 Ingelogd');}
      else if(command==='SYST')reply('215 UNIX Type: L8');
      else if(command==='FEAT')control.write('211-Features\r\n UTF8\r\n EPSV\r\n211 End\r\n');
      else if(['TYPE','OPTS','CLNT','NOOP'].includes(command))reply('200 OK');
      else if(command==='PWD')reply('257 "/" is huidige map');
      else if(command==='CWD')reply('250 Map gewijzigd');
      else if(command==='PASV')openPassive(false).catch(error=>{log('passive_error',{code:error.code});reply('425 Dataverbinding mislukt');});
      else if(command==='EPSV')openPassive(true).catch(error=>{log('passive_error',{code:error.code});reply('425 Dataverbinding mislukt');});
      else if(command==='STOR'){
        const safeName=basename(argument.replaceAll('\\','/'))||`diagnostic-${Date.now()}.bin`,destination=join(dataDir,safeName);
        reply('150 Dataverbinding openen');status('bestand-ontvangen',{stationId,fileName:safeName});
        Promise.race([dataSocketPromise||Promise.reject(Error('Geen passieve dataverbinding')),new Promise((_,reject)=>setTimeout(()=>reject(Error('Timeout dataverbinding')),20000))])
          .then(socket=>new Promise((resolve,reject)=>{let bytes=0;const file=createWriteStream(destination);socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>5*1024*1024)socket.destroy(Error('Bestand te groot'));});socket.pipe(file);file.on('finish',()=>resolve(bytes));file.on('error',reject);socket.on('error',reject);}))
          .then(async bytes=>{
            if(!/^[a-f0-9]{48}$/i.test(uploadToken)||!/^[A-Za-z0-9._-]{1,100}$/.test(stationId))throw Error('Ongeldige eenmalige uploadcode');
            status('doorsturen',{stationId,fileName:safeName,bytes});
            const response=await fetch(`${proxyUrl}/api/diagnostics-upload/${uploadToken}/${encodeURIComponent(stationId)}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:readFileSync(destination),signal:AbortSignal.timeout(120000)});
            if(!response.ok)throw Error(`LaadFix antwoordde met ${response.status}`);
            log('forwarded_to_proxy',{peer,fileName:safeName,bytes,stationId});status('gereed',{stationId,fileName:safeName,bytes});reply('226 Upload voltooid');closeData();
          }).catch(error=>{log('upload_error',{peer,fileName:safeName,message:error.message});status('fout',{message:error.message});reply('426 Upload afgebroken');closeData();});
      }else if(command==='QUIT'){reply('221 Tot ziens');control.end();}
      else reply('502 Niet ondersteund');
    }
  });
  control.on('error',error=>log('control_error',{peer,code:error.code}));
  control.on('close',()=>{closeData();log('control_close',{peer});});
});

server.listen(controlPort,host,()=>{log('listening',{controlPort,passivePort,advertisedIp});status('klaar');});
server.on('error',error=>{log('server_error',{code:error.code,message:error.message});status('fout',{message:error.message});process.exitCode=1;});
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
