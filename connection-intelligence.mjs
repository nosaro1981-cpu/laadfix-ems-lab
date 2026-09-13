const clamp=(value,min=0,max=100)=>Math.max(min,Math.min(max,value));
const age=(time,now)=>time?Math.max(0,now-Date.parse(time)):Infinity;
const percentile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];};

export function connectionIntelligence(charger,samples=[],now=Date.now()){
  const messageAge=age(charger.lastSeen,now),heartbeatAge=age(charger.lastHeartbeat,now),meterAge=age(charger.lastMeterValues,now);
  const recentEvents=(charger.events||[]).filter(event=>now-Date.parse(event.time)<15*60_000);
  const disconnects=recentEvents.filter(event=>/gesloten|verbindingsfout/i.test(event.action+' '+event.detail)).length;
  const latencies=(charger.roundTrips||[]).filter(row=>now-Date.parse(row.time)<15*60_000).map(row=>row.ms).filter(Number.isFinite);
  const p95=percentile(latencies,.95),median=percentile(latencies,.5);
  const recent=samples.filter(row=>now-row.time<5*60_000),transitions=recent.slice(1).filter((row,index)=>row.chargerConnected!==recent[index].chargerConnected||row.backendConnected!==recent[index].backendConnected).length;
  let score=100;
  if(!charger.chargerConnected)score-=45;if(!charger.backendConnected)score-=35;if(charger.commandHealth?.degraded)score-=30;
  score-=clamp((messageAge-60_000)/6_000,0,18);
  score-=clamp((heartbeatAge-180_000)/20_000,0,12);
  score-=Math.min(20,(disconnects+transitions)*4);
  if(p95!==null)score-=clamp((p95-1200)/250,0,10);
  if(['Faulted','Unavailable'].includes(charger.status)||charger.errorCode&&charger.errorCode!=='NoError')score-=12;
  score=Math.round(clamp(score));
  const staleTrend=recent.length>=3&&recent.at(-1).messageAgeMs>recent[0].messageAgeMs+30_000;
  const risk=clamp(Math.round(100/(1+Math.exp(-(-3.4+(disconnects+transitions)*.7+(messageAge/60_000)*.85+(p95||0)/5000+(staleTrend?1.2:0))))));
  const findings=[];
  if(!charger.chargerConnected)findings.push({level:'critical',title:'Homebox-kanaal weg',detail:'De laadpaal meldt zich niet aan op de proxy. Controleer transport, endpoint en voeding.'});
  else if(!charger.backendConnected)findings.push({level:'critical',title:'Alleen upstream weg',detail:'De Homebox bereikt de proxy wel. Controleer DNS, internet en de gekozen backoffice; herstart de lader nog niet.'});
  if(charger.chargerConnected&&charger.commandHealth?.degraded)findings.push({level:'critical',title:'Socket open maar bediening reageert niet',detail:`${charger.commandHealth.lastTimeoutAction||'Een OCPP-opdracht'} kreeg geen antwoord. Telemetrie kan nog binnenkomen, maar de verbinding is niet gezond.`});
  if(charger.chargerConnected&&charger.backendConnected&&messageAge>120_000)findings.push({level:'warning',title:'Stille verbinding',detail:'De socket staat open maar berichten blijven uit. Vraag status op; reset pas als ook die opdracht geen antwoord geeft.'});
  if(disconnects+transitions>=3)findings.push({level:'warning',title:'Flapperende verbinding',detail:`${disconnects+transitions} wisselingen in 15 minuten. Controleer kabel, DHCP-lease, 4G-signaal en voedingsdippen.`});
  if(p95!==null&&p95>3000)findings.push({level:'warning',title:'Oplopende vertraging',detail:`95% van de antwoorden blijft onder ${Math.round(p95)} ms. Dit kan een voorbode zijn van pakketverlies of een drukke backoffice.`});
  if(meterAge>120_000&&charger.activeTransaction)findings.push({level:'warning',title:'Meterdata valt achter',detail:'De laadsessie is actief maar MeterValues zijn ouder dan twee minuten. Controleer meterbus en sample-interval.'});
  if(!findings.length)findings.push({level:'ok',title:'Verbinding stabiel',detail:'Geen vroegtijdige uitvalsignalen gevonden in het actuele meetvenster.'});
  return {score,risk,grade:score>=85?'Sterk':score>=65?'Redelijk':score>=40?'Instabiel':'Kritiek',messageAgeMs:Number.isFinite(messageAge)?messageAge:null,heartbeatAgeMs:Number.isFinite(heartbeatAge)?heartbeatAge:null,meterAgeMs:Number.isFinite(meterAge)?meterAge:null,disconnects15m:disconnects+transitions,latencyMedianMs:median,latencyP95Ms:p95,staleTrend,findings,formula:'score = bereikbaarheid − stilte − verbindingswisselingen − latency − foutstatus; risico = logistische combinatie over 5–15 minuten',generatedAt:new Date(now).toISOString()};
}

