const ACTIVE = new Set(['Preparing','Charging','SuspendedEV','SuspendedEVSE','Finishing']);

export function recoveryDecision(charger, {now=Date.now(), offlineSince=null, configured=false}={}) {
  const status=charger?.effectiveStatus||charger?.status||'Onbekend';
  const active=!!charger?.activeTransaction||ACTIVE.has(status);
  const offlineMs=!charger?.chargerConnected&&offlineSince!==null?Math.max(0,now-offlineSince):0;
  const base={configured,automatic:false,offlineSince:offlineSince===null?null:new Date(offlineSince).toISOString(),offlineSeconds:Math.floor(offlineMs/1000),minimumOfflineSeconds:300,offSeconds:25,activeTransaction:active};
  if(active)return {...base,stage:'blocked',ready:false,label:'Geblokkeerd tijdens laden',advice:'Een voedingherstart is tijdens een actieve of startende laadsessie niet toegestaan.'};
  if(charger?.chargerConnected&&!charger?.backendConnected)return {...base,stage:'upstream',ready:false,label:'Alleen backoffice offline',advice:'Herstel internet, DNS of de proxy. De Homebox herstarten helpt hier niet.'};
  if(charger?.chargerConnected)return {...base,stage:'ocpp',ready:false,label:'OCPP-herstel beschikbaar',advice:'Vraag eerst status op en gebruik zo nodig een OCPP soft reset.'};
  if(offlineMs<300000)return {...base,stage:'waiting',ready:false,label:'Wachten vóór fysieke herstart',advice:`Nog ${Math.ceil((300000-offlineMs)/1000)} seconden observeren om een korte netwerkonderbreking uit te sluiten.`};
  if(!configured)return {...base,stage:'relay-needed',ready:false,label:'Stuurrelais nog niet gekoppeld',advice:'De veilige herstarttrap is bereikt. Koppel eerst een potentiaalvrij stuurrelais aan een passend geïnstalleerde contactor of een door Ecotap toegestane reset-/stuurvoeding.'};
  return {...base,stage:'ready',ready:true,label:'Fysieke herstart gereed',advice:'Schakel de stuuruitgang 25 seconden uit en daarna weer in. Controleer vervolgens BootNotification en StatusNotification.'};
}

export function createRecoveryMonitor({configured=false}={}) {
  let offlineSince=null;
  return {
    observe(charger,now=Date.now()){
      if(charger?.chargerConnected)offlineSince=null;
      else if(offlineSince===null)offlineSince=now;
      return recoveryDecision(charger,{now,offlineSince,configured});
    },
    snapshot(charger,now=Date.now()){return recoveryDecision(charger,{now,offlineSince,configured});}
  };
}
