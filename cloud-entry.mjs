import http from 'node:http';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {startRelay} from './relay.mjs';
import {startEMS} from './ems-server.mjs';

const listen=(server,port,host)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});

export async function startCloud({port=Number(process.env.PORT||process.env.APP_PORT||process.env.NODE_PORT||(process.env.RENDER?10000:8080)),host=process.env.RENDER?'0.0.0.0':'127.0.0.1',publicHost=process.env.PUBLIC_HOST||process.env.RENDER_EXTERNAL_HOSTNAME,id=process.env.OCPP_ID||'RBC-0000032',pathSecret=process.env.OCPP_PATH_SECRET,upstream=process.env.OCPP_UPSTREAM||`ws://ocpp.robo-charge.net:80/${id}`,authUser=process.env.DASHBOARD_USER,authPassword=process.env.DASHBOARD_PASSWORD,meterLogFile=process.env.METER_LOG_FILE||'data/meter-values.ndjson',routingFile=process.env.ROUTING_FILE||'data/proxy-routing.json'}={}){
  if(!publicHost||!pathSecret||!authUser||!authPassword)throw Error('PUBLIC_HOST, OCPP_PATH_SECRET, DASHBOARD_USER en DASHBOARD_PASSWORD zijn verplicht');
  let relay=null,ems=null;
  const gateway=http.createServer((req,res)=>{
    if(req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true,ready:!!ems}));return;}
    if(!ems){res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8','Retry-After':'1'});res.end('LaadFix EMS start op');return;}
    const target=http.request({hostname:'127.0.0.1',port:ems.port,path:req.url,method:req.method,headers:req.headers},upstreamResponse=>{res.writeHead(upstreamResponse.statusCode||502,upstreamResponse.headers);upstreamResponse.pipe(res);});
    target.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Dashboard tijdelijk niet bereikbaar');});req.pipe(target);
  });
  gateway.on('upgrade',(req,socket,head)=>{
    if(!relay||!req.url?.startsWith('/ocpp/')){socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');return;}
    const target=net.connect(relay.port,'127.0.0.1',()=>{
      target.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for(let i=0;i<req.rawHeaders.length;i+=2)target.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`);
      target.write('\r\n');if(head.length)target.write(head);socket.pipe(target).pipe(socket);
    });
    target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());
  });
  await listen(gateway,port,host);
  try{
    relay=await startRelay({port:0,monitorPort:0,host:'127.0.0.1',allowedIp:'127.0.0.1',id,pathSecret,upstream,meterLogFile,routingFile});
    ems=await startEMS({port:0,host:'127.0.0.1',hardware:true,ledHardware:false,publicHost,authUser,authPassword,relayMonitorPort:relay.monitorPort});
  }catch(error){if(ems)await ems.close();if(relay)await relay.close();await new Promise(resolve=>gateway.close(resolve));throw error;}
  return {port:gateway.address().port,relay,ems,close:async()=>{await new Promise(resolve=>gateway.close(resolve));await ems.close();await relay.close();}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const app=await startCloud();console.log(`LaadFix online proxy draait op poort ${app.port}`);const stop=async()=>{await app.close();process.exit();};process.on('SIGINT',stop);process.on('SIGTERM',stop);}