export function analyzeControllerLog(text){
  if(typeof text!=='string'||!text.trim())throw Error('Plak eerst een controllerlog');
  if(text.length>250_000)throw Error('Log is groter dan 250 kB');
  const count=pattern=>(text.match(pattern)||[]).length;
  const temperatures=[...text.matchAll(/Temperature[^;\]\r\n]*[;,(](\d{1,3})C/gi)].map(match=>Number(match[1])).filter(Number.isFinite);
  const supplies=[...text.matchAll(/(\d{4,5})mV/gi)].map(match=>Number(match[1])).filter(Number.isFinite);
  const values=pattern=>[...text.matchAll(pattern)].map(match=>match[1]).filter(Boolean);
  const dnsResolved=[...new Set(values(/DNS RESOLVED:\s*([0-9a-f:.]+)/gi))];
  const httpTargets=[...new Set([...text.matchAll(/HTTP connect to \[([^\]]+)\]\[([^\]]+)\]/gi)].map(match=>`${match[1]}:${match[2]}`))];
  const retryDelays=values(/EV RETRY \[[^\]]+\] DELAY \[([^\]]+)\]\s*Min/gi).map(Number).filter(Number.isFinite);
  const localIp=values(/IP address\s+([0-9.]+)/gi).at(-1)||null;
  const gateway=values(/gateway\s+([0-9.]+)/gi).at(-1)||null;
  const dnsServer=values(/DNS server\s+([0-9.]+)/gi).at(-1)||null;
  const gsmSignal=values(/GSM REG:\s*\d+\s*,\s*SQ:\s*(\d+)/gi).map(Number).filter(Number.isFinite).at(-1)??null;
  const gsmRegistration=values(/GSM REG:\s*(\d+)/gi).at(-1)||null;
  const stats={lines:text.split(/\r?\n/).filter(Boolean).length,boots:count(/State changed[^\n]*Boot|LEDSTATE[^\n]*Boot/gi),gsmPowerCycles:Math.floor(count(/GSM PWR (?:ON|OFF)/gi)/2),gsmResetNoNetwork:count(/GSM RST CAUSE:[^\n]*GSMNOK/gi),dhcpBound:count(/DHCP:\s*State BOUND/gi),dhcpStarts:count(/DHCP INIT/gi),dnsQueries:count(/DNS SERV|Connecting to DNS Server|Sending q/gi),dnsResolved:dnsResolved.length,httpConnects:count(/HTTP connect to/gi),webSocketErrors:count(/WS CONNECTION ERROR/gi),webSocketPongTimeouts:count(/WS PONG TIMEOUT/gi),httpClientCloses:count(/HTTP CLIENT CLOSE/gi),meterTimeouts:count(/KWH:[^\n]*ERR\[TO\]/gi),readerErrors:count(/Reader init error/gi),modbusActive:count(/MODBUS Thread active/gi),maxTemperatureC:temperatures.length?Math.max(...temperatures):null,minSupplyMv:supplies.length?Math.min(...supplies):null};
  const facts={localIp,gateway,dnsServer,dnsResolved,httpTargets,gsmRegistration,gsmSignal,retryDelayMinutes:retryDelays.at(-1)??null,modem:values(/GSM Modem:\s*([^\r\n]+)/gi).at(-1)||null,operator:values(/GSM preferred operator \[([^\]]+)\]/gi).at(-1)||null};
  const eventPatterns=[['boot',/Application start|LEDSTATE[^\n]*Boot/i],['gsm',/GSM (?:RST CAUSE|Modem:|REG:|preferred operator)|GSM CCID|GSM IMSI/i],['ethernet',/ETH0 |DHCP: State|IP address|gateway|DNS server/i],['dns',/DNS (?:SERV|RESOLVED)/i],['tcp',/HTTP connect to/i],['websocket',/WS CONNECTION ERROR|WS PONG TIMEOUT|HTTP CLIENT CLOSE/i],['retry',/EV RETRY/i],['meter',/KWH:|Meter\d*:SN/i],['rfid',/Reader init error/i]];
  const timeline=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).flatMap(line=>{const found=eventPatterns.find(([,pattern])=>pattern.test(line));return found?[{type:found[0],line}]:[];}).slice(-150);
  const findings=[],controllerHealth=extractControllerHealth(text),memoryEvidence=[controllerHealth.ram.usedPercent===null?null:`RAM ${controllerHealth.ram.usedPercent}%`,controllerHealth.flash.usedPercent===null?null:`flash ${controllerHealth.flash.usedPercent}%`,controllerHealth.minIpHeapKb===null?null:`vrije netwerkheap ${controllerHealth.minIpHeapKb} kB`,controllerHealth.minStackGapKb===null?null:`stack/heap-marge ${controllerHealth.minStackGapKb} kB`].filter(Boolean).join(', ');
  if(controllerHealth.level==='critical')findings.push({level:'critical',code:'CONTROLLER_MEMORY',title:'Controllergeheugen of opslag kritiek',evidence:memoryEvidence||`${controllerHealth.memoryFaults+controllerHealth.resetFaults} geheugen-/processorfouten`,action:'Controleer het vrije geheugen en de flashopslag. Bewaar eerst de diagnose; onderzoek geheugenlek, volle eventopslag of firmwareprobleem voordat de controller wordt herstart.'});
  else if(controllerHealth.level==='warning')findings.push({level:'warning',code:'CONTROLLER_MEMORY',title:'Controllergeheugenreserve is klein',evidence:memoryEvidence,action:'Vergelijk dit met een gezonde controller en een volgende diagnose. Oplopend gebruik kan wijzen op een geheugenlek of vollopende flash.'});
  if(stats.dnsResolved&&stats.httpConnects&&stats.webSocketErrors)findings.push({level:'critical',code:'WS_HANDSHAKE',title:'WebSocket-aanmelding mislukt na werkende DNS en TCP',evidence:`${stats.dnsResolved} DNS-adres(sen), ${stats.httpConnects} TCP-pogingen, ${stats.webSocketErrors} WebSocket-fouten`,action:'Internet en DNS werken. Controleer nu het exacte endpointpad, #OSN#-vervanging en de WebSocket/OCPP-subprotocol-handshake bij de proxy.'});
  if(stats.webSocketPongTimeouts)findings.push({level:'critical',code:'WS_PONG_TIMEOUT',title:'WebSocket-keepalive krijgt geen antwoord',evidence:`${stats.webSocketPongTimeouts} PONG-time-out${stats.webSocketPongTimeouts===1?'':'s'}`,action:'DNS en TCP kunnen hierbij gewoon werken. Controleer de WebSocket-proxy, OCPP-subprotocol en WebSocketPingInterval; een modemreset is pas zinvol als ook de netwerkregistratie wegvalt.'});
  if(gsmRegistration==='5')findings.push({level:'ok',code:'GSM_ROAMING',title:'SIM is geregistreerd via roaming',evidence:`GSM REG 5${gsmSignal===null?'':`, signaal ${gsmSignal}/31`}`,action:'De mobiele registratie is gelukt; een netwerkreset lost de huidige WebSocket-handshakefout waarschijnlijk niet op.'});
  else if(gsmRegistration&&gsmRegistration!=='1')findings.push({level:'warning',code:'GSM_REGISTRATION',title:'SIM-registratie vraagt aandacht',evidence:`GSM REG ${gsmRegistration}${gsmSignal===null?'':`, signaal ${gsmSignal}/31`}`,action:'Controleer SIM, APN, operator en antenne voordat OCPP verder wordt onderzocht.'});
  if(stats.gsmResetNoNetwork)findings.push({level:'warning',code:'GSM_NOK_RESET',title:'Modemstart meldt eerder geen mobiel netwerk',evidence:`${stats.gsmResetNoNetwork} keer GSMNOK als resetoorzaak`,action:'Vergelijk dit met de latere GSM REG-status; in deze log herstelde de registratie vervolgens wel.'});
  if(stats.meterTimeouts)findings.push({level:stats.meterTimeouts>=3?'critical':'warning',code:'METER_TIMEOUT',title:'kWh-meter reageert niet',evidence:`${stats.meterTimeouts} Modbus time-outs`,action:'Controleer meteradres, A/B-polariteit, afsluitweerstand, baudrate en voeding. Dit is geen reden om de 4G-module te resetten.'});
  if(stats.gsmPowerCycles>=2)findings.push({level:'warning',code:'GSM_CYCLE',title:'4G-module start herhaaldelijk',evidence:`${stats.gsmPowerCycles} volledige aan/uit-cycli`,action:'Lees RSSI/RSRP, SIM-registratie en APN uit. Gebruik een wachttijd met oplopende tussenpozen om een resetlus te voorkomen.'});
  if(stats.dhcpStarts>stats.dhcpBound)findings.push({level:'critical',code:'DHCP_NO_LEASE',title:'DHCP krijgt niet altijd een adres',evidence:`${stats.dhcpStarts} starts, ${stats.dhcpBound} keer gebonden`,action:'Controleer kabel/switch en DHCP-server. Maak daarna een vaste DHCP-reservering op basis van het MAC-adres.'});
  if(stats.dhcpBound&&stats.httpConnects===0)findings.push({level:'warning',code:'NO_UPSTREAM',title:'Wel lokaal IP, geen zichtbare serververbinding',evidence:'DHCP is gebonden maar geen HTTP-connect gevonden',action:'Controleer gateway, DNS en uitgaand verkeer naar de backoffice.'});
  if(stats.readerErrors)findings.push({level:'warning',code:'RFID_READER',title:'RFID-lezer initialiseert niet correct',evidence:`${stats.readerErrors} initialisatiefout(en)`,action:'Controleer lezerconfiguratie, kabel en voeding. Dit staat los van de WebSocket-handshake.'});
  if(facts.retryDelayMinutes!==null)findings.push({level:'ok',code:'RETRY_DELAY',title:'Nieuwe verbindingspoging is uitgesteld',evidence:`Controller wacht ${facts.retryDelayMinutes} minuut/minuten`,action:'Wacht deze vertraging af na een wijziging of herstart; de dashboardstatus verandert pas bij de volgende poging.'});
  if(stats.minSupplyMv!==null&&stats.minSupplyMv<11_500)findings.push({level:'warning',code:'LOW_SUPPLY',title:'Voedingsspanning laag',evidence:`Minimum ${stats.minSupplyMv} mV`,action:'Meet de voeding tijdens modemstart; 4G-pieken kunnen een brown-out veroorzaken.'});
  if(stats.maxTemperatureC!==null&&stats.maxTemperatureC>=70)findings.push({level:'critical',code:'HIGH_TEMP',title:'Controller te warm',evidence:`Maximum ${stats.maxTemperatureC} °C`,action:'Controleer ventilatie, zoninstraling en schakelkasttemperatuur.'});
  if(!findings.length)findings.push({level:'ok',code:'NO_PATTERN',title:'Geen bekend foutpatroon',evidence:`${stats.lines} regels onderzocht`,action:'Vergroot het logvenster rond het storingsmoment en voeg RSSI, DNS, DHCP en OCPP-status toe.'});
  const score=Math.max(0,100-findings.reduce((sum,item)=>sum+(item.level==='critical'?28:item.level==='warning'?12:0),0));
  return {score,stats,facts,timeline,findings,controllerHealth,analyzedAt:new Date().toISOString()};
}

