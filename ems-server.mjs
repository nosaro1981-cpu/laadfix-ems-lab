import http from 'node:http';
import net from 'node:net';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { diagnosticLocation as diagnosticLocationForRequest, testDiagnosticFtp } from './diagnostic-ftp.mjs';
import { createEngine, simulatedFleet } from './ems.mjs';
import { createRecoveryMonitor } from './power-recovery.mjs';
import { connectionIntelligence, analyzeControllerLog, assessMeterIdentity, extractCellularIdentity, extractMeterIdentity, extractMeterIdentities, extractDiagnosticOverview, normalizeControllerLog, readableControllerLog, diagnosticAnalysisWindow } from './connection-intelligence.mjs';
import { auditStation } from './station-watchdog.mjs';
import { createRecoveryCenter, recoveryGuard, connectorIds } from './recovery-center.mjs';
import { createRecoveryCaseManager } from './recovery-case-manager.mjs';

export function privateIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const p = ip.split('.').map(Number);
  return (p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31) && p[3] !== 0 && p[3] !== 255;
}
export function colourForStatus(status, chargerConnected=true, backendConnected=true) {
  if (!chargerConnected || !backendConnected || ['Faulted','Unavailable'].includes(status)) return 'red';
  if (status === 'Available') return 'green';
  if (['Preparing','Charging','SuspendedEV','SuspendedEVSE','Finishing'].includes(status)) return 'blue';
  return 'red';
}

export function maximizeDiagnosticDebug(value){
  const verbose=new Set(['gsm','com','ocpp','eth','grid','ctrl','general','sensors','fw','modbus','canbus','sys']);
  return String(value||'').split(',').map(part=>{const [key,...rest]=part.split('=');return verbose.has(key.trim().toLowerCase())?`${key}=7`:rest.length?part:null;}).filter(Boolean).join(',');
}
export const DIAGNOSTIC_DEBUG_BASE='warn=1,error=1,date=1,syslog=1,gsm=3,events=1,com=1,ocpp=7,eth=1,grid=1,ctrl=3,general=1,sensors=0,fw=1,modbus=3,canbus=3,sys=0';
const DIAGNOSTIC_DEBUG_KEYS=new Set(DIAGNOSTIC_DEBUG_BASE.split(',').map(part=>part.split('=')[0]));
export function selectDiagnosticDebug(modules=[]){
  const selected=new Set((Array.isArray(modules)?modules:[]).map(value=>String(value).toLowerCase()).filter(value=>DIAGNOSTIC_DEBUG_KEYS.has(value)));
  return DIAGNOSTIC_DEBUG_BASE.split(',').map(part=>{const [key,value]=part.split('=');return `${key}=${selected.has(key)?7:value}`;}).join(',');
}
const ocppDateTime=value=>new Date(value).toISOString().replace(/\.\d{3}Z$/,'Z');
export function extractMeterReadings(meterValues,lastMeterValues=null,now=Date.now()){
  const groups=Array.isArray(meterValues?.meterValue)?meterValues.meterValue:[];
  const samples=groups.flatMap(group=>(Array.isArray(group?.sampledValue)?group.sampledValue:[]).map(v=>({...v,timestamp:group.timestamp||meterValues?.time||lastMeterValues})));
  const find=(measurand,units=[])=>{const values=samples.filter(v=>(v.measurand||'Energy.Active.Import.Register')===measurand&&(!units.length||units.includes(v.unit)));if(!values.length)return null;const v=values.at(-1),value=Number(v.value);return Number.isFinite(value)?{value,unit:v.unit||units[0]||'',phase:v.phase||null,timestamp:v.timestamp||lastMeterValues}:null;};
  const timestamp=groups.at(-1)?.timestamp||meterValues?.time||lastMeterValues||null;
  return {energy:find('Energy.Active.Import.Register',['Wh','kWh']),power:find('Power.Active.Import',['W','kW']),current:find('Current.Import',['A'])||find('Current.Offered',['A']),timestamp,ageSeconds:timestamp?Math.max(0,Math.floor((now-Date.parse(timestamp))/1000)):null,stale:!timestamp||now-Date.parse(timestamp)>90000,sampleCount:samples.length};
}
export async function probe(ip) {
  if (!privateIPv4(ip)) throw Error('Vul een lokaal IPv4-adres in, bijvoorbeeld 192.168.1.50');
  const started = Date.now();
  return new Promise(resolve => {
    const socket = new net.Socket(); let finished = false;
    const done = (reachable, detail) => { if(finished)return;finished=true;socket.destroy();resolve({ ip, port:502, reachable, detail, elapsedMs:Date.now()-started, protocolVerified:false, time:new Date().toISOString() }); };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true, 'Poort 502 is bereikbaar. Dit bevestigt nog geen Modbus-ondersteuning of vermogensregeling.'));
    socket.once('timeout', () => done(false, 'Geen antwoord op poort 502. Controleer het IP-adres en de lokale koppeling.'));
    socket.once('error', e => done(false, ['EACCES','EPERM'].includes(e.code) ? 'Windows of de uitvoeromgeving blokkeert deze netwerkcontrole. Dit zegt niets over de bereikbaarheid van de laadpaal.' : e.code === 'ECONNREFUSED' ? 'Verbinding geweigerd op poort 502. Er is daar nu geen bereikbare dienst.' : 'Geen verbinding: '+e.code));
    socket.connect(502, ip);
  });
}
export function assessService(charger,now=Date.now()) {
  const age=charger.lastSeen?now-Date.parse(charger.lastSeen):null;
  const heartbeatAge=charger.lastHeartbeat?now-Date.parse(charger.lastHeartbeat):null;
  const status=charger.effectiveStatus||charger.status;
  const layers=[
    {key:'service',name:'Lokale service',ok:charger.relayReachable,detail:charger.relayReachable?'Proxy en dashboard bereikbaar':'OCPP-proxy niet bereikbaar'},
    {key:'station',name:'Homebox',ok:charger.chargerConnected,detail:charger.chargerConnected?'OCPP-verbinding actief':'Geen inkomende OCPP-verbinding'},
    {key:'backend',name:'Robo Charge',ok:charger.backendConnected,detail:charger.backendConnected?'Backoffice verbonden':'Backoffice niet verbonden'},
    {key:'heartbeat',name:'Recente communicatie',ok:age!==null&&age<240000,detail:age===null?'Nog geen bericht ontvangen':age<240000?`Laatste bericht ${Math.max(0,Math.round(age/1000))} seconden geleden`:`Laatste bericht ${Math.round(age/60000)} minuten geleden`},
    {key:'charger',name:'Laadcontroller',ok:!['Faulted','Unavailable'].includes(status)&&(!charger.errorCode||charger.errorCode==='NoError'),detail:charger.errorCode&&charger.errorCode!=='NoError'?`${status}: ${charger.errorCode}`:status||'Status onbekend'},
  ];
  let severity='ok',summary='Installatie communiceert normaal',advice='Geen herstelactie nodig.';
  if(!charger.relayReachable){severity='critical';summary='Lokale OCPP-service is niet bereikbaar';advice='Start de lokale service opnieuw.';}
  else if(!charger.chargerConnected){severity='critical';summary='Homebox meldt zich niet aan bij de proxy';advice='Controleer com_Endpoint, ethernet en herstart alleen de communicatie of laadcontroller.';}
  else if(!charger.backendConnected){severity='critical';summary='Homebox bereikt de proxy, maar Robo Charge niet';advice='Controleer internet, DNS en de upstream-backoffice.';}
  else if(age===null||age>=240000){severity='warning';summary='OCPP-communicatie is stilgevallen';advice='Vraag eerst een actuele status op. Voer pas daarna eventueel een soft reset uit.';}
  else if(['Faulted','Unavailable'].includes(status)||charger.errorCode&&charger.errorCode!=='NoError'){severity='warning';summary=`Laadpunt meldt ${status||charger.errorCode}`;advice='Lees de foutcode en configuratie uit voordat je een reset uitvoert.';}
  return {severity,summary,advice,layers,lastMessageAgeMs:age,lastHeartbeatAgeMs:heartbeatAge,activeTransaction:!!charger.activeTransaction,generatedAt:new Date(now).toISOString()};
}
async function tcpCheck(host,port,timeout=2500){return new Promise(resolve=>{const socket=new net.Socket();let done=false;const finish=(ok,detail)=>{if(done)return;done=true;socket.destroy();resolve({host,port,ok,detail});};socket.setTimeout(timeout);socket.once('connect',()=>finish(true,'Bereikbaar'));socket.once('timeout',()=>finish(false,'Timeout'));socket.once('error',e=>finish(false,e.code||e.message));socket.connect(port,host);});}
export async function networkDiagnostics(){
  const started=new Date().toISOString();let dns={ok:false,host:'ocpp.robo-charge.net'};
  try{const result=await lookup(dns.host);dns={...dns,ok:true,address:result.address};}catch(e){dns={...dns,error:e.code||e.message};}
  const backend=await tcpCheck('ocpp.robo-charge.net',80);
  const homebox=await tcpCheck('192.168.1.168',80,1200);
  return {started,dns,backend,homebox:{...homebox,note:homebox.ok?'HTTP-poort bereikbaar':'Geen HTTP-poort; het apparaat kan nog wel via OCPP uitgaand verbinden'}};
}
export async function recoveryNetworkDiagnostics(station) {
  let url;
  try { url = new URL(station.upstream); } catch { return { ok: false, lines: ['Geen geldige backofficebestemming bekend.'] }; }
  if (!['ws:', 'wss:'].includes(url.protocol)) return { ok: false, lines: ['Backofficebestemming is geen WebSocket-adres.'] };
  const host = url.hostname, port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80)), lines = [];
  let dnsOk = false;
  try { const result = await Promise.race([lookup(host), new Promise((_, reject) => { const t = setTimeout(() => reject(Error('DNS-timeout')), 4000); t.unref(); })]); dnsOk = true; lines.push(`DNS: ${result.address}`); } catch (e) { lines.push(`DNS mislukt: ${e.code || e.message}`); }
  const tcp = dnsOk ? await tcpCheck(host, port) : { ok: false, detail: 'Niet getest omdat DNS niet is opgelost' };
  lines.push(`Serverpoort: ${tcp.ok ? 'bereikbaar' : tcp.detail}`, 'Test uitgevoerd vanaf de proxy. Een open serverpoort bewijst geen geslaagde OCPP-aanmelding of bereikbaarheid vanaf de laadlocatie.');
  return { host, port, ok: dnsOk && tcp.ok, lines };
}

export function mergePrimaryFleetState(charger, fleet) {
  const primary = Array.isArray(fleet) ? fleet.find(item => item.id === charger.id) : null;
  return primary ? { ...charger, ...primary, relayReachable: true } : charger;
}

