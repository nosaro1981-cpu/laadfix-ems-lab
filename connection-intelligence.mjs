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
  if(!charger.chargerConnected)score-=45;if(!charger.backendConnected)score-=35;
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
  const findings=[];
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
  return {score,stats,facts,timeline,findings,analyzedAt:new Date().toISOString()};
}

const canonicalMeter=value=>{
  const text=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const match=text.match(/SDM(?:72D|630|230|120)/);
  return match?.[0]||null;
};

export function assessMeterIdentity(text,meterSetting,analysis=null){
  const configured=canonicalMeter(String(meterSetting||'').split(',')[0]);
  const observed=[...new Set([...String(text||'').matchAll(/\bSDM(?:72D|630|230|120)\b/gi)].map(match=>canonicalMeter(match[0])).filter(Boolean))];
  const mismatch=!!configured&&observed.length>0&&!observed.includes(configured);
  const confirmed=!!configured&&observed.includes(configured);
  const timeouts=Number(analysis?.stats?.meterTimeouts||0);
  let level='warning',label='Niet bevestigd',detail='Het ingestelde metertype is bekend, maar de controllerlog noemt het fysieke metermodel niet.';
  if(!configured){label='Geen meterconfiguratie';detail='chg_KWH1 ontbreekt of bevat geen herkenbaar Eastron-model.';}
  if(confirmed){level='ok';label='Model bevestigd';detail=`De controllerlog noemt ${configured}; dit komt overeen met chg_KWH1.`;}
  if(mismatch){level='critical';label='Model komt niet overeen';detail=`Ingesteld: ${configured}. In de controllerlog waargenomen: ${observed.join(', ')}.`;}
  if(!observed.length&&timeouts){detail+=` Er zijn daarnaast ${timeouts} Modbus time-out${timeouts===1?'':'s'}, dus controleer model, adres en businstellingen op locatie.`;}
  return {configured,observed,confirmed,mismatch,level,label,detail};
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