const meterName=value=>String(value||'').trim().replace(/[_-]+/g,' ').replace(/\s+/g,' ')||null;
const meterKey=value=>{
  const text=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const known=text.match(/(?:SDM[A-Z0-9]+|EM\d{2,4}|B2[34]|PRO\d{2,4})/);
  return known?.[0]||text||null;
};
const meterDisplay=value=>{const name=meterName(value),key=meterKey(value);return key?.startsWith('SDM')?key:name;};

export function normalizeControllerLog(value){
  return String(value||'').replaceAll(String.fromCharCode(0),'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'');
}

export function readableControllerLog(value){
  return normalizeControllerLog(value)
    .replace(/\uFFFD+/g,match=>match.length>=4?`\n[Binair meterblok verborgen · ${match.length} onleesbare tekens]\n`:'')
    .replace(/\n{3,}/g,'\n\n');
}

export function extractControllerHealth(value){
  const text=normalizeControllerLog(value),numbers=pattern=>[...text.matchAll(pattern)].map(match=>Number(match[1])).filter(Number.isFinite),pair=pattern=>[...text.matchAll(pattern)].map(match=>[Number(match[1]),Number(match[2])]).filter(row=>row.every(Number.isFinite)).at(-1)||null;
  const ram=pair(/RAM SIZE\/CEILING:\s*(\d+)\s*KB\s*\/\s*(\d+)/gi),flash=pair(/FLASH SIZE\/CEILING:\s*(\d+)\s*KB\s*\/\s*(\d+)/gi),heapSamples=numbers(/IP free Heap\s*:\s*([\d.]+)\s*k/gi),stackGaps=numbers(/Stack size[^\r\n]*?Gap:\s*([\d.]+)\s*kb/gi),event=[...text.matchAll(/EVENT FLASH MANAGER START\s*\[WRID:(\d+)\]\[(\d+)\/(\d+)\]MEM USAGE\[(\d+)\]/gi)].at(-1)||null;
  const capacity=(row)=>{if(!row)return{totalKb:null,ceilingBytes:null,usedKb:null,usedPercent:null,freeKb:null,freePercent:null};const totalBytes=row[0]*1024,freeBytes=Math.max(0,totalBytes-row[1]);return{totalKb:row[0],ceilingBytes:row[1],usedKb:Number((row[1]/1024).toFixed(1)),usedPercent:Number((row[1]/totalBytes*100).toFixed(1)),freeKb:Number((freeBytes/1024).toFixed(1)),freePercent:Number((freeBytes/totalBytes*100).toFixed(1))};};
  const memoryFaults=(text.match(/out of memory|\boom\b|malloc(?:\s+(?:fail|error))|allocation fail|stack overflow|flash (?:full|error|fail)|file ?system[^\r\n]*full|storage[^\r\n]*full/gi)||[]).length,resetFaults=(text.match(/hard ?fault|watchdog reset|wdt reset|brown.?out|panic|assert(?:ion)? failed/gi)||[]).length,ramInfo=capacity(ram),flashInfo=capacity(flash),minIpHeapKb=heapSamples.length?Math.min(...heapSamples):null,minStackGapKb=stackGaps.length?Math.min(...stackGaps):null;
  let level='ok',label='Geen geheugentekort aangetroffen';
  if(memoryFaults||resetFaults||(minIpHeapKb!==null&&minIpHeapKb<2)||(minStackGapKb!==null&&minStackGapKb<2)||(ramInfo.freePercent!==null&&ramInfo.freePercent<3)||(flashInfo.freePercent!==null&&flashInfo.freePercent<3)){level='critical';label='Geheugen of opslag kritiek';}
  else if((minIpHeapKb!==null&&minIpHeapKb<4)||(minStackGapKb!==null&&minStackGapKb<4)||(ramInfo.freePercent!==null&&ramInfo.freePercent<5)||(flashInfo.freePercent!==null&&flashInfo.freePercent<10)){level='warning';label='Geheugenreserve vraagt aandacht';}
  return{level,label,ram:ramInfo,flash:flashInfo,minIpHeapKb,minStackGapKb,eventFlash:event?{writeIndex:Number(event[1]),used:Number(event[2]),capacity:Number(event[3]),memoryUsage:Number(event[4])}:null,memoryFaults,resetFaults,samples:{ipHeap:heapSamples.length,stackGap:stackGaps.length}};
}

export function diagnosticAnalysisWindow(value,maxLength=250_000){
  const text=normalizeControllerLog(value);
  if(text.length<=maxLength)return text;
  const side=Math.floor((maxLength-32)/2);
  return text.slice(0,side)+'\n[...midden ingekort...]\n'+text.slice(-side);
}

export function extractDiagnosticOverview(value){
  const text=normalizeControllerLog(value),configuration={};
  for(const match of text.matchAll(/"key"\s*:\s*"([^"\r\n]+)"\s*,\s*"readonly"\s*:\s*(?:true|false)\s*,\s*"value"\s*:\s*"([^"\r\n]*)"/gi))configuration[match[1]]=match[2];
  const meters=[...text.matchAll(/KWH METER \[CH\]\[SERIAL\]\[TYPE\]:\[(\d+)\]\[([^\]]+)\]\[([^\]]+)\]/gi)].map(match=>({channel:match[1],serial:match[2],model:meterDisplay(match[3])}));
  const activeMeters=[...new Map(meters.map(meter=>[`${meter.channel}:${meter.serial}:${meter.model}`,meter])).values()];
  const configuredMeters=Object.entries(configuration).filter(([key,value])=>/^chg_KWH\d+$/i.test(key)&&!/^none(?:,|$)/i.test(value)).map(([key,value])=>({slot:key.replace(/\D/g,''),model:meterDisplay(value.split(',')[0]),address:value.split(',')[1]||null}));
  const number=value=>value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
  const addressMismatches=configuredMeters.filter(meter=>Number(meter.address)!==Number(meter.slot)).map(meter=>({slot:Number(meter.slot),address:Number(meter.address),model:meter.model,source:'configuratie'}));
  const observedAddressMismatches=activeMeters.map(meter=>({slot:Number(meter.channel)+1,address:null,model:meter.model,serial:meter.serial,source:'controllerlog'}));
  for(const meter of observedAddressMismatches){const startup=[...text.matchAll(new RegExp(`Meter${meter.slot-1}:SN\\[${String(meter.serial).replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\]Type\\[[^\\]]+\\]Speed\\[(\\d+)\\]Addr\\[(\\d+)\\]`,'gi'))].at(-1);meter.address=startup?Number(startup[2]):null;}
  const observedMismatches=observedAddressMismatches.filter(meter=>meter.address!==null&&meter.address!==meter.slot);
  const pgrid=[...text.matchAll(/PGrid\[([^\]]+)\]MIN\.I\[([^\]]+)\]STATION\[([^\]]+)\]INSTALLATION\[([^\]]+)\]SUPERVISOR\[([^\]]+)\]/gi)].at(-1),supervisorClientCount=number(configuration.grid_SupervisorClientCount),runtimeSupervisor=number(pgrid?.[5]);
  const canErrors=(text.match(/CAN(?:BUS)?[^\r\n]*(?:BUS.?OFF|ERROR|ERR\[)/gi)||[]).length,termination=[...text.matchAll(/CAN(?:BUS)?[^\r\n]*(?:TERM(?:INATION)?|AFSLUIT)[^\r\n]*?(\d{2,3})\s*(?:OHM|Ω)/gi)].at(-1)?.[1]||null;
  const loadBalancingDetected=(supervisorClientCount||0)>0||(runtimeSupervisor||0)>0||/PGrid\[[^\]]*(?:SUPERVISOR|CLIENT)/i.test(text);
  return {activeMeters,activeMeterCount:activeMeters.length,configuredMeters,configuredMeterCount:configuredMeters.length,addressMismatches,observedAddressMismatches:observedMismatches,supervisorClientCount,runtimeSupervisor,numberOfConnectors:number(configuration.NumberOfConnectors),enabledChannels:number(configuration.chg_ChannelsEnabled),gridRole:configuration.grid_Role||null,gridCommunication:configuration.grid_CommChannel||null,gridRuntime:pgrid?{role:pgrid[1],minimumCurrent:number(pgrid[2]),stationCurrent:number(pgrid[3]),installationCurrent:number(pgrid[4]),supervisorCurrent:runtimeSupervisor}:null,loadBalancingDetected,canErrors,canTerminationOhm:termination?Number(termination):null,transport:configuration.com_ProtCh||null,protocol:configuration.com_ProtType||null,sampleIntervalSeconds:number(configuration.MeterValueSampleInterval),heartbeatSeconds:number(configuration.HeartbeatInterval),controllerHealth:extractControllerHealth(text)};
}

