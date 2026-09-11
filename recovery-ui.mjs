const $ = id => document.getElementById(id);
const node = (tag, text, className) => Object.assign(document.createElement(tag), { textContent: text || '', className: className || '' });
const labels = { running: 'Bezig', ok: 'Afgerond', warning: 'Controle nodig', error: 'Niet geslaagd' };
let snapshot = null, fullState = null, chosenStation = '', chosenConnector = 1, chosenJob = null, error = '', starting = false, pending = null;
let actionSignature = '', reportSignature = '', historySignature = '';

const selected = () => snapshot?.stations?.find(s => s.id === chosenStation);
const scopedJobs = () => (snapshot?.jobs || []).filter(j => j.stationId === chosenStation && j.connectorId === chosenConnector);
const displayedJob = () => scopedJobs().find(j => j.id === chosenJob) || scopedJobs()[0];
const time = value => new Date(value).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function setOptions(select, entries, value) {
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...entries.map(([key, label]) => { const option = node('option', label); option.value = String(key); return option; }));
    select.dataset.options = signature;
  }
  select.value = String(value);
}

async function start(action, target = { id: chosenStation, connectorId: chosenConnector }) {
  if (starting || snapshot?.jobs.some(j => j.status === 'running')) return;
  error = ''; starting = true; chosenJob = null; paint();
  try {
    const response = await fetch('/api/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...target, action }) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Opdracht niet gestart.');
    chosenJob = result.job.id;
    snapshot.jobs.unshift(result.job);
  } catch (e) { error = e.message; }
  finally { starting = false; paint(); }
}

function choose(action) {
  const spec = snapshot.actions[action];
  if (!spec.changes) { start(action); return; }
  pending = { action, target: { id: chosenStation, connectorId: chosenConnector } };
  $('recoveryConfirmTitle').textContent = spec.title;
  $('recoveryConfirmTarget').textContent = spec.scope === 'station' ? `Laadstation ${chosenStation} · effect op het hele station` : `Laadstation ${chosenStation} · connector ${chosenConnector}`;
  $('recoveryConfirmDetail').textContent = spec.description;
  $('recoveryConfirm').showModal();
}

function buildActions() {
  const signature = JSON.stringify(snapshot.actions);
  if (signature === actionSignature) return;
  actionSignature = signature;
  $('recoveryChecks').replaceChildren(); $('recoveryFixes').replaceChildren();
  const icons = { network: '⇄', status: '◎', meter: '▥', configuration: '⚙', grid: '⌘', diagnostics: '↓', operative: '✓', softReset: '↻', unlock: '⌑', clearCache: '▤', clearTestProfile: '↯', meterInterval: '◷' };
  for (const [key, spec] of Object.entries(snapshot.actions)) {
    if (key === 'analyze') continue;
    const button = node('button', '', 'recovery-action'); button.type = 'button'; button.dataset.recoveryAction = key;
    const icon = node('span', icons[key], 'recovery-icon'); icon.setAttribute('aria-hidden', 'true');
    const copy = node('span', '', 'recovery-action-copy');
    copy.append(node('strong', spec.title), node('span', spec.description));
    if (spec.scope) copy.append(node('small', spec.scope === 'station' ? 'Hele station' : 'Gekozen connector', 'recovery-scope'));
    button.append(icon, copy, node('span', '›', 'recovery-arrow'));
    button.addEventListener('click', () => choose(key));
    $(spec.changes ? 'recoveryFixes' : 'recoveryChecks').append(button);
  }
}

function paintReport() {
  const job = displayedJob(), report = fullState?.diagnostics?.[chosenStation];
  const signature = JSON.stringify({ job, error, starting, blocked: selected()?.blockedReason, busy: snapshot.jobs.some(j => j.status === 'running'), report: job?.action === 'diagnostics' ? report : null, uploadLate: job?.action === 'diagnostics' && report?.requestedAt && Date.now() - Date.parse(report.requestedAt) > 5 * 60000 });
  if (signature === reportSignature) return;
  reportSignature = signature;
  const box = $('recoveryResult'); box.replaceChildren();
  const state = $('recoveryRunState');
  state.textContent = starting ? 'Opdracht starten…' : job ? labels[job.status] : 'Nog niet gestart';
  state.className = job ? job.status : '';
  if (error) box.append(node('p', error, 'recovery-error'));
  if (!job) {
    box.append(node('p', starting ? 'Opdracht wordt klaargezet…' : 'Begin met de diagnose of kies een gerichte controle. Hier blijven de stappen, antwoorden en aandachtspunten staan.', 'recovery-empty'));
    $('recoveryExport').disabled = true; return;
  }
  box.append(node('h3', job.title), node('p', `${job.stationId} · connector ${job.connectorId} · ${time(job.startedAt)}`, 'recovery-job-meta'));
  const list = node('ol', '', 'recovery-steps');
  for (const step of job.steps) {
    const li = node('li', '', step.status), badge = node('span', step.status === 'running' ? '…' : step.status === 'ok' ? '✓' : '!', 'recovery-step-icon');
    badge.setAttribute('aria-hidden', 'true');
    const detail = node('div'); detail.append(node('strong', step.title), node('span', labels[step.status], 'recovery-step-state'), node('p', step.detail));
    li.append(badge, detail); list.append(li);
  }
  box.append(list);
  if (job.action === 'diagnostics' && report) {
    const isCurrent = Date.parse(report.requestedAt) >= Date.parse(job.startedAt);
    if (isCurrent) {
      const status = node('div', '', 'recovery-upload');
      status.append(node('strong', report.status === 'Ontvangen' ? 'Diagnosebestand ontvangen' : report.status === 'Mislukt' ? 'Upload niet geslaagd' : 'Wachten op het diagnosebestand'));
      status.append(node('p', `Bestand: ${report.fileName || 'nog niet gemeld'}\n${report.bytes ? report.bytes + ' bytes ontvangen' : 'Nog geen bestand ontvangen door het lab.'}${report.error ? '\n' + report.error : ''}`));
      if (report.status !== 'Ontvangen' && report.status !== 'Mislukt' && Date.now() - Date.parse(report.requestedAt) > 5 * 60000) status.append(node('p', 'Al meer dan vijf minuten geen bestand ontvangen. Controleer het uploadadres en de overdracht; de oorzaak is nog niet vastgesteld.'));
      box.append(status);
    }
  }
  if (job.recommendation && snapshot.actions[job.recommendation]) {
    const button = node('button', snapshot.actions[job.recommendation].title, 'recovery-primary');
    button.disabled = !!selected()?.blockedReason || snapshot.jobs.some(j => j.status === 'running');
    button.addEventListener('click', () => choose(job.recommendation)); box.append(button);
  }
  $('recoveryExport').disabled = job.status === 'running';
}

