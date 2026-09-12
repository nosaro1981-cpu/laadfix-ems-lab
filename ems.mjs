// Simulation only. No charger commands or manufacturer register addresses here.
export const defaults = { mode: 'solar', pvW: 7500, homeW: [1000, 800, 700], phases: 3, limitA: 16, fuseA: 25, connected: true, meterOk: true, lampActive: false, lampLimitA: 6, simulatedChargers: 1 };
export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Ongeldige instellingen');
  for (const key of Object.keys(input)) if (!(key in defaults)) throw Error('Onbekende instelling: ' + key);
  if (!['off', 'solar', 'fast'].includes(input.mode)) throw Error('Kies een geldige laadmodus');
  for (const [key, min, max] of [['pvW', 0, 30000], ['limitA', 6, 32], ['fuseA', 16, 80], ['lampLimitA', 6, 32], ['simulatedChargers', 1, 4]]) {
    if (!Number.isFinite(input[key]) || input[key] < min || input[key] > max) throw Error('Ongeldige waarde voor ' + key);
  }
  if (![1, 3].includes(input.phases)) throw Error('Kies 1 of 3 fasen');
  if (!Number.isInteger(input.simulatedChargers)) throw Error('Kies een geheel aantal virtuele laders');
  if (!Array.isArray(input.homeW) || input.homeW.length !== 3 || input.homeW.some(w => !Number.isFinite(w) || w < 0 || w > 15000)) throw Error('Ongeldig huisverbruik');
  if (typeof input.connected !== 'boolean' || typeof input.meterOk !== 'boolean' || typeof input.lampActive !== 'boolean') throw Error('Ongeldige status');
  return structuredClone(input);
}
export function calculate(s, previousA = 0) {
  const voltage = 230;
  const baseW = s.homeW.map(w => w - s.pvW / 3);
  const active = s.phases === 1 ? [0] : [0, 1, 2];
  const marginA = 1;
  const capacityA = Math.max(0, Math.min(...active.map(i => s.fuseA - marginA - baseW[i] / voltage)));
  const surplusW = s.pvW - s.homeW.reduce((a, b) => a + b, 0);
  let reason = 'Laden binnen de ingestelde limieten';
  const chargerCount = s.simulatedChargers || 1;
  let desiredA = Math.min(s.limitA, capacityA / chargerCount);
  if (s.lampActive) desiredA = Math.min(desiredA, s.lampLimitA);
  if (s.mode === 'solar') desiredA = Math.min(desiredA, Math.max(0, surplusW) / (voltage * s.phases * chargerCount));
  desiredA = Math.floor(Math.max(0, desiredA) * 10 + 1e-8) / 10;
  if (s.mode === 'off') { desiredA = 0; reason = 'Handmatig gepauzeerd'; }
  else if (!s.connected) { desiredA = 0; reason = 'Geen auto aangesloten'; }
  else if (!s.meterOk) { desiredA = 0; reason = 'Meetgegevens ontbreken: regeling gepauzeerd'; }
  else if (capacityA < 6) { desiredA = 0; reason = 'Te weinig ruimte op een laadfase'; }
  else if (desiredA < 6 || (s.mode === 'solar' && previousA === 0 && surplusW < 6 * voltage * s.phases + 300)) {
    desiredA = 0; reason = 'Wachten op voldoende zonne-overschot';
  } else if (s.lampActive) reason = 'Lamp aan: laadstroom begrensd op '+s.lampLimitA+' A';
  else if (s.mode === 'solar') reason = 'Laden op zonne-overschot';
  const chargeW = desiredA * voltage * s.phases * chargerCount;
  const gridPhaseW = baseW.map((w, i) => w + (active.includes(i) ? desiredA * voltage * chargerCount : 0));
  return { desiredA, chargeW, gridW: gridPhaseW.reduce((a, b) => a + b, 0), gridPhaseA: gridPhaseW.map(w => w / voltage), surplusW, capacityA, reason, overloaded: gridPhaseW.some(w => Math.abs(w / voltage) > s.fuseA) };
}
export function createEngine() {
  let settings = structuredClone(defaults), actualA = 0, pendingSince = null, energyWh = 0, last = null;
  let history = [];
  function tick(now = Date.now()) {
    const result = calculate(settings, actualA);
    let reason = result.reason;
    if (result.desiredA === 0) { actualA = 0; pendingSince = null; }
    else if (actualA === 0) {
      if (pendingSince === null) pendingSince = now;
      if (now - pendingSince >= 5000) { actualA = result.desiredA; pendingSince = null; }
      else reason = 'Zonne-overschot / capaciteit controleren (' + Math.ceil((5000 - now + pendingSince) / 1000) + ' s)';
    } else actualA = result.desiredA;
    const chargerCount = settings.simulatedChargers || 1;
    const chargeW = actualA * 230 * settings.phases * chargerCount;
    if (last !== null) energyWh += chargeW * Math.max(0, Math.min(5, (now - last) / 1000)) / 3600;
    last = now;
    const gridPhaseA = settings.homeW.map((w, i) => (w - settings.pvW / 3) / 230 + ((settings.phases === 3 || i === 0) ? actualA * chargerCount : 0));
    const gridW = gridPhaseA.reduce((a, b) => a + b, 0) * 230;
    const point = { time: now, pvW: settings.pvW, homeW: settings.homeW.reduce((a,b)=>a+b,0), chargeW, gridW };
    history.push(point); history = history.slice(-120);
    return { settings, result: { ...result, actualA, chargeW, gridW, gridPhaseA, reason, energyWh, overloaded: gridPhaseA.some(a => Math.abs(a) > settings.fuseA) }, history, mode: 'simulation', liveControl: false };
  }
  return { tick, set: next => { const oldPhases = settings.phases; settings = validate(next); if (oldPhases !== settings.phases) { actualA = 0; pendingSince = null; } }, reset: () => { actualA = 0; energyWh = 0; history = []; pendingSince = null; last = null; } };
}

export function simulatedFleet(settings, result, count = 4) {
  const activeCount = settings.simulatedChargers || 1;
  const offered = Number(result.actualA || 0);
  const perChargerW = offered * 230 * settings.phases;
  const temperature = Math.round((27 + Math.min(16, perChargerW / 1400)) * 10) / 10;
  return Array.from({ length: count }, (_, index) => {
    const active = index < activeCount;
    return {
      id: `SIM-${String(index + 1).padStart(2, '0')}`,
      status: !active ? 'Stand-by' : offered >= 6 ? 'Charging' : settings.connected ? 'Preparing' : 'Available',
      offeredA: active ? offered : 0,
      measuredA: active ? offered : 0,
      powerW: active ? perChargerW : 0,
      energyWh: active ? Number(result.energyWh || 0) / activeCount : 0,
      temperature: active ? temperature : 27,
      frequency: 50
    };
  });
}