export function extractMeterIdentity(value,meterSetting=null){
  const text=normalizeControllerLog(value),pick=pattern=>[...text.matchAll(pattern)].at(-1)||null;
  const initialized=pick(/KWH METER \[CH\]\[SERIAL\]\[TYPE\]:\[(\d+)\]\[([^\]]+)\]\[([^\]]+)\]/gi);
  const startup=pick(/Meter\d+:SN\[([^\]]+)\]Type\[([^\]]+)\]Speed\[(\d+)\]Addr\[(\d+)\]Opt\[([^\]]+)\]/gi);
  const detected=pick(/(?:Meter detected:\s*|KWH meter\s+)([A-Za-z][A-Za-z0-9 _.-]{1,80}?)(?=\s+(?:ready|detected|online)\b|[\r\n]|$)/gi);
  const bootType=pick(/"meterType"\s*:\s*"([^"]+)"/gi),bootSerial=pick(/"meterSerialNumber"\s*:\s*"([^"]+)"/gi);
  const configured=pick(/"key"\s*:\s*"chg_KWH1"\s*,\s*"readonly"\s*:\s*(?:true|false)\s*,\s*"value"\s*:\s*"([^"]+)"/gi),configuration=String(meterSetting||configured?.[1]||''),parts=configuration.split(',');
  const initializedModel=meterDisplay(initialized?.[3]),detectedModel=meterDisplay(detected?.[1]),reportedModel=meterDisplay(bootType?.[1]);
  const model=initializedModel||detectedModel||reportedModel||null;
  const serial=initialized?.[2]||bootSerial?.[1]||startup?.[1]||null;
  const address=startup?.[4]||parts[1]||null;
  const baudrate=startup?.[3]||parts[2]||null;
  const parity=parts[3]||null,stopBits=parts[4]||null;
  const successfulReads=(text.match(/KWH:AD\[[^\]]+\][^\r\n]*\bOK\b/gi)||[]).length;
  const timeouts=(text.match(/KWH:[^\r\n]*ERR\[TO\]/gi)||[]).length;
  const evidence=[initializedModel?'RS485-initialisatie met model en serienummer':null,reportedModel?'BootNotification met meterType en serienummer':null,successfulReads?`${successfulReads} geslaagde Modbus-uitlezingen`:null].filter(Boolean);
  return {model,serial,channel:initialized?.[1]||null,address,baudrate,parity,stopBits,successfulReads,timeouts,initializedModel,reportedModel,configured:meterDisplay(parts[0]),evidence,confidence:initializedModel&&serial&&successfulReads?'strong':model?'reported':'unknown'};
}

