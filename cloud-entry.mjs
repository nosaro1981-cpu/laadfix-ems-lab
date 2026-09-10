import http from 'node:http';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {startRelay} from './relay.mjs';
import {startEMS} from './ems-server.mjs';

const listen=(server,port,host)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});

export async function startCloud({port=Number(process.env.PORT||process.env.APP_PORT||process.env.NODE_PORT||(process.env.RENDER?10000:8080)),host=process.env.RENDER?'0.0.0.0':'127.0.0.1',publicHost=process.env.PUBLIC_HOST||process.env.RENDER_EXTERNAL_HOSTNAME,id=process.env.OCPP_ID||'RBC-0000032',pathSecret=process.env.OCPP_PATH_SECRET,upstream=process.env.OCPP_UPSTREAM||`ws://ocpp.robo-charge.net:80/${id}`,upstreamTemplate=process.env.OCPP_UPSTREAM_TEMPLATE||'ws://ocpp.robo-charge.net:80/#OSN#',authUser=process.env.DASHBOARD_USER,authPassword=process.env.DASHBOARD_PASSWORD,meterLogFile=process.env.METER_LOG_FILE||'data/meter-values.ndjson',routingFile=process.env.ROUTING_FILE||'data/proxy-routing.json'}={}){
  if(!publicHost||!pathSecret||!authUser||!authPassword)throw Error('PUBLIC_HOST, OCPP_PATH_SECRET, DASHBOARD_USER en DASHBOARD_PASSWORD zijn verplicht');
  let relay=null,ems=null;
  const relays=new Map();
  const validId=value=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
  const routeFor=chargerId=>chargerId===id?upstream:upstreamTemplate.replaceAll('#OSN#',chargerId).replaceAll('{id}',chargerId);
  const safeFileId=value=>value.replace(/[^A-Za-z0-9._-]/g,'_');
  async function getRelay(chargerId){
    if(relays.has(chargerId))return relays.get(chargerId);
    const promise=startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'127.0.0.1',id:chargerId,pathSecret,upstream:routeFor(chargerId),meterLogFile:chargerId===id?meterLogFile:`data/meter-values-${safeFileId(chargerId)}.ndjson`,routingFile:chargerId===id?routingFile:`data/proxy-routing-${safeFileId(chargerId)}.json`});
    relays.set(chargerId,promise);
    try{const app=await promise;relays.set(chargerId,app);return app;}catch(error){relays.delete(chargerId);throw error;}
  }
  const fleetState=()=>Array.from(relays.entries()).flatMap(([chargerId,value])=>value?.state?[{id:chargerId,chargerConnected:value.state.chargerConnected,backendConnected:value.state.backendConnected,status:value.state.connectors?.[1]?.status||'Onbekend',errorCode:value.state.connectors?.[1]?.errorCode||null,lastSeen:value.state.lastSeen,lastHeartbeat:value.state.lastHeartbeat,forwarded:value.state.forwarded,received:value.state.received,upstream:value.state.upstream,error:value.state.error,boot:value.state.boot,connectors:value.state.connectors,meterValues:value.state.meterValues,meterHistory:value.state.meterHistory,events:value.state.events?.slice(0,30),activeTransaction:value.state.activeTransaction,transactionId:value.state.transactionId,lastLocalCommand:value.state.lastLocalCommand}]:[]);
  async function changeFleetRoute(chargerId,nextUpstream){
    if(!validId(chargerId))throw Error('Ongeldige OCPP-ID');
    const chargerRelay=await getRelay(chargerId);
    if(chargerRelay.state.activeTransaction)throw Error('Bestemming wijzigen is geblokkeerd tijdens een actieve laadsessie');
    const response=await fetch(`http://127.0.0.1:${chargerRelay.monitorPort}/api/routing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upstream:nextUpstream})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Bestemming wijzigen mislukt');return {id:chargerId,...result};
  }
  async function fleetCommand(chargerId,action,payload){
    if(!validId(chargerId))throw Error('Ongeldige OCPP-ID');
    const chargerRelay=await getRelay(chargerId);
    const response=await fetch(`http://127.0.0.1:${chargerRelay.monitorPort}/api/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'OCPP-opdracht mislukt');return result.result;
  }
  const gateway=http.createServer((req,res)=>{
    if(req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,ready:!!ems}));return;}
    if(!ems){res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8','Retry-After':'1'});res.end('LaadFix EMS start op');return;}
    const target=http.request({hostname:'127.0.0.1',port:ems.port,path:req.url,method:req.method,headers:req.headers},upstreamResponse=>{res.writeHead(upstreamResponse.statusCode||502,upstreamResponse.headers);upstreamResponse.pipe(res);});
    target.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Dashboard tijdelijk niet bereikbaar');});req.pipe(target);
  });
  gateway.on('upgrade',async(req,socket,head)=>{
    const parts=(req.url||'').split('?')[0].split('/').filter(Boolean);
    let chargerId='';try{chargerId=decodeURIComponent(parts[2]||'');}catch{}
    if(parts.length!==3||parts[0]!=='ocpp'||parts[1]!==pathSecret||!validId(chargerId)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    socket.pause();
    let chargerRelay;try{chargerRelay=await getRelay(chargerId);}catch{socket.destroy();return;}
    const target=net.connect(chargerRelay.port,'127.0.0.1',()=>{
      target.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for(let i=0;i<req.rawHeaders.length;i+=2)target.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`);
      target.write('\r\n');if(head.length)target.write(head);socket.pipe(target).pipe(socket);socket.resume();
    });
    target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());
  });
  await listen(gateway,port,host);
  try{
    relay=await getRelay(id);
    ems=await startEMS({port:0,host:'127.0.0.1',hardware:true,ledHardware:false,publicHost,authUser,authPassword,relayMonitorPort:relay.monitorPort,fleetProvider:fleetState,fleetRouteChanger:changeFleetRoute,fleetCommander:fleetCommand});
  }catch(error){if(ems)await ems.close();if(relay)await relay.close();await new Promise(resolve=>gateway.close(resolve));throw error;}
  return {port:gateway.address().port,relay,ems,relays,close:async()=>{await new Promise(resolve=>gateway.close(resolve));await ems.close();for(const value of relays.values()){try{await (await value).close();}catch{}}}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const app=await startCloud();console.log(`LaadFix online proxy draait op poort ${app.port}`);const stop=async()=>{await app.close();process.exit();};process.on('SIGINT',stop);process.on('SIGTERM',stop);}
