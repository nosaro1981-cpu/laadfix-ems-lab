import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export function normalizeUpstream(value,id='RBC-0000032'){
  if(typeof value!=='string'||value.length<8||value.length>500)throw Error('Vul een geldig OCPP WebSocket-adres in');
  const expanded=value.trim().replaceAll('#OSN#',id).replaceAll('{id}',id);
  let url;try{url=new URL(expanded);}catch{throw Error('Ongeldig serveradres');}
  if(!['ws:','wss:'].includes(url.protocol))throw Error('Gebruik ws:// of wss://');
  if(url.username||url.password)throw Error('Zet geen gebruikersnaam of wachtwoord in het serveradres');
  if(url.hash)throw Error('Een fragment (#) is niet toegestaan na vervanging van #OSN#');
  if(!url.hostname)throw Error('De servernaam ontbreekt');
  if(!url.pathname.split('/').filter(Boolean).includes(id))throw Error(`Het pad moet laadpaal-ID ${id}, {id} of #OSN# bevatten`);
  return url.toString();
}

export async function startRelay({port=8765, monitorPort=8081, host='0.0.0.0', allowedIp='192.168.1.168', id='RBC-0000032', upstream='ws://ocpp.robo-charge.net:80/RBC-0000032',meterLogFile='meter-values.ndjson',routingFile='proxy-routing.json',pathSecret=''}={}) {
  if(allowedIp==='*'&&pathSecret.length<24)throw Error('Een openbare OCPP-route vereist een geheim pad van minimaal 24 tekens');
  let active=null;
  const pending=new Map();
  const roundTripPending=new Map();
  const routingUrl=new URL(routingFile,import.meta.url);
  let currentUpstream=normalizeUpstream(upstream,id);
  if(existsSync(routingUrl)){try{currentUpstream=normalizeUpstream(JSON.parse(readFileSync(routingUrl,'utf8')).upstream,id);}catch{}}
  const meterLogUrl=meterLogFile?new URL(meterLogFile,import.meta.url):null;
  const summary=(payload,time,messageId)=>{const samples=(payload?.meterValue||[]).flatMap(v=>v.sampledValue||[]),find=(m,phase)=>{const v=samples.find(x=>(x.measurand||'Energy.Active.Import.Register')===m&&(!phase||x.phase===phase));return v?{value:Number(v.value),unit:v.unit||'',phase:v.phase||null}:null;};return {messageId,time,energy:find('Energy.Active.Import.Register'),voltageL1:find('Voltage','L1'),currentL1:find('Current.Import','L1'),frequency:find('Frequency'),temperature:find('Temperature'),forwardedAt:null};};
  let archivedMeter=null,archivedForward=null,meterHistoryCount=0,meterHistory=[];
  if(meterLogUrl&&existsSync(meterLogUrl)){try{for(const line of readFileSync(meterLogUrl,'utf8').trim().split(/\r?\n/)){if(!line)continue;const item=JSON.parse(line);if(item.event==='received'){archivedMeter=item;meterHistoryCount++;meterHistory.unshift(summary(item.payload,item.time,item.messageId));meterHistory=meterHistory.slice(0,20);}if(item.event==='forwarded'){archivedForward=item;const row=meterHistory.find(x=>x.messageId===item.messageId);if(row)row.forwardedAt=item.time;}}}catch{}}
  const state={chargerConnected:false,backendConnected:false,id,upstream:currentUpstream,received:0,forwarded:0,lastSeen:null,lastHeartbeat:null,lastStatusNotification:null,lastMeterValues:archivedMeter?.time||null,lastMeterForwarded:archivedForward?.time||null,lastMeterMessageId:archivedMeter?.messageId||null,meterHistoryCount,meterHistory,connectedAt:null,backendConnectedAt:null,activeTransaction:false,transactionId:null,boot:null,connectors:{},meterValues:archivedMeter?.payload||null,configuration:[],configurationUpdatedAt:null,events:[],error:null,lastLocalCommand:null,roundTrips:[],connectionStats:{sessions:0,disconnects:0,backendErrors:0,chargerErrors:0,lastDisconnect:null,queuedMessages:0}};
  const recordMeter=item=>{if(!meterLogUrl)return;try{appendFileSync(meterLogUrl,JSON.stringify(item)+'\n');}catch(e){state.error='Meterarchief: '+e.message;}};
  const log=(action,detail='')=>{state.events.unshift({time:new Date().toISOString(),action,detail});state.events.splice(60);};
  function observe(raw,direction){
    state.received++;state.lastSeen=new Date().toISOString();
    try{const m=JSON.parse(raw);if(!Array.isArray(m))return;
      const action=m[0]===2?m[2]:m[0]===3?'Antwoord':'Foutantwoord';log(direction+' · '+action);
      if(direction==='Homebox'&&m[0]===2)roundTripPending.set(m[1],{time:Date.now(),action:m[2]});
      if(direction==='Robo Charge'&&[3,4].includes(m[0])){const sent=roundTripPending.get(m[1]);if(sent){roundTripPending.delete(m[1]);if(sent.action==='StartTransaction'&&m[0]===3&&Number.isInteger(m[2]?.transactionId))state.transactionId=m[2].transactionId;state.roundTrips.unshift({time:new Date().toISOString(),action:sent.action,ms:Date.now()-sent.time,ok:m[0]===3});state.roundTrips=state.roundTrips.slice(0,120);}}
      if(direction!=='Homebox' || m[0]!==2)return;
      const p=m[3];if(!p||typeof p!=='object')return;
      if(m[2]==='BootNotification')state.boot={vendor:p.chargePointVendor,model:p.chargePointModel,firmware:p.firmwareVersion};
      if(m[2]==='Heartbeat')state.lastHeartbeat=state.lastSeen;
      if(m[2]==='StatusNotification'&&Number.isInteger(p.connectorId)&&p.connectorId>=0&&p.connectorId<100){state.lastStatusNotification=state.lastSeen;state.connectors[p.connectorId]={status:p.status,errorCode:p.errorCode,time:state.lastSeen};}
      if(m[2]==='MeterValues'){state.lastMeterValues=state.lastSeen;state.lastMeterMessageId=m[1];state.meterHistoryCount++;state.meterValues={connectorId:p.connectorId,transactionId:p.transactionId??null,meterValue:p.meterValue,time:state.lastSeen};state.meterHistory.unshift(summary(state.meterValues,state.lastSeen,m[1]));state.meterHistory=state.meterHistory.slice(0,20);recordMeter({event:'received',time:state.lastSeen,messageId:m[1],payload:state.meterValues});}
      if(m[2]==='StartTransaction')state.activeTransaction=true;
      if(m[2]==='StopTransaction'){state.activeTransaction=false;state.transactionId=null;}
    }catch{log('Onleesbaar bericht','Ongewijzigd doorgestuurd');}
  }
  function localCommand(action,payload,timeout=8000){
    if(!active||active.down.readyState!==WebSocket.OPEN)throw Error('Homebox is niet verbonden');
    if(!['GetConfiguration','ChangeConfiguration','SetChargingProfile','ClearChargingProfile','TriggerMessage','Reset','UnlockConnector','ChangeAvailability','RemoteStartTransaction','RemoteStopTransaction','ClearCache'].includes(action))throw Error('Niet toegestane lokale OCPP-opdracht');
    const uid='ems-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    const started=new Date().toISOString();state.lastLocalCommand={action,status:'Verzonden',started};log('Lokaal → Homebox',action);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(uid);state.lastLocalCommand={action,status:'Timeout',started,finished:new Date().toISOString()};reject(Error('Geen antwoord van de Homebox binnen 8 seconden'));},timeout);timer.unref();
      pending.set(uid,{action,payload,started,timer,resolve,reject});
      active.down.send(JSON.stringify([2,uid,action,payload]),{binary:false},err=>{if(err){clearTimeout(timer);pending.delete(uid);reject(err);}});
    });
  }
  const server=http.createServer((req,res)=>{res.writeHead(426);res.end('OCPP WebSocket vereist');});
  // Some Ecotap controller builds emit text frames that are accepted by their
  // backend but fail the strict UTF-8 validator in ws. Preserve those bytes so
  // the relay remains transparent.
  const wss=new WebSocketServer({noServer:true,maxPayload:256*1024,skipUTF8Validation:true,handleProtocols:p=>p.has('ocpp1.6')?'ocpp1.6':false});
  server.on('upgrade',(req,socket,head)=>{
    const remote=socket.remoteAddress?.replace(/^::ffff:/,'');
    const expectedPath='/ocpp/'+(pathSecret?encodeURIComponent(pathSecret)+'/':'')+encodeURIComponent(id);
    if((allowedIp!=='*'&&remote!==allowedIp)||req.url!==expectedPath||!(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim()).includes('ocpp1.6')){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    // A controller can reconnect before the previous TCP close has propagated.
    // The newest authenticated session wins, avoiding a retry loop on 409.
    if(active){active.up.terminate();active.down.terminate();active=null;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',(down,req)=>{
    const headers={};if(req.headers.authorization)headers.Authorization=req.headers.authorization;
    const up=new WebSocket(state.upstream,'ocpp1.6',{handshakeTimeout:8000,maxPayload:256*1024,headers,perMessageDeflate:false,skipUTF8Validation:true});
    const session={down,up};active=session;state.chargerConnected=true;state.backendConnected=false;state.connectedAt=new Date().toISOString();state.error=null;state.connectionStats.sessions++;log('Homebox verbonden');
    let queue=[],queuedBytes=0,closing=false;
    const close=()=>{if(closing)return;closing=true;queue=[];state.connectionStats.queuedMessages=0;state.connectionStats.disconnects++;state.connectionStats.lastDisconnect=new Date().toISOString();roundTripPending.clear();if(active===session){active=null;state.chargerConnected=false;state.backendConnected=false;}for(const ws of [up,down]){if(ws.readyState===WebSocket.CONNECTING)ws.terminate();else if(ws.readyState===WebSocket.OPEN)ws.close(1011,'Relay connection ended');}const cleanup=setTimeout(()=>{up.terminate();down.terminate();},1000);cleanup.unref();};
    const forward=(target,data)=>{if(target.readyState!==WebSocket.OPEN||target.bufferedAmount>1024*1024){state.error='Verbinding onderbroken; Homebox moet opnieuw verbinden';close();return;}target.send(data,{binary:false},err=>{if(err)close();});state.forwarded++;if(target===up){try{const m=JSON.parse(data.toString());if(Array.isArray(m)&&m[0]===2&&m[2]==='MeterValues'){state.lastMeterForwarded=new Date().toISOString();const row=state.meterHistory.find(x=>x.messageId===m[1]);if(row)row.forwardedAt=state.lastMeterForwarded;recordMeter({event:'forwarded',time:state.lastMeterForwarded,messageId:m[1]});}}catch{}}};
    down.on('message',(raw,binary)=>{if(binary){close();return;}const text=raw.toString();observe(text,'Homebox');
      try{const m=JSON.parse(text),waiting=Array.isArray(m)&&[3,4].includes(m[0])?pending.get(m[1]):null;if(waiting){clearTimeout(waiting.timer);pending.delete(m[1]);const result=m[0]===3?m[2]:{errorCode:m[2],errorDescription:m[3],errorDetails:m[4]};if(waiting.action==='GetConfiguration'&&Array.isArray(result?.configurationKey)){state.configuration=result.configurationKey.map(row=>({key:String(row.key||''),readonly:!!row.readonly,value:String(row.value??'')}));state.configurationUpdatedAt=new Date().toISOString();}if(waiting.action==='ChangeConfiguration'&&result?.status==='Accepted'){const row=state.configuration.find(item=>item.key===waiting.payload?.key);if(row)row.value=String(waiting.payload.value??'');else state.configuration.push({key:String(waiting.payload?.key||''),readonly:false,value:String(waiting.payload?.value??'')});state.configurationUpdatedAt=new Date().toISOString();}state.lastLocalCommand={action:waiting.action,status:m[0]===3?(result?.status||'Antwoord'):'Foutantwoord',started:waiting.started,finished:new Date().toISOString(),result};log('Homebox → lokaal',waiting.action+' · '+state.lastLocalCommand.status);waiting.resolve(result);return;}}catch{}
      if(up.readyState===WebSocket.OPEN)forward(up,raw);else if(up.readyState===WebSocket.CONNECTING){queuedBytes+=raw.length;if(queue.length>=20||queuedBytes>256*1024){close();return;}queue.push(raw);state.connectionStats.queuedMessages=queue.length;}else close();});
    up.on('open',()=>{if(closing){up.close();return;}state.backendConnected=true;state.backendConnectedAt=new Date().toISOString();log('Robo Charge verbonden');for(const raw of queue)forward(up,raw);queue=[];queuedBytes=0;state.connectionStats.queuedMessages=0;});
    up.on('message',(raw,binary)=>{if(binary){close();return;}observe(raw.toString(),'Robo Charge');forward(down,raw);});
    for(const [ws,name]of [[up,'Robo Charge'],[down,'Homebox']]){
      ws.on('error',e=>{state.error=name+': '+e.message;if(ws===up)state.connectionStats.backendErrors++;else state.connectionStats.chargerErrors++;log('Verbindingsfout',state.error);close();});
      ws.on('close',()=>{if(active===session){if(ws===up)state.backendConnected=false;else state.chargerConnected=false;}log(name+' verbinding gesloten');close();});
    }
  });
  const html=`<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Homebox ↔ Robo Charge</title><style>body{font:17px system-ui;max-width:900px;margin:40px auto;padding:20px;background:#f2f5ef;color:#203d30}section{background:white;padding:24px;border-radius:15px;margin:20px 0;border:1px solid #ccdacc}h1{font-size:32px}p{line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.pill{font-weight:700}code{overflow-wrap:anywhere}</style><h1>Homebox ↔ jouw pc ↔ Robo Charge</h1><p>Echte verbindingstest. Berichten worden ongewijzigd doorgestuurd. De simulatie geeft hier geen laadopdrachten.</p><section><h2>Verbinding</h2><p id="connections" class="pill">Laden…</p><p id="error"></p><p id="count"></p></section><section><h2>Eenmalige instelling op de Homebox</h2><p><b>Alleen com_Endpoint wijzigen:</b><br><code>192.168.1.70:8765/ocpp/#OSN#</code></p><p>Terugzetten naar de rechtstreekse verbinding:<br><code>ocpp.robo-charge.net:80/#OSN#</code></p><p>Behoud je bestaande OCPP-ID en alle overige instellingen. Wijzig het adres zonder actieve laadsessie. De pc moet aan en bereikbaar blijven om de backofficeverbinding door te sturen. Een terugkeer naar de oude instelling moet handmatig gebeuren als de pc uitvalt.</p></section><section><h2>Laatste echte laadpaalstatus</h2><pre id="status">Nog geen berichten</pre></section><section><h2>Berichten</h2><pre id="events"></pre></section><script>async function poll(){try{const r=await fetch('/api/state');if(!r.ok)throw Error();const s=await r.json();document.getElementById('connections').textContent='Homebox: '+(s.chargerConnected?'verbonden':'wacht op verbinding')+' · Robo Charge: '+(s.backendConnected?'verbonden':'niet verbonden');document.getElementById('error').textContent=s.error||'';document.getElementById('count').textContent=s.forwarded+' berichten doorgestuurd';document.getElementById('status').textContent=JSON.stringify({apparaat:s.boot,aansluitingen:s.connectors,meetwaarden:s.meterValues},null,2);document.getElementById('events').textContent=s.events.map(e=>e.time.slice(11,19)+' '+e.action+' '+e.detail).join('\\n');}catch{document.getElementById('connections').textContent='Lokale tussenserver niet bereikbaar';}setTimeout(poll,1500);}poll();</script></html>`;
  const monitor=http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.method==='GET'&&req.url==='/api/state')return send(200,state);
    if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    if(req.method==='POST'&&req.url==='/api/command'){
      if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1')return send(403,{error:'Alleen lokaal toegestaan'});
      if(req.headers['content-type']!=='application/json')return send(415,{error:'JSON vereist'});
      try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw Error('Aanvraag te groot');}const body=JSON.parse(raw);return send(200,{result:await localCommand(body.action,body.payload)});}catch(e){return send(400,{error:e.message});}
    }
    if(req.method==='POST'&&req.url==='/api/routing'){
      if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1')return send(403,{error:'Alleen lokaal toegestaan'});
      if(req.headers['content-type']!=='application/json')return send(415,{error:'JSON vereist'});
      try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2048)throw Error('Aanvraag te groot');}const body=JSON.parse(raw),next=normalizeUpstream(body.upstream,id);writeFileSync(routingUrl,JSON.stringify({upstream:next,updatedAt:new Date().toISOString()},null,2));state.upstream=next;state.error=null;log('Proxyroute gewijzigd',next);if(active){active.up.terminate();active.down.close(1012,'Proxy route changed');}return send(200,{upstream:next,reconnecting:!!active});}catch(e){return send(400,{error:e.message});}
    }
    res.writeHead(404);res.end();
  });
  const listen=(s,p,h)=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen(p,h,resolve);});
  await listen(server,port,host);try{await listen(monitor,monitorPort,'127.0.0.1');}catch(e){server.close();throw e;}
  return {port:server.address().port,monitorPort:monitor.address().port,state,close:async()=>{if(active){active.up.terminate();active.down.terminate();}await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>monitor.close(r))]);wss.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const app=await startRelay({
    port:Number(process.env.OCPP_PORT||8765),monitorPort:Number(process.env.MONITOR_PORT||8081),host:process.env.OCPP_HOST||'0.0.0.0',
    allowedIp:process.env.CHARGER_ALLOWED_IP||'192.168.1.168',id:process.env.OCPP_ID||'RBC-0000032',
    upstream:process.env.OCPP_UPSTREAM||'ws://ocpp.robo-charge.net:80/RBC-0000032',meterLogFile:process.env.METER_LOG_FILE||'meter-values.ndjson',routingFile:process.env.ROUTING_FILE||'proxy-routing.json',pathSecret:process.env.OCPP_PATH_SECRET||''
  });
  writeFileSync(new URL('relay.pid',import.meta.url),String(process.pid));console.log(`Homebox-tussenserver draait op ${app.port}. Statusmonitor: ${app.monitorPort}`);process.on('SIGINT',async()=>{await app.close();process.exit();});
}