export function assessMeterIdentity(text,meterSetting,analysis=null){
  const configured=meterDisplay(String(meterSetting||'').split(',')[0]);
  const physical=extractMeterIdentity(text,meterSetting);
  const observed=[...new Set([physical.initializedModel,physical.reportedModel,physical.model].filter(Boolean))];
  const configuredKey=meterKey(configured),observedKeys=observed.map(meterKey);
  const mismatch=!!configuredKey&&observedKeys.length>0&&!observedKeys.includes(configuredKey);
  const confirmed=!!configuredKey&&observedKeys.includes(configuredKey);
  const timeouts=Number(analysis?.stats?.meterTimeouts||0);
  let level='warning',label='Niet bevestigd',detail='Het ingestelde metertype is bekend, maar de controllerlog noemt het fysieke metermodel niet.';
  if(!configured){label='Geen meterconfiguratie';detail='chg_KWH1 ontbreekt of bevat geen herkenbaar Eastron-model.';}
  if(confirmed){level='ok';label=physical.confidence==='strong'?'Meter actief uitgelezen':'Model bevestigd';detail=physical.confidence==='strong'?`${configured}, serienummer ${physical.serial}, antwoordt via Modbus (${physical.successfulReads} geslaagde uitlezingen).`:`De controllerlog noemt ${configured}; dit komt overeen met chg_KWH1.`;}
  if(mismatch){level='critical';label='Model komt niet overeen';detail=`Ingesteld: ${configured}. In de controllerlog waargenomen: ${observed.join(', ')}.`;}
  if(!observed.length&&timeouts){detail+=` Er zijn daarnaast ${timeouts} Modbus time-out${timeouts===1?'':'s'}, dus controleer model, adres en businstellingen op locatie.`;}
  return {configured,observed,confirmed,mismatch,level,label,detail,physical};
}