export async function startEMS({port=8080,host='127.0.0.1',hardware=true,ledHardware=hardware,publicHost=null,authUser=null,authPassword=null,relayMonitorPort=8081,fleetProvider=null,fleetRouteChanger=null,fleetCommander=null,meterPollIntervalMs=30000,diagnosticCaptureMs=null,diagnosticLocalTimeoutMs=null}={}) {
  const engine = createEngine(); let state = engine.tick(); let diagnostic = null; let busy = false;
  const recoveryMonitor=createRecoveryMonitor({configured:false});
  let powerRecovery=null;
  const publicName=publicHost?.replace(/^https?:\/\//,'').replace(/\/$/,'')||null;
  if(publicName&&(!authUser||!authPassword))throw Error('Voor een openbaar dashboard zijn DASHBOARD_USER en DASHBOARD_PASSWORD verplicht');
  const ocppPathSecret=process.env.OCPP_PATH_SECRET||'';
  let charger={relayReachable:false,chargerConnected:false,backendConnected:false,status:'Onbekend',errorCode:null,lastSeen:null,id:process.env.OCPP_ID||'RBC-0000032',incomingIp:'192.168.1.168',localEndpoint:publicName?`wss://${publicName}/ocpp/${ocppPathSecret?encodeURIComponent(ocppPathSecret)+'/':''}${process.env.OCPP_ID||'RBC-0000032'}`:'ws://192.168.1.70:8765/ocpp/RBC-0000032',forwarded:0,received:0,events:[],relayError:null};
  let led={configured:ledHardware&&existsSync(new URL('lsc-devices.json',import.meta.url)),automatic:true,desiredColour:null,lastAction:null,error:null,busy:false};
  let statusSimulation=null;
  let connectionSamples=[],logAnalysis=null;
  let liveControl=false,lastSentLimit=null,lastControlError=null,lastControlResult=null,capabilities=null,serviceResult=null,networkResult=null,lastMeterRequest=0,meterRequestResult=null;
  const watchdogRequested=new Set();
  const diagnosticTokens=new Map(),diagnosticReports=new Map(),diagnosticHistories=new Map(),diagnosticHistoryLoads=new Map(),diagnosticFiles=new Map(),importedRemoteDiagnostics=new Set();
  const releaseDiagnosticTicket=ticket=>{if(!ticket)return;if(ticket.token)diagnosticTokens.delete(ticket.token);else for(const[token,value]of diagnosticTokens)if(value===ticket)diagnosticTokens.delete(token);};
  const updateDiagnosticProgress=(chargerId,ticket,progress,extra={})=>{ticket.progress={...(ticket.progress||{}),...progress,updatedAt:new Date().toISOString()};diagnosticReports.set(chargerId,{...(diagnosticReports.get(chargerId)||ticket),...ticket,...extra,progress:ticket.progress});};
  const deferBackgroundReadings=id=>{
    const report=diagnosticReports.get(id);
    return !!(report&&report.expiresAt>Date.now()&&(report.status==='Aangevraagd'||report.quietDiagnostics===true&&['FTP-upload wordt gevolgd','Upload verwacht','FTP-bestand wordt gezocht','Opdracht geaccepteerd'].includes(report.status)));
  };
  const diagnosticFtpUrl=String(process.env.DIAGNOSTICS_FTP_URL||'').trim();
  const diagnosticFtpPollMs=Math.max(2000,Number(process.env.DIAGNOSTICS_FTP_POLL_MS)||5000);
  const diagnosticFtpTimeoutMs=Math.max(60000,Number(process.env.DIAGNOSTICS_FTP_TIMEOUT_MS)||180000);
  const diagnosticFtpMaxAttempts=Math.max(2,Math.ceil(diagnosticFtpTimeoutMs/diagnosticFtpPollMs));
  const localUploadTimeoutMs=diagnosticLocalTimeoutMs===null?Math.max(60000,Number(process.env.DIAGNOSTICS_LOCAL_TIMEOUT_MS)||120000):Math.max(10,Number(diagnosticLocalTimeoutMs));
  let diagnosticFtpHost=null;
  try{diagnosticFtpHost=diagnosticFtpUrl?new URL(diagnosticFtpUrl).hostname.toLowerCase():null;}catch{}
  const diagnosticDestination=diagnosticFtpHost?`LaadFix FTP (${diagnosticFtpHost})`:'LaadFix beveiligde upload';
  const diagnosticHistoryFile=id=>`LaadFix-history-${String(id).replace(/[^A-Za-z0-9._-]/g,'_')}.json`;
  const diagnosticTransferEstimateMs=chargerId=>{const samples=(diagnosticHistories.get(chargerId)||[]).map(row=>Date.parse(row.receivedAt)-Date.parse(row.stopTime||row.requestedAt)).filter(value=>Number.isFinite(value)&&value>5_000&&value<10*60_000).slice(0,6).sort((a,b)=>a-b);if(!samples.length)return 100_000;return Math.max(30_000,Math.min(180_000,samples[Math.floor(samples.length/2)]));};
  const diagnosticFtpAccess=async client=>{const url=new URL(diagnosticFtpUrl);await client.access({host:url.hostname,port:Number(url.port||21),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),secure:url.protocol==='ftps:'});return{directory:decodeURIComponent(url.pathname||'/').replace(/\/$/,'')||'/'};};
  const diagnosticRemotePath=(directory,file)=>(directory==='/'?'':directory)+'/'+file;
  const loadDiagnosticHistory=chargerId=>{if(diagnosticHistoryLoads.has(chargerId))return diagnosticHistoryLoads.get(chargerId);const task=(async()=>{if(!diagnosticFtpUrl){diagnosticHistories.set(chargerId,[]);return [];}const client=new FtpClient(15000),chunks=[];try{const{directory}=await diagnosticFtpAccess(client),sink=new Writable({write(chunk,encoding,callback){chunks.push(Buffer.from(chunk));callback();}});await client.downloadTo(sink,diagnosticRemotePath(directory,diagnosticHistoryFile(chargerId)));const rows=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(rows))throw Error('Ongeldige diagnosegeschiedenis');rows.sort((a,b)=>Date.parse(b.receivedAt||b.requestedAt)-Date.parse(a.receivedAt||a.requestedAt));diagnosticHistories.set(chargerId,rows);if(rows[0]&&!diagnosticReports.has(chargerId))diagnosticReports.set(chargerId,rows[0]);return rows;}catch{diagnosticHistories.set(chargerId,[]);return [];}finally{client.close();}})();diagnosticHistoryLoads.set(chargerId,task);return task;};
  const persistDiagnosticHistory=async chargerId=>{if(!diagnosticFtpUrl)return false;const client=new FtpClient(15000);try{const{directory}=await diagnosticFtpAccess(client),content=Buffer.from(JSON.stringify(diagnosticHistories.get(chargerId)||[]));await client.uploadFrom(Readable.from([content]),diagnosticRemotePath(directory,diagnosticHistoryFile(chargerId)));return true;}finally{client.close();}};
  const rememberDiagnosticReport=async(chargerId,report)=>{diagnosticReports.set(chargerId,report);if(report?.status!=='Ontvangen')return report;await loadDiagnosticHistory(chargerId);const rows=diagnosticHistories.get(chargerId)||[],key=`${report.receivedAt||''}:${report.fileName||''}`,history=[report,...rows.filter(item=>`${item.receivedAt||''}:${item.fileName||''}`!==key)];diagnosticHistories.set(chargerId,history);try{await persistDiagnosticHistory(chargerId);report.archiveStatus=diagnosticFtpUrl?'Bewaard in centrale diagnosegeschiedenis':'Alleen tijdens deze serversessie bewaard';}catch(error){report.archiveStatus='Centrale opslag mislukt: '+error.message;}diagnosticReports.set(chargerId,report);return report;};
  void loadDiagnosticHistory(charger.id);
  const recoveryStations = () => typeof fleetProvider === 'function' ? fleetProvider() : [charger];
  const recoveryStation = id => recoveryStations().find(item => item.id === id);
  const stationCommand = (id, action, payload) => typeof fleetCommander === 'function' ? fleetCommander(id, action, payload) : id === charger.id ? relayCommand(action, payload) : Promise.reject(Error('Onbekend laadstation'));
  const requestShortDiagnostics = async (chargerId, minutes = 5) => {
    if (!publicName && !diagnosticFtpUrl) throw Error('Er is geen bereikbaar uploadadres ingesteld. Gebruik Robo Charge of configureer de diagnose-ontvanger.');
    const existing = diagnosticReports.get(chargerId);
    if (existing && !['Ontvangen', 'Mislukt'].includes(existing.status) && Date.now() - Date.parse(existing.requestedAt) < 15 * 60000) throw Error('Er wordt al een diagnose-upload gevolgd. Bekijk eerst de uploadstatus.');
    const token = randomBytes(24).toString('hex'), stopTime = ocppDateTime(Date.now()), startTime = ocppDateTime(Date.now() - minutes * 60000), requestedAt = stopTime;
    const ticket = { token, chargerId, requestedAt, startTime, stopTime, minutes, source:'LaadFix', destination:diagnosticDestination, locationHost:diagnosticFtpHost||publicName, expiresAt: Date.now() + 15 * 60000, fileName: null };
    diagnosticTokens.set(token, ticket);
    diagnosticReports.set(chargerId, { ...ticket, status: 'Aangevraagd', locationReady: true });
    try {
      const result = await stationCommand(chargerId, 'GetDiagnostics', { location: diagnosticFtpUrl || `https://${publicName}/api/diagnostics-upload/${token}/${encodeURIComponent(chargerId)}`, retries: 2, retryInterval: 60, startTime, stopTime });
      if (result?.errorCode) throw Error(result.errorDescription || result.errorCode);
      ticket.fileName = result?.fileName || null;
      // The upload may finish before the OCPP response arrives.
      const received = diagnosticReports.get(chargerId);
      if (received?.status !== 'Ontvangen') diagnosticReports.set(chargerId, { ...received, status: ticket.fileName ? (diagnosticFtpUrl?'FTP-upload wordt gevolgd':'Upload verwacht') : 'Mislukt', fileName: ticket.fileName, error: ticket.fileName ? null : 'Geen bestandsnaam ontvangen.', transport: diagnosticFtpUrl ? 'FTP' : 'HTTPS' });
      if (diagnosticFtpUrl && ticket.fileName) scheduleFtpDiagnosticDownload(chargerId, ticket);
      return { fileName: ticket.fileName };
    } catch (e) { diagnosticTokens.delete(token); diagnosticReports.set(chargerId, { ...diagnosticReports.get(chargerId), status: 'Mislukt', error: e.message }); throw e; }
  };
  const recoveryCenter = createRecoveryCenter({ getStation: recoveryStation, command: stationCommand, checkNetwork: recoveryNetworkDiagnostics, requestDiagnostics: requestShortDiagnostics, beforeClearTestProfile: id => { if (id === charger.id) { liveControl = false; lastSentLimit = null; } } });
  const recoveryCases = createRecoveryCaseManager({ getStation: recoveryStation, command: stationCommand, changeRoute: fleetRouteChanger, getDiagnostic: id => diagnosticReports.get(id), actor: () => ({ name: authUser || 'lokale-operator', role: 'operator' }) });
  const parseMeterConfiguration=(raw,slot)=>{const parts=String(raw||'').split(',');return raw?{slot,raw,type:parts[0]||null,address:parts[1]||null,baudrate:parts[2]||null,parity:parts[3]||null,stopBits:parts[4]||null}:null;};
  const buildDiagnosticReport=(chargerId,ticket,content)=>{
    const source=Buffer.isBuffer(content)?content.toString('utf8'):String(content),text=normalizeControllerLog(source),analysis=analyzeControllerLog(diagnosticAnalysisWindow(text)),item=(typeof fleetProvider==='function'?fleetProvider():[]).find(row=>row.id===chargerId),meterSettings=ticket.meterSettings||item?.configuration?.filter(row=>/^chg_KWH[12]$/i.test(row.key))||[],overview=extractDiagnosticOverview(text),cellular=extractCellularIdentity(text),excerpt=readableControllerLog(source).slice(-20000).replace(/ftps?:\/\/[^\s"'<>]+/gi,'[FTP-afgeschermd]');
    const meterSlots=extractMeterIdentities(text,meterSettings).map(identity=>{const configuration=parseMeterConfiguration(identity.setting,identity.slot),assessment=assessMeterIdentity(text,identity.setting,analysis,identity.slot),addressIssue=Number(configuration?.address)!==identity.slot||identity.addressMatches===false||(!identity.successfulReads&&identity.timeouts>0);let addressLabel='Adres nog niet bevestigd';if(identity.addressMatches===true)addressLabel=`Adres ${identity.expectedAddress} antwoordt correct`;else if(identity.addressMatches===false)addressLabel=`Verkeerd antwoordend adres: ${identity.respondingAddresses.map(row=>row.address).join(', ')}`;else if(!identity.successfulReads&&identity.timeouts>0)addressLabel=`Adres ${configuration?.address||identity.expectedAddress} reageert niet`;return{slot:identity.slot,expectedAddress:identity.expectedAddress,configuration,identity,assessment,addressIssue,addressLabel};});
    const primary=meterSlots.find(row=>row.slot===1)||meterSlots[0]||null,meterConfiguration=primary?.configuration||null,meterIdentity=primary?.identity||extractMeterIdentity(text,meterConfiguration?.raw),meterAssessment=primary?.assessment||assessMeterIdentity(text,meterConfiguration?.raw,analysis);
    return{chargerId,status:'Ontvangen',quickMode:ticket.quickMode===true,progress:{phase:'complete',label:ticket.quickMode?'Snelle diagnose gereed':'Diagnose gereed',percent:100},requestedAt:ticket.requestedAt,startTime:ticket.startTime||null,stopTime:ticket.stopTime||null,minutes:ticket.minutes??null,durationSeconds:ticket.durationSeconds??(ticket.minutes==null?null:ticket.minutes*60),source:ticket.source||'LaadFix',destination:ticket.destination||diagnosticDestination,locationHost:ticket.locationHost||diagnosticFtpHost||null,receivedAt:new Date().toISOString(),fileName:ticket.fileName||null,bytes:Buffer.byteLength(content),controllerStatus:item?.diagnosticsStatus||null,meterConfiguration,meterIdentity,meterAssessment,meterSlots,overview,cellular,analysis,excerpt};
  };
  const scheduleFtpDiagnosticDownload=(chargerId,ticket)=>{
    let attempts=0,lastSize=null,stable=0;
    updateDiagnosticProgress(chargerId,ticket,{phase:'uploading',label:'Online upload volgen',percent:65,estimatedCompleteAt:new Date(Date.now()+120_000).toISOString()});
    const run=async()=>{
      attempts++;
      const client=new FtpClient(15000);
      try{
        const url=new URL(diagnosticFtpUrl),fileName=String(ticket.fileName||'').split(/[\\/]/).at(-1);
        if(!fileName)throw Error('Homebox heeft geen bestandsnaam gemeld');
        await client.access({host:url.hostname,port:Number(url.port||21),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),secure:url.protocol==='ftps:'});
        const directory=decodeURIComponent(url.pathname||'/').replace(/\/$/,'')||'/',entries=await client.list(directory),entry=entries.find(row=>row.name===fileName);
        if(!entry)throw Error('Bestand staat nog niet op de FTP-server');
        stable=entry.size===lastSize?stable+1:0;lastSize=entry.size;
        if(stable<1)throw Error('Upload is nog bezig');
        updateDiagnosticProgress(chargerId,ticket,{phase:'analyzing',label:'Bestand analyseren',percent:88,estimatedCompleteAt:new Date(Date.now()+15_000).toISOString()},{status:'Log analyseren'});
        const chunks=[];let bytes=0;
        const sink=new Writable({write(chunk,encoding,callback){bytes+=chunk.length;if(bytes>5*1024*1024)return callback(Error('Diagnosebestand is groter dan 5 MB'));chunks.push(Buffer.from(chunk));callback();}});
        const remote=diagnosticRemotePath(directory,fileName);
        await client.downloadTo(sink,remote);
        const content=Buffer.concat(chunks),report=buildDiagnosticReport(chargerId,ticket,content);
        diagnosticFiles.set(chargerId,{fileName,content});
        updateDiagnosticProgress(chargerId,ticket,{phase:'restoring',label:'Oorspronkelijke debug herstellen',percent:94,estimatedCompleteAt:new Date(Date.now()+10_000).toISOString()},{status:'Debuginstelling herstellen'});
        const restored=await restoreDiagnosticDebug(ticket);
        await rememberDiagnosticReport(chargerId,{...report,downloadReady:true,enhancedDebug:!!ticket.enhancedDebug,debugRestoreStatus:ticket.originalDebug?(restored?'Originele debuginstelling hersteld':ticket.debugRestoreStatus):null});
        try{await client.remove(remote);}catch{}
        releaseDiagnosticTicket(ticket);
        return;
      }catch(error){
        const failed=attempts>=diagnosticFtpMaxAttempts;
        if(failed&&ticket.originalDebug){updateDiagnosticProgress(chargerId,ticket,{phase:'restoring',label:'Debug veilig herstellen',percent:94,estimatedCompleteAt:new Date(Date.now()+10_000).toISOString()},{status:'Debuginstelling herstellen na overdrachtsfout'});await restoreDiagnosticDebug(ticket);}
        updateDiagnosticProgress(chargerId,ticket,{phase:failed?'failed':'uploading',label:failed?'Online upload mislukt':'Wachten op diagnosebestand',percent:failed?100:Math.min(84,65+attempts),estimatedCompleteAt:new Date(Date.now()+Math.max(15_000,(diagnosticFtpMaxAttempts-attempts)*diagnosticFtpPollMs)).toISOString()},{status:failed?'Mislukt':'Online upload wordt gevolgd',error:String(error.message||'FTP-fout').replace(diagnosticFtpUrl,'FTP-server'),ftpAttempt:attempts,debugRestoreStatus:ticket.debugRestoreStatus});
        if(failed)releaseDiagnosticTicket(ticket);else setTimeout(run,diagnosticFtpPollMs).unref();
      }finally{client.close();}
    };
    setTimeout(run,Math.min(5000,diagnosticFtpPollMs)).unref();
  };
  const restoreDiagnosticDebug=async ticket=>{if(!ticket?.originalDebug||ticket.debugRestored)return false;ticket.debugRestored=true;try{const result=await fleetCommander(ticket.chargerId,'ChangeConfiguration',{key:'chg_Debug',value:ticket.originalDebug});ticket.debugRestoreStatus=result?.status||'Onbekend';return result?.status==='Accepted';}catch(error){ticket.debugRestoreStatus='Mislukt: '+error.message;return false;}};
  const failDiagnosticTicket=async(ticket,error,label='Diagnose mislukt')=>{if(!ticket||ticket.ending)return false;ticket.ending=true;updateDiagnosticProgress(ticket.chargerId,ticket,{phase:'restoring',label:'Debug veilig herstellen',percent:94,estimatedCompleteAt:new Date(Date.now()+10_000).toISOString()},{status:'Debuginstelling herstellen na diagnosefout'});await restoreDiagnosticDebug(ticket);updateDiagnosticProgress(ticket.chargerId,ticket,{phase:'failed',label,percent:100},{status:'Mislukt',error,debugRestoreStatus:ticket.debugRestoreStatus});releaseDiagnosticTicket(ticket);return true;};
  const scheduleLocalDiagnosticTimeout=ticket=>{setTimeout(()=>{const current=diagnosticReports.get(ticket.chargerId),phase=current?.progress?.phase;if(['complete','failed'].includes(phase)||!diagnosticTokens.has(ticket.token))return;void failDiagnosticTicket(ticket,'Geen diagnosebestand ontvangen via de laptop binnen de veilige wachttijd. Controleer de lokale ontvanger en firewall.','Lokale upload gestopt');},localUploadTimeoutMs).unref();};
  const pythonExe='C:\\Users\\melgh\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
  const friendlyLedError=value=>{
    const message=String(value?.message||value||'').trim();
    if(/PermissionError|Access is denied|EACCES|EPERM/i.test(message))return 'Lampmodule heeft lokaal geen toegang';
    if(/tinytuya|ModuleNotFoundError/i.test(message))return 'Lampmodule is lokaal niet beschikbaar';
    if(/timed out|timeout/i.test(message))return 'Wifi-lamp antwoordt niet';
    return message.split(/\r?\n/).filter(Boolean).at(-1)?.slice(0,180)||'Lampaansturing mislukt';
  };
  const runLed=action=>new Promise((resolve,reject)=>execFile(pythonExe,['lsc-control.py',action],{cwd:new URL('.',import.meta.url),timeout:12000,windowsHide:true},(error,stdout,stderr)=>error?reject(Error((stderr||error.message).trim())):resolve(JSON.parse(stdout))));
  let lastApplied=null;
  async function refreshHardware(){
    try{
      const response=await fetch(`http://127.0.0.1:${relayMonitorPort}/api/state`,{signal:AbortSignal.timeout(1200)});
      if(!response.ok)throw Error('status niet beschikbaar');
      const relay=await response.json(), connector=relay.connectors?.['1']||relay.connectors?.[1];
      charger={...charger,relayReachable:true,chargerConnected:!!relay.chargerConnected,backendConnected:!!relay.backendConnected,status:connector?.status||'Onbekend',errorCode:connector?.errorCode||null,lastSeen:relay.lastSeen||null,lastHeartbeat:relay.lastHeartbeat||null,lastStatusNotification:relay.lastStatusNotification||null,lastMeterValues:relay.lastMeterValues||null,lastMeterForwarded:relay.lastMeterForwarded||null,meterHistoryCount:relay.meterHistoryCount||0,meterHistory:Array.isArray(relay.meterHistory)?relay.meterHistory:[],meterValues:relay.meterValues||null,upstream:relay.upstream||null,connectedAt:relay.connectedAt||null,backendConnectedAt:relay.backendConnectedAt||null,activeTransaction:!!relay.activeTransaction,boot:relay.boot||null,id:relay.id||charger.id,forwarded:relay.forwarded||0,received:relay.received||0,events:Array.isArray(relay.events)?relay.events.slice(0,20):[],relayError:relay.error||null,lastLocalCommand:relay.lastLocalCommand||null,commandHealth:relay.commandHealth||null};
      Object.assign(charger,{connectors:relay.connectors||{},configuration:relay.configuration||[],configurationUpdatedAt:relay.configurationUpdatedAt||null,diagnosticsStatus:relay.diagnosticsStatus||null,diagnosticsStatusAt:relay.diagnosticsStatusAt||null,remoteDiagnostics:relay.remoteDiagnostics||null,transactionId:relay.transactionId??null});
      charger.roundTrips=Array.isArray(relay.roundTrips)?relay.roundTrips:[];charger.connectionStats=relay.connectionStats||null;const fleet=typeof fleetProvider==='function'?fleetProvider():[{...charger}];charger=mergePrimaryFleetState(charger,fleet);charger.fleet=fleet.map(item=>({...item,watchdog:auditStation(item,diagnosticReports.get(item.id))}));
      for(const ticket of diagnosticTokens.values()){const item=fleet.find(row=>row.id===ticket.chargerId),phase=diagnosticReports.get(ticket.chargerId)?.progress?.phase,status=String(item?.diagnosticsStatus||'');if(ticket.localReceiver&&!ticket.ending&&phase==='uploading'&&/UploadFailed/i.test(status)&&Date.parse(item?.diagnosticsStatusAt||0)>=Date.parse(ticket.requestedAt||0))void failDiagnosticTicket(ticket,'De Homebox meldde UploadFailed voor de lokale FTP-overdracht. Controleer poort 2121 en de passieve datapoort 50000.','Lokale FTP-upload mislukt');}
      if(diagnosticFtpUrl)for(const item of fleet){const remote=item.remoteDiagnostics;if(!remote?.fileName||importedRemoteDiagnostics.has(remote.messageId))continue;importedRemoteDiagnostics.add(remote.messageId);const remoteHost=String(remote.locationHost||'').toLowerCase(),sameDestination=!!remoteHost&&remoteHost===diagnosticFtpHost;const ticket={chargerId:item.id,requestedAt:remote.requestedAt||new Date().toISOString(),source:'Robo Charge',destination:sameDestination?diagnosticDestination:`Externe FTP (${remoteHost||'onbekend'})`,locationHost:remoteHost||null,expiresAt:Date.now()+15*60_000,fileName:remote.fileName};diagnosticReports.set(item.id,{...ticket,status:sameDestination?'FTP-upload wordt gevolgd':'Bestand bij externe FTP',transport:'FTP',error:sameDestination?null:'De backoffice heeft de Homebox naar een andere FTP gestuurd; LaadFix heeft dat bestand niet ontvangen.'});if(sameDestination)scheduleFtpDiagnosticDownload(item.id,ticket);}
      for(const item of fleet){if(!item.chargerConnected||!item.connectionDiagnostics?.bootAccepted){watchdogRequested.delete(item.id);continue;}if(watchdogRequested.has(item.id)||deferBackgroundReadings(item.id))continue;watchdogRequested.add(item.id);setTimeout(async()=>{const current=(typeof fleetProvider==='function'?fleetProvider():[charger]).find(row=>row.id===item.id);if(!current?.chargerConnected||current.connectedAt!==item.connectedAt||!current.connectionDiagnostics?.bootAccepted)return;const deferred=()=>{if(!deferBackgroundReadings(item.id))return false;watchdogRequested.delete(item.id);return true;};if(deferred())return;const command=(action,payload)=>typeof fleetCommander==='function'?fleetCommander(item.id,action,payload):relayCommand(action,payload);let status;try{status=await command('TriggerMessage',{requestedMessage:'StatusNotification',connectorId:1});}catch{return;}if(status?.status!=='Accepted'||deferred())return;try{await command('GetConfiguration',{});}catch{}if(deferred())return;try{await command('TriggerMessage',{requestedMessage:'MeterValues',connectorId:1});}catch{}},20000).unref();}
    }catch{charger={...charger,relayReachable:false,chargerConnected:false,backendConnected:false,status:'Offline',relayError:'Lokale OCPP-tussenserver niet bereikbaar'};}
    charger.simulatedStatus=statusSimulation;
    charger.effectiveStatus=statusSimulation||charger.status;
    const sampleNow=Date.now();connectionSamples.push({time:sampleNow,chargerConnected:charger.chargerConnected,backendConnected:charger.backendConnected,messageAgeMs:charger.lastSeen?Math.max(0,sampleNow-Date.parse(charger.lastSeen)):Infinity});connectionSamples=connectionSamples.filter(row=>sampleNow-row.time<30*60_000).slice(-900);
    powerRecovery=recoveryMonitor.observe(charger);
    const colour=colourForStatus(charger.effectiveStatus,charger.chargerConnected,charger.backendConnected);
    led.desiredColour=colour;
    if(led.configured&&led.automatic&&!led.busy&&lastApplied!==colour){
      led.busy=true;try{await runLed(colour);lastApplied=colour;led.lastAction=new Date().toISOString();led.error=null;}catch(e){led.error=friendlyLedError(e);}finally{led.busy=false;}
    }
  }
  async function relayCommand(action,payload){
    const response=await fetch(`http://127.0.0.1:${relayMonitorPort}/api/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload}),signal:AbortSignal.timeout(['GetConfiguration','GetDiagnostics'].includes(action)?125000:95000)});
    const value=await response.json();if(!response.ok)throw Error(value.error||'OCPP-opdracht mislukt');return value.result;
  }
  async function changeProxyRoute(upstream){
    const response=await fetch(`http://127.0.0.1:${relayMonitorPort}/api/routing`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upstream}),signal:AbortSignal.timeout(5000)});const value=await response.json();if(!response.ok)throw Error(value.error||'Proxyroute wijzigen mislukt');return value;
  }
  async function applyLimit(amps){
    const requested=Math.round(Number(amps)*10)/10;
    const limit=requested<=0?0:Math.max(6,Math.min(32,requested));
    const result=await relayCommand('SetChargingProfile',{connectorId:1,csChargingProfiles:{chargingProfileId:900001,stackLevel:20,chargingProfilePurpose:'TxDefaultProfile',chargingProfileKind:'Absolute',chargingSchedule:{chargingRateUnit:'A',chargingSchedulePeriod:[{startPeriod:0,limit}]}}});
    lastSentLimit=limit;lastControlResult=result;lastControlError=null;return result;
  }
  const timer = setInterval(()=>state=engine.tick(),1000); timer.unref();
  const controlTimer=hardware?setInterval(async()=>{if(!liveControl||busy||!charger.chargerConnected)return;const target=state.result.actualA||0;if(lastSentLimit===target)return;busy=true;try{const result=await applyLimit(target);if(result?.status!=='Accepted')throw Error('Homebox antwoordt '+(result?.status||'onbekend'));}catch(e){lastControlError=e.message;liveControl=false;}finally{busy=false;}},5000):null;controlTimer?.unref();
  const hardwareTimer=hardware?setInterval(refreshHardware,2000):null;hardwareTimer?.unref();if(hardware)refreshHardware();
  const meterTimer=hardware?setInterval(async()=>{const meter=extractMeterReadings(charger.meterValues,charger.lastMeterValues);if(deferBackgroundReadings(charger.id)||!charger.chargerConnected||!charger.backendConnected||!meter.stale||Date.now()-lastMeterRequest<60000)return;lastMeterRequest=Date.now();try{meterRequestResult=await relayCommand('TriggerMessage',{requestedMessage:'MeterValues',connectorId:1});}catch(e){meterRequestResult={error:e.message};}},meterPollIntervalMs):null;meterTimer?.unref();
  const files = new Map([['/',['ems.html','text/html; charset=utf-8']],['/app.mjs',['app.mjs','text/javascript; charset=utf-8']],['/configuration-help.mjs',['configuration-help.mjs','text/javascript; charset=utf-8']],['/dashboard.css',['dashboard.css','text/css; charset=utf-8']],['/recovery-ui.mjs',['recovery-ui.mjs','text/javascript; charset=utf-8']],['/recovery.css',['recovery.css','text/css; charset=utf-8']],['/laadfix-receiver-windows.zip',['laadfix-receiver-windows.zip','application/zip']]]);
  const sessionToken=authUser?createHash('sha256').update(`${authUser}\0${authPassword}\0laadfix-ems-session`).digest('hex'):null;
  const same=(left,right)=>{const a=Buffer.from(String(left)),b=Buffer.from(String(right));return a.length===b.length&&timingSafeEqual(a,b);};
  const loginHtml=`<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LaadFix EMS · Inloggen</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui;background:radial-gradient(circle at 20% 10%,#dff8ee 0,transparent 38%),linear-gradient(145deg,#f7fbf8,#e8f1ed);color:#16392d}.card{width:min(420px,calc(100% - 32px));padding:34px;border:1px solid #cce0d6;border-radius:24px;background:rgba(255,255,255,.92);box-shadow:0 28px 70px #174c3628}small{color:#2b7658;font-weight:800;letter-spacing:.16em}h1{margin:10px 0 8px;font-size:30px}p{margin:0 0 24px;color:#587068}label{display:block;margin:14px 0 6px;font-weight:700}input{width:100%;padding:13px 14px;border:1px solid #b8cec3;border-radius:12px;font:inherit;background:#fbfdfc}button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;background:linear-gradient(135deg,#08734c,#19a46f);color:white;font:700 16px system-ui;box-shadow:0 12px 25px #08734c38;cursor:pointer}.error{padding:10px 12px;border-radius:10px;background:#fff0ee;color:#a12c24;margin-bottom:14px}</style><main class="card"><small>LAADFIX LAB</small><h1>EMS Serviceconsole</h1><p>Log in om laadpalen, meterwaarden en verbindingen te bekijken.</p>{{ERROR}}<form method="post" action="/login"><label for="user">Gebruikersnaam</label><input id="user" name="user" autocomplete="username" required autofocus><label for="password">Wachtwoord</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Dashboard openen</button></form></main></html>`;
  const server = http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'");
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    const allowedHosts=['127.0.0.1:'+server.address().port,'localhost:'+server.address().port];if(publicName)allowedHosts.push(publicName);
    if (!allowedHosts.includes(req.headers.host)) return send(403,{error:'Onbekende host'});
    const requestPath=new URL(req.url,'http://localhost').pathname;
    if(requestPath.startsWith('/api/diagnostics-upload/')){
      if(!['PUT','POST'].includes(req.method)){res.writeHead(405,{'Allow':'PUT, POST'});res.end();return;}
      const parts=requestPath.slice('/api/diagnostics-upload/'.length).split('/'),token=parts.shift()||'';let chargerId='';try{chargerId=decodeURIComponent(parts.join('/'));}catch{return send(400,{error:'Ongeldig laadstation-ID'});}
      const ticket=diagnosticTokens.get(token);if(!ticket||ticket.chargerId!==chargerId||ticket.expiresAt<Date.now())return send(403,{error:'Uploadadres is ongeldig of verlopen'});
      try{const chunks=[];let bytes=0;updateDiagnosticProgress(chargerId,ticket,{phase:'receiving',label:'Bestand ontvangen',percent:78,estimatedCompleteAt:new Date(Date.now()+20_000).toISOString()},{status:'Bestand ontvangen · analyseren'});for await(const chunk of req){bytes+=chunk.length;if(bytes>5*1024*1024)throw Error('Diagnosebestand is groter dan 5 MB');chunks.push(chunk);}updateDiagnosticProgress(chargerId,ticket,{phase:'analyzing',label:'Log analyseren',percent:88,estimatedCompleteAt:new Date(Date.now()+12_000).toISOString()},{status:'Log analyseren'});const content=Buffer.concat(chunks);diagnosticFiles.set(chargerId,{fileName:ticket.fileName||`diagnose-${Date.now()}.xls`,content,receivedAt:new Date().toISOString()});const report=buildDiagnosticReport(chargerId,ticket,content);updateDiagnosticProgress(chargerId,ticket,{phase:'restoring',label:'Oorspronkelijke debug herstellen',percent:94,estimatedCompleteAt:new Date(Date.now()+10_000).toISOString()},{status:'Debuginstelling herstellen'});const restored=await restoreDiagnosticDebug(ticket);await rememberDiagnosticReport(chargerId,{...report,downloadReady:true,enhancedDebug:!!ticket.enhancedDebug,debugRestoreStatus:ticket.originalDebug?(restored?'Originele debuginstelling hersteld':ticket.debugRestoreStatus):null});releaseDiagnosticTicket(ticket);res.writeHead(201,{'Content-Type':'text/plain; charset=utf-8'});res.end('Diagnosebestand ontvangen');return;}catch(e){updateDiagnosticProgress(chargerId,ticket,{phase:'restoring',label:'Debug veilig herstellen',percent:94},{status:'Debuginstelling herstellen na ontvangstfout'});await restoreDiagnosticDebug(ticket);updateDiagnosticProgress(chargerId,ticket,{phase:'failed',label:'Diagnose mislukt',percent:100},{status:'Mislukt',error:e.message,debugRestoreStatus:ticket.debugRestoreStatus});releaseDiagnosticTicket(ticket);return send(400,{error:e.message});}
    }
    if(['GET','HEAD'].includes(req.method)&&requestPath.startsWith('/render-source.git/')){
      const relative=decodeURIComponent(requestPath.slice('/render-source.git/'.length));
      if(!relative||relative.includes('..')||relative.includes('\\')||!/^[A-Za-z0-9._\/-]+$/.test(relative)){res.writeHead(404);res.end();return;}
      const fileUrl=new URL(`render-source.git/${relative}`,import.meta.url);
      if(!existsSync(fileUrl)){res.writeHead(404);res.end();return;}
      const content=readFileSync(fileUrl);res.writeHead(200,{'Content-Type':relative==='info/refs'?'text/plain; charset=utf-8':'application/octet-stream','Content-Length':content.length,'Cache-Control':'no-store'});if(req.method==='HEAD')res.end();else res.end(content);return;
    }
    if(authUser){
      const basic=req.headers.authorization||'',expected='Basic '+Buffer.from(authUser+':'+authPassword).toString('base64');
      const cookie=Object.fromEntries((req.headers.cookie||'').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2));
      const loggedIn=same(basic,expected)||same(cookie.laadfix_session||'',sessionToken);
      if(req.method==='GET'&&req.url==='/login'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(loginHtml.replace('{{ERROR}}',''));return;}
      if(req.method==='POST'&&req.url==='/login'){
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096){res.writeHead(413);res.end();return;}}
        const form=new URLSearchParams(raw),valid=same(form.get('user')||'',authUser)&&same(form.get('password')||'',authPassword);
        if(valid){res.writeHead(303,{'Location':'/','Set-Cookie':`laadfix_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`});res.end();return;}
        res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'});res.end(loginHtml.replace('{{ERROR}}','<div class="error">Gebruikersnaam of wachtwoord klopt niet.</div>'));return;
      }
      if(req.method==='GET'&&req.url==='/logout'){res.writeHead(303,{'Location':'/login','Set-Cookie':'laadfix_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});res.end();return;}
      if(!loggedIn){if(req.url?.startsWith('/api/'))return send(401,{error:'Inloggen vereist'});res.writeHead(303,{'Location':'/login'});res.end();return;}
    }
    if(req.method==='GET'&&req.url==='/api/state')return send(200,{...state,simulationFleet:simulatedFleet(state.settings,state.result),diagnostic,diagnosticTransport:{online:!!diagnosticFtpUrl,destination:diagnosticDestination},charger,recovery:{...recoveryCenter.snapshot(),...recoveryCases.snapshot(),stations:recoveryStations().map(item=>({id:item.id,chargerConnected:item.chargerConnected,backendConnected:item.backendConnected,status:item.status,connectors:item.connectors||{},connectorIds:connectorIds(item),blockedReason:recoveryGuard(item),lastSeen:item.lastSeen}))},meter:{...extractMeterReadings(charger.meterValues,charger.lastMeterValues),forwardedAt:charger.lastMeterForwarded||null,historyCount:charger.meterHistoryCount||0,lastRequest:lastMeterRequest?new Date(lastMeterRequest).toISOString():null,requestResult:meterRequestResult},led,service:assessService(charger),intelligence:connectionIntelligence(charger,connectionSamples),logAnalysis,diagnostics:Object.fromEntries(diagnosticReports),diagnosticHistory:Object.fromEntries(diagnosticHistories),powerRecovery:powerRecovery||recoveryMonitor.snapshot(charger),serviceResult,networkResult,control:{liveControl,lastSentLimit,lastControlError,lastControlResult,capabilities}});
    if(req.method==='GET'&&requestPath.startsWith('/api/diagnostics-download/')){let chargerId='';try{chargerId=decodeURIComponent(requestPath.slice('/api/diagnostics-download/'.length));}catch{return send(400,{error:'Ongeldig laadstation-ID'});}const file=diagnosticFiles.get(chargerId);if(!file)return send(404,{error:'Het ruwe bestand is na deze serverstart nog niet beschikbaar'});const safeName=String(file.fileName||'diagnose.xls').replace(/[^A-Za-z0-9._-]/g,'_');res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.content.length,'Content-Disposition':`attachment; filename="${safeName}"`});res.end(file.content);return;}
    if(req.method==='GET'&&req.url==='/api/support-bundle'){
      const bundle={createdAt:new Date().toISOString(),application:'Ecotap serviceconsole',service:assessService(charger),intelligence:connectionIntelligence(charger,connectionSamples),logAnalysis,diagnostics:Object.fromEntries(diagnosticReports),powerRecovery:powerRecovery||recoveryMonitor.snapshot(charger),network:networkResult,charger:{...charger,events:charger.events?.slice(0,60)},ems:{settings:state.settings,result:state.result},control:{liveControl,lastSentLimit,lastControlError,lastControlResult,capabilities},serviceResult};
      res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':`attachment; filename="ecotap-diagnose-${Date.now()}.json"`});res.end(JSON.stringify(bundle,null,2));return;
    }
    if(req.method==='POST'&&requestPath==='/api/diagnostics-manual'){
      const origins=['http://127.0.0.1:'+server.address().port,'http://localhost:'+server.address().port];if(publicName)origins.push('https://'+publicName);
      if(!origins.includes(req.headers.origin))return send(403,{error:'Ongeldige aanvraag'});
      const chargerId=String(req.headers['x-charger-id']||''),encodedName=String(req.headers['x-file-name']||'');let fileName='';
      try{fileName=decodeURIComponent(encodedName);}catch{return send(400,{error:'Ongeldige bestandsnaam'});}
      if(!recoveryStations().some(item=>item.id===chargerId))return send(400,{error:'Onbekend laadstation'});
      if(!/^[A-Za-z0-9._-]{1,180}\.(?:xls|log|txt)$/i.test(fileName))return send(400,{error:'Kies een .xls-, .log- of .txt-bestand'});
      try{const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>5*1024*1024)throw Error('Diagnosebestand is groter dan 5 MB');chunks.push(chunk);}const ticket={chargerId,requestedAt:new Date().toISOString(),source:'Handmatige browserupload',destination:'LaadFix online analyse',locationHost:publicName,expiresAt:Date.now()+15*60_000,fileName},content=Buffer.concat(chunks);diagnosticFiles.set(chargerId,{fileName,content,receivedAt:new Date().toISOString()});const report={...buildDiagnosticReport(chargerId,ticket,content),downloadReady:true};await rememberDiagnosticReport(chargerId,report);return send(201,{report});}catch(e){return send(400,{error:e.message});}
    }
    if(req.method==='GET'&&files.has(req.url)){const [file,type]=files.get(req.url);res.writeHead(200,{'Content-Type':type});res.end(readFileSync(new URL(file,import.meta.url)));return;}
    if(req.method!=='POST')return send(404,{error:'Niet gevonden'});
    const allowedOrigins=['http://127.0.0.1:'+server.address().port,'http://localhost:'+server.address().port];if(publicName)allowedOrigins.push('https://'+publicName);
    if(!allowedOrigins.includes(req.headers.origin) || req.headers['content-type']!=='application/json')return send(403,{error:'Ongeldige aanvraag'});
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>260000)throw Error('Aanvraag te groot');}
      const body=JSON.parse(raw);
      if(req.url==='/api/recovery-case/open'){
        if(busy)return send(429,{error:'Er loopt al een opdracht. Wacht op de uitkomst.'});
        const opened=recoveryCases.open({stationId:String(body.id||charger.id),connectorId:Number(body.connectorId??1),maxDurationMinutes:Number(body.maxDurationMinutes??15)});
        busy=true;opened.done.finally(()=>{busy=false;});return send(202,{case:opened.case});
      }
      if(req.url==='/api/recovery-case/close'){
        const result=await recoveryCases.close(String(body.caseId||''));return send(200,{case:result});
      }
      if(req.url==='/api/recovery'||req.url==='/api/smart-recovery'){
        if(busy)return send(429,{error:'Er loopt al een opdracht. Wacht op de uitkomst.'});
        const stationId=String(body.id||charger.id),connectorId=Number(body.connectorId??1),action=req.url==='/api/smart-recovery'?'analyze':String(body.action||'');
        const {job,done}=recoveryCenter.start({stationId,connectorId,action});busy=true;done.finally(()=>{busy=false;});
        return send(202,{job});
      }
      if(req.url==='/api/analyze-log'){logAnalysis=analyzeControllerLog(body.log);return send(200,{logAnalysis});}
      if(req.url==='/api/diagnostics-ftp-test')return send(200,await testDiagnosticFtp(diagnosticFtpUrl));
      if(req.url==='/api/diagnostics-import'){
        if(!diagnosticFtpUrl)throw Error('Er is geen diagnose-FTP ingesteld');
        const chargerId=String(body.id||''),fileName=String(body.fileName||'').trim();
        if(!recoveryStations().some(item=>item.id===chargerId))throw Error('Onbekend laadstation');
        if(!/^[A-Za-z0-9._-]{1,180}$/.test(fileName)||!fileName.startsWith(chargerId+'-diag-'))throw Error('Bestandsnaam hoort niet bij dit laadstation');
        const ticket={chargerId,requestedAt:new Date().toISOString(),source:'Handmatige bestandsnaam',destination:diagnosticDestination,locationHost:diagnosticFtpHost,expiresAt:Date.now()+15*60_000,fileName};
        diagnosticReports.set(chargerId,{...ticket,status:'FTP-bestand wordt gezocht',transport:'FTP'});
        scheduleFtpDiagnosticDownload(chargerId,ticket);return send(202,{status:'FTP-bestand wordt gezocht',fileName});
      }
      if(req.url==='/api/fleet-routing'){
        if(typeof fleetRouteChanger!=='function')throw Error('Vlootroutering is alleen online beschikbaar');
        const result=await fleetRouteChanger(String(body.id||''),String(body.upstream||''));
        await refreshHardware();return send(200,{result,fleet:charger.fleet});
      }
      if(req.url==='/api/fleet-command'){
        if(typeof fleetCommander!=='function')throw Error('Vlootbediening is alleen online beschikbaar');
        if(busy)return send(429,{error:'Er loopt al een opdracht'});
        const chargerId=String(body.id||'');let item=(typeof fleetProvider==='function'?fleetProvider():[]).find(row=>row.id===chargerId);
        if(!item?.chargerConnected)throw Error('Laadstation is niet via OCPP verbonden');
        let active=!!item.activeTransaction||['Charging','Preparing','Finishing'].includes(item.status);
        const action=String(body.action||'');
        const configKey=String(body.key||'');
        const configValue=String(body.value??'');
        if(action==='changeConfiguration'&&!/^[A-Za-z0-9_.:-]{1,100}$/.test(configKey))throw Error('Ongeldige configuratiesleutel');
        if(action==='changeConfiguration'&&configValue.length>1000)throw Error('Configuratiewaarde is te lang');
        const requestedKeys=Array.isArray(body.keys)?body.keys.map(String).filter(key=>/^[A-Za-z0-9_.:-]{1,100}$/.test(key)).slice(0,100):null;
        let diagnosticToken=null,diagnosticLocation=null;
        if(action==='diagnostics'){
          const activeTicket=[...diagnosticTokens.values()].find(ticket=>ticket.chargerId===chargerId&&ticket.expiresAt>Date.now()),activeDiagnostic=diagnosticReports.get(chargerId),activePhase=activeDiagnostic?.progress?.phase;
          if(activeTicket&&activePhase&&!['complete','failed'].includes(activePhase))return send(409,{error:`Er loopt al een diagnose (${activeDiagnostic.progress.label||activePhase}). Wacht tot deze klaar is.`});
          if(!publicName&&!diagnosticFtpUrl)throw Error('Voor diagnose-upload is een eigen LaadFix-opslag nodig');
          diagnosticToken=randomBytes(24).toString('hex');
          const localReceiverIp=String(body.localReceiverIp||'').trim(),localReceiverPort=Number(body.localReceiverPort||2121),localReceiver=!!localReceiverIp;
          if(localReceiver&&(!privateIPv4(localReceiverIp)||!Number.isInteger(localReceiverPort)||localReceiverPort<1024||localReceiverPort>65535))throw Error('Ongeldige lokale diagnose-ontvanger');
          diagnosticLocation=localReceiver?`ftp://${diagnosticToken}:${encodeURIComponent(chargerId)}@${localReceiverIp}:${localReceiverPort}/`:diagnosticFtpUrl||`https://${publicName}/api/diagnostics-upload/${diagnosticToken}/${encodeURIComponent(chargerId)}`;
          const variant=String(body.ftpVariant||'default');
          if(variant!=='default'&&!localReceiver)diagnosticLocation=await diagnosticLocationForRequest(diagnosticFtpUrl,variant);
          const durationSeconds=body.allTime===true?null:Number(body.durationSeconds??Number(body.minutes??5)*60);
          if(durationSeconds!==null&&(!Number.isInteger(durationSeconds)||durationSeconds<30||durationSeconds>300))throw Error('Kies een diagnoseduur van 30 seconden, 1 minuut of 5 minuten');
          if(Array.isArray(body.debugModules)&&(body.debugModules.length<1||body.debugModules.length>DIAGNOSTIC_DEBUG_KEYS.size||body.debugModules.some(value=>!DIAGNOSTIC_DEBUG_KEYS.has(String(value).toLowerCase()))))throw Error('Kies minimaal één geldige diagnosecategorie');
          const minutes=durationSeconds===null?null:durationSeconds/60;
          const requestedAt=ocppDateTime(Date.now()),stopTime=durationSeconds===null?undefined:requestedAt,startTime=durationSeconds===null?undefined:ocppDateTime(Date.now()-durationSeconds*1000),ticket={token:diagnosticToken,chargerId,requestedAt,startTime,stopTime,minutes,durationSeconds,ftpVariant:variant,quietDiagnostics:body.quietDiagnostics===true,quickMode:body.enhancedDebug===false||body.quickMode===true,source:'LaadFix',destination:localReceiver?`Lokale ontvanger (${localReceiverIp})`:diagnosticDestination,locationHost:localReceiverIp||diagnosticFtpHost||publicName,localReceiver,expiresAt:Date.now()+15*60_000,fileName:null,transferEstimateMs:diagnosticTransferEstimateMs(chargerId)};diagnosticTokens.set(diagnosticToken,ticket);updateDiagnosticProgress(chargerId,ticket,{phase:'preparing',label:'Diagnose voorbereiden',percent:4,estimatedCompleteAt:new Date(Date.now()+(durationSeconds||300)*1000+ticket.transferEstimateMs+20_000).toISOString()},{status:'Diagnose voorbereiden',locationReady:true,controllerStatus:item.diagnosticsStatus||null});
        }
        if(action==='diagnostics'&&body.enhancedDebug!==false){
          const ticket=diagnosticTokens.get(diagnosticToken);
          try{
          if(body.freshStart===true){
            if(active)throw Error('Frisse diagnose kan niet starten tijdens laden');
            const sessionBefore=Number(item.connectionDiagnostics?.sessionId||0);
            updateDiagnosticProgress(chargerId,ticket,{phase:'restarting',label:'Controller opnieuw verbinden',percent:8,estimatedCompleteAt:new Date(Date.now()+120_000).toISOString()},{status:'Controller herstarten voor frisse diagnose',transport:ticket.localReceiver?'Lokale FTP + HTTPS':'LaadFix FTP'});
            const reset=await fleetCommander(chargerId,'Reset',{type:'Soft'});
            if(reset?.status==='Accepted'){
              let reconnected=false;
              for(let second=0;second<90;second++){await new Promise(resolve=>setTimeout(resolve,1000));item=(typeof fleetProvider==='function'?fleetProvider():[]).find(row=>row.id===chargerId);if(item?.chargerConnected&&Number(item.connectionDiagnostics?.sessionId||0)>sessionBefore){reconnected=true;break;}}
              if(!reconnected)throw Error('Homebox kwam niet binnen 90 seconden terug na de soft reset');
              active=!!item.activeTransaction||['Charging','Preparing','Finishing'].includes(item.status);ticket.freshStart=true;
            }else{
              ticket.freshStart=false;ticket.sessionNote=`Soft reset ${reset?.status||'niet bevestigd'}; diagnose gaat veilig door met een exact nieuw tijdvak`;
            }
          }
          updateDiagnosticProgress(chargerId,ticket,{phase:'configuration',label:'Actuele configuratie lezen',percent:14,estimatedCompleteAt:new Date(Date.now()+(ticket.durationSeconds||300)*1000+130_000).toISOString()},{status:ticket.sessionNote||'Actuele configuratie lezen'});
          let read=await fleetCommander(chargerId,'GetConfiguration',{}),rows=read?.configurationKey||read?.result?.configurationKey||[],originalDebug=rows.find(row=>row.key==='chg_Debug')?.value;
          if(!originalDebug){read=await fleetCommander(chargerId,'GetConfiguration',{key:['chg_Debug']});rows=read?.configurationKey||read?.result?.configurationKey||[];originalDebug=rows.find(row=>row.key==='chg_Debug')?.value;}
          if(!originalDebug)throw Error('Huidige debuginstelling kon niet veilig worden bewaard');
          ticket.meterSettings=rows.filter(row=>/^chg_KWH[12]$/i.test(row.key)).map(row=>({key:row.key,value:row.value}));ticket.freshStart=ticket.freshStart===true;
          updateDiagnosticProgress(chargerId,ticket,{phase:'debugging',label:'Gekozen debugmodules verhogen',percent:18,estimatedCompleteAt:new Date(Date.now()+(ticket.durationSeconds||300)*1000+120_000).toISOString()},{status:'Gekozen debug tijdelijk verhogen'});
          const selectedDebugModules=Array.isArray(body.debugModules)?body.debugModules:[],maximumDebug=selectedDebugModules.length?selectDiagnosticDebug(selectedDebugModules):maximizeDiagnosticDebug(originalDebug);ticket.originalDebug=originalDebug;ticket.maximumDebug=maximumDebug;ticket.debugModules=selectedDebugModules;
          let changed;try{changed=await fleetCommander(chargerId,'ChangeConfiguration',{key:'chg_Debug',value:maximumDebug});}catch(error){await restoreDiagnosticDebug(ticket);throw error;}
          if(changed?.status!=='Accepted'){await restoreDiagnosticDebug(ticket);throw Error('Tijdelijk verhogen van debugniveau is niet geaccepteerd');}
          ticket.enhancedDebug=true;ticket.captureStartedAt=new Date().toISOString();
          const captureMs=diagnosticCaptureMs===null?Math.max(30_000,ticket.durationSeconds??300_000):Math.max(1,Number(diagnosticCaptureMs));
          const captureStartedAt=Date.now();updateDiagnosticProgress(chargerId,ticket,{phase:'capturing',label:'Gerichte logging verzamelen',percent:20,phaseStartedAt:new Date(captureStartedAt).toISOString(),phaseEndsAt:new Date(captureStartedAt+captureMs).toISOString(),estimatedCompleteAt:new Date(captureStartedAt+captureMs+(ticket.transferEstimateMs||100_000)+20_000).toISOString()},{status:'Gerichte logging verzamelen',transport:ticket.localReceiver?'Lokale FTP + HTTPS':'LaadFix FTP',debugRestoreStatus:'Wordt na ontvangst automatisch hersteld'});
          setTimeout(async()=>{try{updateDiagnosticProgress(chargerId,ticket,{phase:'requesting',label:'Diagnosebestand opvragen',percent:55,estimatedCompleteAt:new Date(Date.now()+(ticket.transferEstimateMs||100_000)+15_000).toISOString()},{status:'Diagnosebestand opvragen'});const requestedAt=ocppDateTime(Date.now()),startTime=ocppDateTime(Date.now()-captureMs);ticket.requestedAt=requestedAt;ticket.startTime=startTime;ticket.stopTime=requestedAt;const result=await fleetCommander(chargerId,'GetDiagnostics',{location:diagnosticLocation,retries:2,retryInterval:60,startTime,stopTime:requestedAt});ticket.fileName=result?.fileName||null;updateDiagnosticProgress(chargerId,ticket,{phase:ticket.fileName?'uploading':'failed',label:ticket.fileName?'Homebox verstuurt het bestand':'Geen bestand ontvangen',percent:ticket.fileName?65:100,phaseStartedAt:new Date().toISOString(),estimatedCompleteAt:new Date(Date.now()+(ticket.transferEstimateMs||100_000)).toISOString()},{status:ticket.fileName?(ticket.localReceiver?'Lokale upload wordt gevolgd':'Online upload wordt gevolgd'):'Mislukt',fileName:ticket.fileName,controllerResponse:result});if(ticket.fileName&&!ticket.localReceiver)scheduleFtpDiagnosticDownload(chargerId,ticket);if(ticket.fileName&&ticket.localReceiver)scheduleLocalDiagnosticTimeout(ticket);if(!ticket.fileName){updateDiagnosticProgress(chargerId,ticket,{phase:'restoring',label:'Oorspronkelijke debug herstellen',percent:94});await restoreDiagnosticDebug(ticket);updateDiagnosticProgress(chargerId,ticket,{phase:'failed',label:'Geen diagnosebestand ontvangen',percent:100},{status:'Mislukt',debugRestoreStatus:ticket.debugRestoreStatus});releaseDiagnosticTicket(ticket);}}catch(error){updateDiagnosticProgress(chargerId,ticket,{phase:'restoring',label:'Debug veilig herstellen',percent:94},{status:'Debuginstelling herstellen na diagnosefout'});await restoreDiagnosticDebug(ticket);updateDiagnosticProgress(chargerId,ticket,{phase:'failed',label:'Diagnose mislukt',percent:100},{status:'Mislukt',error:error.message,debugRestoreStatus:ticket.debugRestoreStatus});releaseDiagnosticTicket(ticket);}},captureMs).unref();
          setTimeout(()=>restoreDiagnosticDebug(ticket),12*60_000).unref();
          const durationLabel=ticket.durationSeconds<60?`${ticket.durationSeconds} seconden`:ticket.durationSeconds===60?'1 minuut':`${ticket.durationSeconds/60} minuten`;
          return send(202,{serviceResult:{status:'Gerichte logging gestart',steps:[ticket.sessionNote|| (ticket.freshStart?'Nieuwe controllersessie gestart':'Bestaande controllersessie gebruikt'),`Volledige actuele configuratie gelezen`,`Originele chg_Debug veilig bewaard`,`Gekozen modules tijdelijk op niveau 7`,`Diagnose wordt over ${durationLabel} automatisch opgevraagd`],advice:'Na ontvangst of uiterlijk na twaalf minuten wordt de oorspronkelijke debuginstelling automatisch teruggezet.'}});
          }catch(error){await restoreDiagnosticDebug(ticket);releaseDiagnosticTicket(ticket);const current=diagnosticReports.get(chargerId);diagnosticReports.set(chargerId,{...current,status:'Mislukt',error:error.message,debugRestoreStatus:ticket.debugRestoreStatus,progress:{...current?.progress,phase:'failed',label:'Diagnose niet gestart',percent:100}});throw error;}
        }
        const commands={
          status:['TriggerMessage',{requestedMessage:'StatusNotification',connectorId:1}],
          meterValues:['TriggerMessage',{requestedMessage:'MeterValues',connectorId:1}],
          configuration:['GetConfiguration',{key:['HeartbeatInterval','ConnectionTimeOut','MeterValueSampleInterval','ClockAlignedDataInterval','SupportedFeatureProfiles']}],
          softReset:['Reset',{type:'Soft'}],hardReset:['Reset',{type:'Hard'}],
          unlock:['UnlockConnector',{connectorId:1}],operative:['ChangeAvailability',{connectorId:1,type:'Operative'}],
          inoperative:['ChangeAvailability',{connectorId:1,type:'Inoperative'}],clearCache:['ClearCache',{}],
          clearProfile:['ClearChargingProfile',{connectorId:1,chargingProfilePurpose:'TxDefaultProfile'}],
          remoteStart:['RemoteStartTransaction',{connectorId:1,idTag:String(body.idTag||'LAADFIX').slice(0,20)}],
          remoteStop:['RemoteStopTransaction',{transactionId:Number(body.transactionId??item.transactionId)}],
          backendReconnect:['reconnectBackend',{}],
          getConfiguration:['GetConfiguration',requestedKeys?.length?{key:requestedKeys}:{}],
          changeConfiguration:['ChangeConfiguration',{key:configKey,value:configValue}],
          meterIdentification:['DataTransfer',{vendorId:'Ecotap',messageId:'GetMeterInfo',data:'{}'}],
          diagnostics:['GetDiagnostics',{location:diagnosticLocation,retries:2,retryInterval:60,startTime:diagnosticTokens.get(diagnosticToken)?.startTime,stopTime:diagnosticTokens.get(diagnosticToken)?.stopTime}]
        };
        if(!commands[action])throw Error('Onbekende remote actie');
        if(active&&['softReset','hardReset','unlock','operative','inoperative','clearCache','clearProfile','remoteStart','backendReconnect'].includes(action))throw Error('Actie geblokkeerd tijdens een actieve of startende laadsessie');
        if(action==='remoteStart'&&active)throw Error('Er loopt al een laadsessie');
        if(action==='remoteStop'&&!Number.isInteger(commands[action][1].transactionId))throw Error('Geen actief transactie-ID beschikbaar');
        busy=true;try{if(action==='diagnostics'&&!item.configuration?.some(row=>row.key==='chg_KWH1'))try{await fleetCommander(chargerId,'GetConfiguration',{key:['chg_KWH1']});}catch{}const [ocppAction,payload]=commands[action],beforeStatus=item.lastStatusNotification,beforeMeter=item.lastMeterValues,result=await fleetCommander(chargerId,ocppAction,payload);let update=null;
          if(['status','meterValues'].includes(action)&&result?.status==='Accepted'){
            const field=action==='status'?'lastStatusNotification':'lastMeterValues',before=action==='status'?beforeStatus:beforeMeter,deadline=Date.now()+8000;
            while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,500));const latest=(typeof fleetProvider==='function'?fleetProvider():[]).find(row=>row.id===chargerId);if(latest?.[field]&&latest[field]!==before){update=latest;break;}}
          }
          if(action==='diagnostics'){const ticket=diagnosticTokens.get(diagnosticToken);if(ticket)ticket.fileName=result?.fileName||null;const hasFile=!!result?.fileName;diagnosticReports.set(chargerId,{...diagnosticReports.get(chargerId),quickMode:ticket?.quickMode===true,status:hasFile?(ticket?.localReceiver?'Lokale upload wordt gevolgd':diagnosticFtpUrl?'FTP-upload wordt gevolgd':'Upload verwacht'):'Mislukt',fileName:result?.fileName||null,transport:ticket?.localReceiver?'Lokale FTP + HTTPS':diagnosticFtpUrl?'FTP':'HTTPS',controllerResponse:result,progress:{phase:hasFile?'uploading':'failed',label:hasFile?(ticket?.quickMode?'Snelle upload volgen':'Online upload volgen'):'Geen diagnosebestand ontvangen',percent:hasFile?65:100,estimatedCompleteAt:hasFile?new Date(Date.now()+(ticket?.transferEstimateMs||100_000)).toISOString():undefined}});if(diagnosticFtpUrl&&!ticket?.localReceiver&&ticket?.fileName)scheduleFtpDiagnosticDownload(chargerId,ticket);}
          const steps=[`${chargerId}: ${ocppAction}`,`Homebox antwoord: ${result?.status||result?.fileName||'ontvangen'}`];let status='Remote actie verzonden',advice=null;
          if(action==='status'){
            status=update?'Nieuwe status ontvangen':'Verzoek geaccepteerd, geen nieuw statusbericht ontvangen';
            if(update)steps.push(`Connector 1: ${update.status||'Onbekend'}`,`Foutcode: ${update.errorCode||'NoError'}`,`Ontvangen: ${new Date(update.lastStatusNotification).toLocaleString('nl-NL',{timeZone:'Europe/Amsterdam'})}`);
            else advice='De Homebox heeft TriggerMessage aangenomen, maar stuurde binnen 8 seconden geen StatusNotification. De laatst bekende status blijft zichtbaar bovenaan.';
          }
          if(action==='meterValues'){
            status=update?'Nieuwe meterwaarden ontvangen':'Verzoek geaccepteerd, geen nieuwe meterwaarden ontvangen';
            if(update){const row=update.meterHistory?.[0],value=(sample,fallback='niet meegestuurd')=>sample&&Number.isFinite(Number(sample.value))?`${Number(sample.value).toLocaleString('nl-NL',{maximumFractionDigits:3})} ${sample.unit||''}`.trim():fallback;steps.push(`Meting: ${new Date(update.lastMeterValues).toLocaleString('nl-NL',{timeZone:'Europe/Amsterdam'})}`,`Energiestand: ${value(row?.energy)}`,`Spanning L1: ${value(row?.voltageL1)}`,`Stroom L1: ${value(row?.currentL1)}`,`Frequentie: ${value(row?.frequency)}`,`Temperatuur: ${value(row?.temperature)}`,update.lastMeterForwarded?'Doorgestuurd naar Robo Charge':'Nog niet doorgestuurd naar Robo Charge');}
            else advice='Deze Homebox antwoordt buiten een actieve laadsessie mogelijk niet met MeterValues. De laatst opgeslagen meting blijft beschikbaar onder Meterwaarden.';
          }
          if(action==='meterIdentification'){
            const outcome=result?.status||'Geen status';status='Meteridentificatieproef: '+outcome;steps.push('Vendor: Ecotap','Opdracht: GetMeterInfo','Antwoorddata: '+(result?.data??'niet meegestuurd'));
            advice=outcome==='Accepted'?'De controller herkent de opdracht. Controleer de antwoorddata op model, meter code en serienummer.':outcome==='UnknownMessageId'?'Ecotap wordt herkend, maar GetMeterInfo is geen bekende opdrachtnaam voor deze firmware.':'Deze firmware ondersteunt deze Ecotap-uitleesproef niet met de gebruikte vendor-identificatie.';
          }
          if(!['status','meterValues'].includes(action)){
            const accepted=result?.status==='Accepted',descriptions={
              softReset:[accepted?'Soft reset geaccepteerd':'Soft reset niet geaccepteerd','De laadsoftware wordt opnieuw gestart. De OCPP-verbinding kan kort verdwijnen.','Controleer of Homebox en backend binnen enkele minuten weer verbonden zijn.'],
              hardReset:[accepted?'Harde reset geaccepteerd':result?.status==='Rejected'?'Harde reset verstuurd · herstart controleren':'Harde reset niet geaccepteerd',result?.status==='Rejected'?'Deze Ecotap-firmware kan Rejected antwoorden en de controller toch herstarten. De echte uitkomst wordt bepaald door de verbrekings-, BootNotification- en herverbindingssignalen.':'De volledige laadcontroller wordt opnieuw gestart. De verbinding valt tijdelijk weg.','Wacht tot de laadcontroller opnieuw is opgestart en controleer daarna de status.'],
              operative:[accepted?'Connector wordt beschikbaar gemaakt':'Beschikbaar maken niet geaccepteerd',accepted?'Connector 1 is operatief gezet. Een nieuwe StatusNotification moet de actuele toestand bevestigen.':'De Homebox heeft ChangeAvailability niet aangenomen.','Vraag daarna de status opnieuw op om de werkelijke toestand te controleren.'],
              inoperative:[accepted?'Connector wordt buiten gebruik gezet':'Buiten gebruik zetten niet geaccepteerd',accepted?'Connector 1 is inoperatief gezet. Een eventuele bezette connector kan de wijziging uitstellen.':'De Homebox heeft ChangeAvailability niet aangenomen.','Vraag daarna de status opnieuw op om de werkelijke toestand te controleren.'],
              unlock:[accepted?'Ontgrendelopdracht geaccepteerd':'Stekker niet ontgrendeld',accepted?'De Homebox heeft opdracht gekregen connector 1 vrij te geven.':'De Homebox kon de connector niet vrijgeven.','Controleer de fysieke stekker en vraag daarna de status op.'],
              clearCache:[accepted?'Autorisatiecache gewist':'Cache wissen niet geaccepteerd',accepted?'De lokale RFID-autorisatiecache van de Homebox is gewist.':'De Homebox heeft ClearCache geweigerd.','Nieuwe passen moeten opnieuw via de backoffice worden gecontroleerd.'],
              clearProfile:[accepted?'Laadprofiel gewist':'Laadprofiel niet gewist',accepted?'Het TxDefaultProfile voor connector 1 is verwijderd.':'De Homebox vond of verwijderde het laadprofiel niet.','Controleer onder EMS of er nog een actieve vermogenslimiet wordt toegepast.'],
              remoteStart:[accepted?'Startverzoek geaccepteerd':'Laadsessie niet gestart',accepted?'De Homebox heeft testtag LAADFIX ontvangen. StartTransaction en Charging moeten de echte start nog bevestigen.':'De Homebox heeft RemoteStartTransaction geweigerd.','Bekijk Status of Berichten voor de definitieve uitkomst.'],
              remoteStop:[accepted?'Stopverzoek geaccepteerd':'Laadsessie niet gestopt',accepted?'De Homebox heeft opdracht gekregen de actieve transactie te beëindigen. StopTransaction bevestigt de echte stop.':'De Homebox heeft RemoteStopTransaction geweigerd.','Bekijk Status of Berichten voor de definitieve uitkomst.'],
              backendReconnect:[result?.status==='Started'?'Nieuwe backofficeverbinding gestart':result?.status==='AlreadyConnected'?'Backoffice was al verbonden':'Backofficeverbinding wordt opgebouwd','Alleen de proxyverbinding naar de ingestelde backend is vernieuwd. De Homeboxsocket is open gebleven.','De proxy blijft automatisch opnieuw proberen. Gebruik deze knop alleen wanneer je direct een extra poging wilt starten.'],
              changeConfiguration:[accepted?'Configuratiewijziging geaccepteerd':'Configuratiewijziging geweigerd',`Instelling ${configKey} is naar de Homebox verstuurd.`,accepted?'Lees de instelling opnieuw uit om de opgeslagen waarde te bevestigen.':'De huidige waarde is niet gewijzigd.'],
              getConfiguration:['Configuratie ontvangen',`${Array.isArray(result?.configurationKey)?result.configurationKey.length:0} instellingen door de Homebox teruggestuurd.`,'De actuele waarden staan onder Configuratie.']
            },description=descriptions[action];
            if(description){status=description[0];steps.push(description[1]);advice=description[2];}
          }
          serviceResult={action,status,steps,result,advice,time:new Date().toISOString()};return send(200,{serviceResult,result});}catch(error){if(diagnosticToken){const ticket=diagnosticTokens.get(diagnosticToken),current=diagnosticReports.get(chargerId);releaseDiagnosticTicket(ticket);diagnosticReports.set(chargerId,{...current,status:'Mislukt',error:error.message,progress:{...current?.progress,phase:'failed',label:'Diagnose niet gestart',percent:100}});}throw error;}finally{busy=false;}
      }
      if(req.url==='/api/settings'){engine.set(body);state=engine.tick();return send(200,{...state,diagnostic});}
      if(req.url==='/api/reset'){engine.reset();state=engine.tick();return send(200,{...state,diagnostic});}
      if(req.url==='/api/control'){
        if(typeof body.enabled!=='boolean')throw Error('Ongeldige instelling');
        if(!charger.chargerConnected||!charger.backendConnected)throw Error('Homebox en backoffice moeten beide verbonden zijn');
        liveControl=body.enabled;lastControlError=null;
        if(liveControl){const target=state.result.actualA||0;lastControlResult=await applyLimit(target);if(lastControlResult?.status!=='Accepted'){liveControl=false;throw Error('Homebox weigert het laadprofiel: '+(lastControlResult?.status||'onbekend'));}}
        else{lastControlResult=await relayCommand('ClearChargingProfile',{id:900001});lastSentLimit=null;if(lastControlResult?.status!=='Accepted'&&lastControlResult?.status!=='Unknown')throw Error('Testprofiel kon niet worden verwijderd: '+(lastControlResult?.status||'onbekend'));}
        return send(200,{liveControl,lastSentLimit,lastControlResult,lastControlError});
      }
      if(req.url==='/api/capabilities'){
        capabilities=await relayCommand('GetConfiguration',{key:['SupportedFeatureProfiles','ChargingScheduleAllowedChargingRateUnit','ChargeProfileMaxStackLevel','MaxChargingProfilesInstalled']});return send(200,{capabilities});
      }
      if(req.url==='/api/network-diagnostics'){
        if(busy)return send(429,{error:'Er loopt al een diagnose of opdracht'});busy=true;try{
          networkResult=await networkDiagnostics();
          const allOk=networkResult.dns.ok&&networkResult.backend.ok&&charger.chargerConnected&&charger.backendConnected;
          serviceResult={action:'networkDiagnostics',status:allOk?'Netwerkdiagnose geslaagd':'Netwerkdiagnose vindt een aandachtspunt',steps:[`DNS Robo Charge: ${networkResult.dns.ok?'bereikbaar via '+networkResult.dns.address:'niet bereikbaar · '+(networkResult.dns.error||'onbekend')}`,`Robo Charge poort 80: ${networkResult.backend.ok?'bereikbaar':networkResult.backend.detail}`,`Homebox HTTP-poort 80: ${networkResult.homebox.ok?'bereikbaar':networkResult.homebox.detail}`,`Homebox → proxy: ${charger.chargerConnected?'OCPP verbonden':'niet verbonden'}`,`Proxy → Robo Charge: ${charger.backendConnected?'OCPP verbonden':'niet verbonden'}`],result:networkResult,advice:allOk?'De volledige OCPP-route is bereikbaar.':'Een gesloten HTTP-poort op de Homebox is niet automatisch een storing wanneer de uitgaande OCPP-verbinding wel actief is.',time:new Date().toISOString()};
          return send(200,{serviceResult,networkResult});
        }finally{busy=false;}
      }
      if(req.url==='/api/proxy-routing'){
        const charging=charger.activeTransaction||['Charging','Preparing','Finishing'].includes(charger.status);if(charging)throw Error('Proxyroute wijzigen is geblokkeerd tijdens een actieve of startende laadsessie');
        if(busy)return send(429,{error:'Er loopt al een diagnose of opdracht'});busy=true;try{const result=await changeProxyRoute(body.upstream);serviceResult={action:'proxyRouting',status:'Proxybestemming gewijzigd',steps:[`Nieuwe route: ${result.upstream}`,'De Homebox wordt opnieuw verbonden met de gekozen OCPP-server'],advice:'Controleer binnen enkele minuten of beide verbindingen weer groen zijn.',result,time:new Date().toISOString()};return send(200,{serviceResult,result});}finally{busy=false;}
      }
      if(req.url==='/api/service-command'){
        if(busy)return send(429,{error:'Er loopt al een diagnose of opdracht'});
        if(!charger.chargerConnected)throw Error('Homebox is niet via OCPP verbonden');
        const charging=charger.activeTransaction||['Charging','Preparing','Finishing'].includes(charger.status);
        const commands={
          status:()=>relayCommand('TriggerMessage',{requestedMessage:'StatusNotification',connectorId:1}),
          meterValues:()=>relayCommand('TriggerMessage',{requestedMessage:'MeterValues',connectorId:1}),
          meterInterval:async()=>({sample:await relayCommand('ChangeConfiguration',{key:'MeterValueSampleInterval',value:'60'}),clock:await relayCommand('ChangeConfiguration',{key:'ClockAlignedDataInterval',value:'60'})}),
          configuration:()=>relayCommand('GetConfiguration',{key:['HeartbeatInterval','ConnectionTimeOut','MeterValueSampleInterval','ClockAlignedDataInterval','SupportedFeatureProfiles','ChargeProfileMaxStackLevel']}),
          softReset:()=>relayCommand('Reset',{type:'Soft'}),
          unlock:()=>relayCommand('UnlockConnector',{connectorId:1}),
          clearProfile:()=>relayCommand('ClearChargingProfile',{connectorId:1,chargingProfilePurpose:'TxDefaultProfile'}),
          operative:()=>relayCommand('ChangeAvailability',{connectorId:1,type:'Operative'}),
        };
        if(!commands[body.action])throw Error('Onbekende serviceopdracht');
        if(charging&&['softReset','unlock','clearProfile','operative'].includes(body.action))throw Error('Actie geblokkeerd tijdens een actieve of startende laadsessie');
        busy=true;try{
          const beforeMeter=charger.lastMeterValues;
          const result=await commands[body.action]();
          if(body.action==='meterValues'){
            await new Promise(r=>setTimeout(r,6000));
            const meter=extractMeterReadings(charger.meterValues,charger.lastMeterValues);
            const received=!!charger.lastMeterValues&&charger.lastMeterValues!==beforeMeter;
            const row=charger.meterHistory?.[0];
            const value=(item,fallback='niet meegestuurd')=>item?`${Number(item.value).toLocaleString('nl-NL',{maximumFractionDigits:3})} ${item.unit}`:fallback;
            serviceResult={action:body.action,status:received?'Meterwaarden ontvangen':'Aanvraag geaccepteerd, maar geen nieuwe meterdata ontvangen',steps:[`Homebox antwoord: ${result?.status||'onbekend'}`,received?`Meting: ${new Date(row?.time||charger.lastMeterValues).toLocaleString('nl-NL',{timeZone:'Europe/Amsterdam'})}`:'Binnen 6 seconden kwam geen nieuw MeterValues-bericht terug',`Energiestand: ${value(row?.energy||meter.energy)}`,`Spanning L1: ${value(row?.voltageL1)}`,`Stroom L1: ${value(row?.currentL1||meter.current)}`,`Frequentie: ${value(row?.frequency)}`,`Temperatuur: ${value(row?.temperature)}`,received&&charger.lastMeterForwarded?'Doorgestuurd naar Robo Charge':'Geen nieuw meterbericht om door te sturen'].filter(Boolean),result:{request:result,meter},advice:received?'Deze meting blijft ook in de vaste meterhistorie staan.':'De laatst opgeslagen waarden staan hierboven; probeer opnieuw tijdens een actieve laadsessie voor een nieuwe meting.',time:new Date().toISOString()};
          }else serviceResult={action:body.action,result,time:new Date().toISOString()};
          return send(200,{serviceResult});
        }finally{busy=false;}
      }
      if(req.url==='/api/led'){
        if(!['on','off','green','red','blue','auto'].includes(body.action))throw Error('Ongeldige led-opdracht');
        if(body.action==='auto'){led.automatic=true;lastApplied=null;await refreshHardware();return send(200,{charger,led});}
        if(!led.configured)throw Error('Koppel eerst één lamp via Smart Life zodat de lokale sleutel beschikbaar is.');
        led.automatic=false;led.busy=true;try{await runLed(body.action);lastApplied=body.action;led.lastAction=new Date().toISOString();led.error=null;}finally{led.busy=false;}return send(200,{charger,led});
      }
      if(req.url==='/api/status-simulation'){
        if(!['live','Available','Faulted','Charging'].includes(body.status))throw Error('Ongeldige laadpaalstatus');
        statusSimulation=body.status==='live'?null:body.status;led.automatic=true;lastApplied=null;await refreshHardware();return send(200,{charger,led});
      }
      if(req.url==='/api/connection'){
        if(busy)return send(429,{error:'Er loopt al een verbindingscontrole'});
        busy=true;try{diagnostic=await probe(body.ip);return send(200,diagnostic);}finally{busy=false;}
      }
      return send(404,{error:'Niet gevonden'});
    }catch(e){if(!res.headersSent)send(400,{error:e.message});}
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});}catch(e){clearInterval(timer);throw e;}
  return {port:server.address().port,close:async()=>{clearInterval(timer);if(hardwareTimer)clearInterval(hardwareTimer);if(controlTimer)clearInterval(controlTimer);if(meterTimer)clearInterval(meterTimer);await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const app=await startEMS({port:Number(process.env.EMS_PORT||8080),host:process.env.EMS_HOST||'127.0.0.1',hardware:process.env.HARDWARE!=='false',ledHardware:process.env.LED_HARDWARE?process.env.LED_HARDWARE==='true':process.env.HARDWARE!=='false',publicHost:process.env.PUBLIC_HOST||null,authUser:process.env.DASHBOARD_USER||null,authPassword:process.env.DASHBOARD_PASSWORD||null,relayMonitorPort:Number(process.env.MONITOR_PORT||8081)});writeFileSync(new URL('ems.pid',import.meta.url),String(process.pid));
  console.log(`EMS-dashboard draait op poort ${app.port}.`);
  process.on('SIGINT',async()=>{await app.close();try{unlinkSync(new URL('ems.pid',import.meta.url));}catch{}process.exit();});
}