function paint() {
  if (!snapshot) return;
  const stations = snapshot.stations || [];
  if (!stations.some(s => s.id === chosenStation)) { chosenStation = stations[0]?.id || ''; chosenJob = null; }
  const station = selected(), connectors = station?.connectorIds || [1];
  if (!connectors.includes(chosenConnector)) { chosenConnector = connectors[0]; chosenJob = null; }
  setOptions($('recoveryStation'), stations.length ? stations.map(s => [s.id, s.id]) : [['', 'Geen laadstations aangemeld']], chosenStation);
  setOptions($('recoveryConnector'), connectors.map(id => [id, `Connector ${id}`]), chosenConnector);
  const busy = starting || snapshot.jobs.some(j => j.status === 'running');
  $('recoveryStation').disabled = busy; $('recoveryConnector').disabled = busy;
  const connection = $('recoveryConnection');
  connection.textContent = station ? `Lader: ${station.chargerConnected ? 'verbonden' : 'offline'} · backoffice: ${station.backendConnected ? 'verbonden' : 'offline'}\nConnector ${chosenConnector}: ${station.connectors?.[chosenConnector]?.status || (chosenConnector === 1 ? station.status : '') || 'onbekend'}` : 'Wacht op een aanmelding bij deze proxy.';
  $('recoveryGuard').textContent = station?.blockedReason || 'Kies een actie om het effect en de bestemming te controleren vóór verzending.';
  $('recoveryGuard').classList.toggle('blocked', !!station?.blockedReason);
  $('recoveryAnalyze').disabled = !station || busy;
  $('recoveryAnalyze').textContent = busy ? 'Controle of actie loopt…' : 'Diagnose + hersteladvies';
  $('recoveryStationLink').href = chosenStation ? '#/stations/' + encodeURIComponent(chosenStation) : '#/stations';
  buildActions();
  document.querySelectorAll('[data-recovery-action]').forEach(button => {
    const action = button.dataset.recoveryAction, spec = snapshot.actions[action];
    const reason = !station ? 'Geen station geselecteerd.' : busy ? 'Wacht tot de huidige actie is afgerond.' : spec.changes && station.blockedReason ? station.blockedReason : !station.chargerConnected && action !== 'network' ? 'Deze controle vereist een OCPP-verbinding.' : '';
    button.disabled = !!reason; button.title = reason || spec.description;
  });
  paintReport();
  const jobs = scopedJobs().slice(0, 8), sig = JSON.stringify(jobs.map(j => [j.id, j.status, chosenJob]));
  if (sig !== historySignature) {
    historySignature = sig;
    $('recoveryHistory').replaceChildren(...jobs.map(job => {
      const button = node('button', `${time(job.startedAt)} · ${job.title}\n${labels[job.status]}`);
      button.className = job.id === displayedJob()?.id ? 'selected' : '';
      button.addEventListener('click', () => { chosenJob = job.id; paint(); }); return button;
    }));
    if (!jobs.length) $('recoveryHistory').append(node('p', 'Nog geen acties op deze connector.'));
  }
}

export function renderRecoveryCenter(state) {
  fullState = state;
  if (!state.recovery) { $('recoveryConnection').textContent = 'De nieuwe herstelservice is nog niet geladen. Start de bijgewerkte dashboardservice.'; $('recoveryAnalyze').disabled = true; return; }
  snapshot = state.recovery; paint();
}
$('recoveryStation').addEventListener('change', e => { chosenStation = e.target.value; chosenConnector = 1; chosenJob = null; error = ''; paint(); });
$('recoveryConnector').addEventListener('change', e => { chosenConnector = Number(e.target.value); chosenJob = null; error = ''; paint(); });
$('recoveryAnalyze').addEventListener('click', () => start('analyze'));
$('recoveryConfirm').addEventListener('close', () => { const request = pending; pending = null; if ($('recoveryConfirm').returnValue === 'send' && request) start(request.action, request.target); });
$('recoveryExport').addEventListener('click', () => {
  const job = displayedJob(); if (!job) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `laadfix-herstel-${job.stationId.replace(/[^a-z0-9_-]/gi, '_')}-${job.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
