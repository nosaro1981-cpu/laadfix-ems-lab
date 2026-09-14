import http from 'node:http';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {startRelay} from './relay.mjs';
import {startEMS} from './ems-server.mjs';

const listen=(server,port,host)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});

export function reconcileGatewayState(item,gateway,now=Date.now()){
  if(!gateway?.ok||now-Number(gateway.checkedAt||0)>6000)return item;
  const chargerConnected=item.chargerConnected===true||gateway.chargerConnected===true;
  const backendConnected=chargerConnected&&(item.backendConnected===true||gateway.backendConnected===true);
  return {...item,chargerConnected,backendConnected,gatewayHealth:{verified:true,version:gateway.gatewayVersion||null,socketCount:Number(gateway.socketCount||0),checkedAt:new Date(gateway.checkedAt).toISOString(),connectedAt:gateway.connectedAt||null,lastMessageAt:gateway.lastMessageAt||null,disagreesWithLocal:item.chargerConnected===true&&gateway.chargerConnected!==true}};
}

export async function startCloud({port=Number(process.env.PORT||process.env.APP_PORT||process.env.NODE_PORT||(process.env.RENDER?10000:8080)),host=process.env.RENDER?'0.0.0.0':'127.0.0.1',publicHost=process.env.PUBLIC_HOST||process.env.RENDER_EXTERNAL_HOSTNAME,publicOcppHost=process.env.OCPP_PUBLIC_HOST||'ocpp.throbbing-limit-d29f.workers.dev',id=process.env.OCPP_ID||'RBC-0000032',pathSecret=process.env.OCPP_PATH_SECRET,upstream=process.env.OCPP_UPSTREAM||`ws://ocpp.robo-charge.net:80/${id}`,upstreamTemplate=process.env.OCPP_UPSTREAM_TEMPLATE||'ws://ocpp.robo-charge.net:80/#OSN#',authUser=process.env.DASHBOARD_USER,authPassword=process.env.DASHBOARD_PASSWORD,meterLogFile=process.env.METER_LOG_FILE||'data/meter-values.ndjson',routingFile=process.env.ROUTING_FILE||'data/proxy-routing.json',gatewayHealthProvider=null,gatewayHealthIntervalMs=1500}={}){
  if(!publicHost||!pathSecret||!authUser||!authPassword)throw Error('PUBLIC_HOST, OCPP_PATH_SECRET, DASHBOARD_USER en DASHBOARD_PASSWORD zijn verplicht');
  let relay=null,ems=null;
  const relays=new Map();
  const gatewayStates=new Map();
  let gatewayHealthTimer=null;
  const validId=value=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
  const routeFor=chargerId=>chargerId===id?upstream:upstreamTemplate.replaceAll('#OSN#',chargerId).replaceAll('{id}',chargerId);
  const safeFileId=value=>value.replace(/[^A-Za-z0-9._-]/g,'_');
  async function getRelay(chargerId){
    if(relays.has(chargerId))return relays.get(chargerId);
    const promise=startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'127.0.0.1',id:chargerId,pathSecret,upstream:routeFor(chargerId),meterLogFile:chargerId===id?meterLogFile:`data/meter-values-${safeFileId(chargerId)}.ndjson`,routingFile:chargerId===id?routingFile:`data/proxy-routing-${safeFileId(chargerId)}.json`,legacyPingRecovery:false});
    relays.set(chargerId,promise);
    try{const app=await promise;relays.set(chargerId,app);return app;}catch(error){relays.delete(chargerId);throw error;}
  }
  const fleetState=()=>Array.from(relays.entries()).flatMap(([chargerId,value])=>value?.state?[reconcileGatewayState({id:chargerId,chargerConnected:value.state.chargerConnected,backendConnected:value.state.backendConnected,status:value.state.connectors?.[1]?.status||'Onbekend',errorCode:value.state.connectors?.[1]?.errorCode||null,lastSeen:value.state.lastSeen,lastHeartbeat:value.state.lastHeartbeat,lastStatusNotification:value.state.lastStatusNotification,lastMeterValues:value.state.lastMeterValues,lastMeterForwarded:value.state.lastMeterForwarded,meterHistoryCount:value.state.meterHistoryCount,forwarded:value.state.forwarded,received:value.state.received,upstream:value.state.upstream,error:value.state.error,boot:value.state.boot,connectors:value.state.connectors,meterValues:value.state.meterValues,meterHistory:value.state.meterHistory,events:value.state.events?.slice(0,30),ocppMessages:value.state.ocppMessages?.slice(0,200),activeTransaction:value.state.activeTransaction,transactionId:value.state.transactionId,lastLocalCommand:value.state.lastLocalCommand,commandHealth:value.state.commandHealth,configuration:value.state.configuration,configurationUpdatedAt:value.state.configurationUpdatedAt,diagnosticsStatus:value.state.diagnosticsStatus,diagnosticsStatusAt:value.state.diagnosticsStatusAt,remoteDiagnostics:value.state.remoteDiagnostics,connectionStats:value.state.connectionStats,connectionDiagnostics:value.state.connectionDiagnostics,connectionTimeline:value.state.connectionTimeline?.slice(0,40)},gatewayStates.get(chargerId))]:[]);
  const readGatewayHealth=gatewayHealthProvider||(process.env.RENDER?async chargerId=>{
    const url=new URL('/health',`http://${publicOcppHost}`);url.searchParams.set('station',chargerId);
    const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(1200)});
    if(!response.ok)throw Error('Gatewaystatus niet beschikbaar');return response.json();
  }:null);
  async function refreshGatewayStates(){
    if(!readGatewayHealth)return;
    await Promise.all(Array.from(relays.keys()).map(async chargerId=>{try{const state=await readGatewayHealth(chargerId);if(state?.station&&state.station!==chargerId)throw Error('Verkeerd laadstation in gatewaystatus');gatewayStates.set(chargerId,{...state,checkedAt:Date.now()});}catch{gatewayStates.delete(chargerId);}}));
  }
  async function changeFleetRoute(chargerId,nextUpstream){
    if(!validId(chargerId))throw Error('Ongeldige OCPP-ID');
    const chargerRelay=await getRelay(chargerId);
    if(chargerRelay.state.activeTransaction)throw Error('Bestemming wijzigen is geblokkeerd tijdens een actieve laadsessie');
    const response=await fetch(`http://127.0.0.1:${chargerRelay.monitorPort}/api/routing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upstream:nextUpstream})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Bestemming wijzigen mislukt');return {id:chargerId,...result};
  }
  async function fleetCommand(chargerId,action,payload,{timeoutMs}={}){
    if(!validId(chargerId))throw Error('Ongeldige OCPP-ID');
    const chargerRelay=await getRelay(chargerId);
    const response=await fetch(`http://127.0.0.1:${chargerRelay.monitorPort}/api/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload,timeoutMs})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'OCPP-opdracht mislukt');return result.result;
  }
  async function registerFleetStation(chargerId){
    if(!validId(chargerId))throw Error('Gebruik de exacte OCPP-ID van de laadcontroller');
    const chargerRelay=await getRelay(chargerId);
    return {id:chargerId,endpoint:`${publicOcppHost}:80/ocpp/${pathSecret}/${chargerId}`,upstream:chargerRelay.state.upstream};
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
    await refreshGatewayStates();
    ems=await startEMS({port:0,host:'127.0.0.1',hardware:true,ledHardware:false,publicHost,authUser,authPassword,relayMonitorPort:relay.monitorPort,fleetProvider:fleetState,fleetRegistrar:registerFleetStation,fleetRouteChanger:changeFleetRoute,fleetCommander:fleetCommand});
    if(readGatewayHealth){gatewayHealthTimer=setInterval(refreshGatewayStates,Math.max(500,gatewayHealthIntervalMs));gatewayHealthTimer.unref?.();}
  }catch(error){if(ems)await ems.close();if(relay)await relay.close();await new Promise(resolve=>gateway.close(resolve));throw error;}
  return {port:gateway.address().port,relay,ems,relays,close:async()=>{
    // Stop accepting connections, then close the relays that keep the gateway open.
    if(gatewayHealthTimer)clearInterval(gatewayHealthTimer);
    const gatewayClosed=new Promise(resolve=>gateway.close(resolve));
    for(const value of relays.values()){try{await (await value).close();}catch{}}
    await ems.close();
    await gatewayClosed;
  }};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const app=await startCloud();console.log(`LaadFix online proxy draait op poort ${app.port}`);const stop=async()=>{await app.close();process.exit();};process.on('SIGINT',stop);process.on('SIGTERM',stop);}
