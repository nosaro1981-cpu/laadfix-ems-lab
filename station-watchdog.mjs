const age=(time,now)=>time?Math.max(0,now-Date.parse(time)):Infinity;
const number=value=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
const setting=(configuration,key)=>configuration.find(row=>row.key===key)?.value??null;

export function auditStation(station,diagnostic=null,now=Date.now()){
  const configuration=Array.isArray(station?.configuration)?station.configuration:[];
  const history=Array.isArray(station?.meterHistory)?station.meterHistory:[];
  const findings=[];
  const add=(level,code,title,detail,repair=null)=>findings.push({level,code,title,detail,repair});
  const meterRaw=setting(configuration,'chg_KWH1');
  const meterType=meterRaw?String(meterRaw).split(',')[0]:null;
  const meterAge=age(station?.lastMeterValues,now);
  const sampleInterval=number(setting(configuration,'MeterValueSampleInterval'));
  const clockInterval=number(setting(configuration,'ClockAlignedDataInterval'));
  const sampledData=setting(configuration,'MeterValuesSampledData');
  const profiles=setting(configuration,'SupportedFeatureProfiles');

  if(!configuration.length)add('warning','CONFIG_UNKNOWN','Configuratie nog niet gecontroleerd','Haal GetConfiguration op om meter-, communicatie- en laadinstellingen te controleren.');
  else{
    if(!meterRaw)add('critical','METER_CONFIG_MISSING','Energiemeter ontbreekt in configuratie','chg_KWH1 is niet teruggekomen uit de laadcontroller.');
    else if(/^none(?:,|$)/i.test(meterRaw))add('critical','METER_DISABLED','Energiemeter staat uit','chg_KWH1 staat op None; transacties kunnen daardoor zonder bruikbare kWh-stand eindigen.');
    if(sampleInterval===null)add('warning','SAMPLE_UNKNOWN','Meetinterval onbekend','MeterValueSampleInterval ontbreekt in de uitgelezen configuratie.');
    else if(sampleInterval<=0)add('critical','SAMPLE_DISABLED','Periodieke meterwaarden staan uit','Zet MeterValueSampleInterval op 60 seconden.',{key:'MeterValueSampleInterval',value:'60'});
    else if(sampleInterval>120)add('warning','SAMPLE_SLOW','Meterwaarden komen te langzaam','Het sample-interval is '+sampleInterval+' seconden; storingen en vermogenswijzigingen worden laat zichtbaar.',{key:'MeterValueSampleInterval',value:'60'});
    if(clockInterval!==null&&clockInterval>300)add('warning','CLOCK_SLOW','Uitgelijnde meterwaarden komen langzaam','ClockAlignedDataInterval staat op '+clockInterval+' seconden.',{key:'ClockAlignedDataInterval',value:'60'});
    if(sampledData&&!/Energy\.Active\.Import\.Register/i.test(sampledData))add('critical','ENERGY_NOT_SAMPLED','Energiestand ontbreekt in MeterValues','Voeg Energy.Active.Import.Register toe aan MeterValuesSampledData.');
    if(sampledData&&!/Current\.Import/i.test(sampledData))add('warning','CURRENT_NOT_SAMPLED','Laadstroom ontbreekt in MeterValues','Voeg Current.Import per fase toe om laadprofielen te kunnen controleren.');
    if(profiles&&!/SmartCharging/i.test(profiles))add('warning','NO_SMART_CHARGING','Smart Charging niet gemeld','Deze controller meldt geen SmartCharging-profiel; EMS-laadlimieten kunnen worden geweigerd.');
  }

  if(station?.activeTransaction&&meterAge>120_000)add('critical','METER_STALE','Geen actuele meterwaarden tijdens laden','De sessie loopt, maar de laatste MeterValues zijn ouder dan twee minuten. Vraag meterwaarden op en controleer daarna de Modbus-meter.');
  else if(station?.chargerConnected&&meterAge>15*60_000)add('warning','METER_OLD','Meterwaarden zijn verouderd','De laatste meting is ouder dan vijftien minuten. Vraag een nieuwe MeterValues aan.');

  const chronological=[...history].filter(row=>row?.energy&&Number.isFinite(Number(row.energy.value))).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const first=chronological[0],last=chronological.at(-1);
  const energyDelta=first&&last?Number(last.energy.value)-Number(first.energy.value):null;
  const spanMs=first&&last?Date.parse(last.time)-Date.parse(first.time):0;
  const latestCurrent=number(history[0]?.currentL1?.value);
  if(station?.activeTransaction&&spanMs>=90_000&&energyDelta!==null&&energyDelta<=0)add('critical','ENERGY_FROZEN','kWh-stand loopt niet op','De laadsessie is actief, maar de energiestand veranderde niet in '+Math.round(spanMs/60_000)+' minuten. Controleer metertype, Modbus-adres en bedrading.');
  if(station?.activeTransaction&&latestCurrent!==null&&latestCurrent<0.2)add('warning','ZERO_CURRENT','Laadsessie zonder gemeten stroom','De sessie is actief maar de laatst gemeten stroom is '+latestCurrent.toFixed(2)+' A. Controleer voertuigstatus, relais en meterconfiguratie.');

  const meterAssessment=diagnostic?.meterAssessment;
  if(meterAssessment?.mismatch)add('critical','METER_MODEL_MISMATCH','Fysieke meter wijkt af van configuratie',meterAssessment.detail);
  else if(meterAssessment?.confirmed)add('ok','METER_CONFIRMED','Metermodel bevestigd',meterAssessment.detail);

  if(!findings.some(item=>item.level!=='ok'))add('ok','WATCHDOG_OK','Geen afwijking gevonden','Configuratie, meterstroom en actuele OCPP-status geven geen direct storingssignaal.');
  let score=100;
  for(const item of findings){if(item.level==='critical')score-=28;else if(item.level==='warning')score-=10;}
  score=Math.max(0,score);
  const critical=findings.filter(item=>item.level==='critical').length,warnings=findings.filter(item=>item.level==='warning').length;
  return{score,status:critical?'critical':warnings?'warning':'ok',label:critical?`${critical} kritieke afwijking${critical===1?'':'en'}`:warnings?`${warnings} aandachtspunt${warnings===1?'':'en'}`:'Controle geslaagd',findings,meter:{configured:meterRaw,type:meterType,lastValuesAt:station?.lastMeterValues||null,ageMs:Number.isFinite(meterAge)?meterAge:null,latestCurrentA:latestCurrent,energyDelta,historySpanMs:spanMs},configuration:{loaded:!!configuration.length,updatedAt:station?.configurationUpdatedAt||null,sampleInterval,clockInterval},generatedAt:new Date(now).toISOString()};
}