const lastMatch=(text,patterns)=>{
  for(const pattern of patterns){const matches=[...String(text||'').matchAll(pattern)];if(matches.length)return matches.at(-1)[1]?.trim()||null;}
  return null;
};

export function extractCellularIdentity(text){
  const source=String(text||'');
  const registrationCode=lastMatch(source,[/GSM\s+REG\s*:\s*(\d+)/gi,/NETWORK[_ ]REGISTRATION[^\r\n]*?(\d+)/gi]);
  const registration={'0':'Niet geregistreerd','1':'Geregistreerd op thuisnetwerk','2':'Netwerk zoeken','3':'Registratie geweigerd','4':'Status onbekend','5':'Geregistreerd via roaming'}[registrationCode]||null;
  return {
    modem:lastMatch(source,[/GSM\s+Modem\s*:\s*([^\r\n]+)/gi,/gsm_Model[^\r\n:=]*[:=]\s*([^,;\r\n]+)/gi]),
    imei:lastMatch(source,[/\bIMEI\s*[:=]?\s*\[?([0-9]{14,17})\]?/gi]),
    imsi:lastMatch(source,[/\bIMSI\s*[:=]?\s*\[?([0-9]{14,16})\]?/gi]),
    iccid:lastMatch(source,[/\b(?:ICCID|CCID)\s*[:=]?\s*\[?([0-9]{18,22})\]?/gi]),
    operator:lastMatch(source,[/\bgsm_Oper\s*[:=]\s*([0-9]{5,6})/gi]),
    signal:lastMatch(source,[/\b(?:SQ|CSQ)\s*[:=]\s*(\d{1,2})/gi,/\bgsm_SigQ\s*[:=]\s*(\d{1,2})/gi]),
    registrationCode,
    registration,
    registered:registrationCode==='1'||registrationCode==='5'||/NETWORK[_ ]REGISTRATION\s+DONE/i.test(source),
  };
}
