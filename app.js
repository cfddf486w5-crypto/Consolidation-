const DB_KEY = 'dlwms_db_v1';
const navItems = [
  ['dashboard', 'Accueil'],
  ['v2', 'V2 - Import + <20'],
  ['scan', 'Scan Info'],
  ['consolidation', 'Consolidation'],
  ['shipping', 'Suivi expédition'],
  ['remise', 'Remise en stock'],
  ['history', 'Historique'],
  ['settings', 'Paramètres'],
];

const defaults = {
  datasets: { inventory: [], reception: [], locations: [], consolidated: [] },
  mappings: { inventory: null, reception: null, locations: null },
  logs: [],
  shipping: [],
  remise: { drafts: [], archives: [] },
  notes: {},
  settings: { threshold: 20, scan: { sound: false, vibration: false, autofocus: true, camera: false }, theme: 'dark' },
  history: [],
  importsMeta: { inventoryAt: null, receptionAt: null },
};

let state = loadState();
let currentView = 'dashboard';

function loadState() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) return structuredClone(defaults);
  try { return { ...structuredClone(defaults), ...JSON.parse(raw) }; }
  catch { return structuredClone(defaults); }
}
function saveState() { localStorage.setItem(DB_KEY, JSON.stringify(state)); renderDataStatus(); }
function log(action, payload = {}) {
  const row = { action, payload, at: new Date().toISOString() };
  state.history.unshift(row);
  state.logs.unshift(`${new Date().toLocaleString('fr-CA')}: ${action} ${JSON.stringify(payload)}`);
  state.logs = state.logs.slice(0, 300);
  saveState();
}
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
function detectMapping(headers) {
  const map = {};
  const targets = {
    item: ['sku', 'item', 'itemid', 'part', 'code'],
    qty: ['qty', 'quantity', 'qtyoh', 'onhand', 'qte'],
    bin: ['bin', 'location', 'userbinid', 'locationname'],
    description: ['desc', 'shortdesc', 'displayline', 'description'],
    type: ['type', 'locationtype', 'bintype'],
  };
  headers.forEach((h) => {
    const n = norm(h);
    Object.entries(targets).forEach(([k, arr]) => { if (!map[k] && arr.includes(n)) map[k] = h; });
  });
  return map;
}
function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      const escaped = inQuotes && line[i + 1] === '"';
      if (escaped) {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
    return row;
  });
}
async function parseFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return parseCSV(await file.text());
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    if (!window.XLSX) throw new Error('Librairie XLSX indisponible');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  }
  throw new Error('Format non supporté');
}
function pickOrAskMapping(type, rows) {
  const headers = Object.keys(rows[0] || {});
  let mapping = state.mappings[type] || detectMapping(headers);
  const requiresItemQty = type !== 'locations';
  if ((requiresItemQty && (!mapping.item || !mapping.qty)) || (!requiresItemQty && !mapping.bin)) {
    mapping = { ...mapping };
    ['item', 'qty', 'bin', 'description', 'type'].forEach((key) => {
      if (!mapping[key]) {
        const choice = prompt(`Mapping requis (${type}) : choisir colonne pour ${key}\nColonnes: ${headers.join(', ')}`);
        if (choice && headers.includes(choice)) mapping[key] = choice;
      }
    });
  }
  state.mappings[type] = mapping;
  saveState();
  return mapping;
}
function sanitizeRows(type, rows) {
  if (!rows.length) return [];
  const mapping = pickOrAskMapping(type, rows);
  const list = [];

  if (type === 'locations') {
    for (const r of rows) {
      const bin = String(r[mapping.bin] || '').trim().toUpperCase();
      if (!bin) continue;
      list.push({ bin, type: String(r[mapping.type] || '').trim() });
    }
    return list;
  }

  for (const r of rows) {
    const item = String(r[mapping.item] || '').trim().toUpperCase();
    if (!item) continue;
    const qtyRaw = r[mapping.qty];
    const qty = Number(qtyRaw);
    if (Number.isNaN(qty)) log('Qty non numérique', { type, item, qtyRaw });
    list.push({
      item,
      qty: Number.isNaN(qty) ? 0 : qty,
      bin: String(r[mapping.bin] || '').trim().toUpperCase(),
      description: String(r[mapping.description] || '').trim(),
      type: String(r[mapping.type] || '').trim(),
    });
  }
  return list;
}
function consolidate() {
  const byItem = new Map();
  const inv = state.datasets.inventory;
  const rec = state.datasets.reception;
  const locType = new Map(state.datasets.locations.map((l) => [norm(l.bin), l.type || '']));
  const seed = (row, source) => {
    if (!byItem.has(row.item)) byItem.set(row.item, { item: row.item, description: row.description || '', qty_inventaire_total: 0, qty_reception_total: 0, qty_total: 0, liste_bins_inventaire: [], liste_bins_reception: [], location_types: new Set() });
    const x = byItem.get(row.item);
    if (!x.description && row.description) x.description = row.description;
    if (source === 'inventory') {
      x.qty_inventaire_total += row.qty;
      x.liste_bins_inventaire.push({ bin: row.bin || '-', qty: row.qty });
    } else {
      x.qty_reception_total += row.qty;
      x.liste_bins_reception.push({ bin: row.bin || '-', qty: row.qty });
    }
    x.qty_total = x.qty_inventaire_total + x.qty_reception_total;
    const t = locType.get(norm(row.bin));
    if (t) x.location_types.add(t);
  };
  inv.forEach((r) => seed(r, 'inventory'));
  rec.forEach((r) => seed(r, 'reception'));
  const arr = [...byItem.values()]
    .map((x) => ({ ...x, location_types: [...x.location_types].filter(Boolean).join(', ') }))
    .filter((x) => !(x.qty_inventaire_total === 0 && x.qty_reception_total === 0))
    .filter((x) => x.qty_total !== 0);
  state.datasets.consolidated = arr;
  saveState();
  renderV2();
}
function csvFromRows(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}
function dl(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = navItems.map(([k, l]) => `<button class="nav-btn ${currentView === k ? 'active' : ''}" data-view="${k}">${l}</button>`).join('');
  nav.querySelectorAll('button').forEach((b) => { b.onclick = () => switchView(b.dataset.view); });
}
function switchView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
  document.getElementById(`view-${v}`).classList.add('active');
  const labels = Object.fromEntries(navItems);
  document.getElementById('pageTitle').textContent = labels[v];
  document.getElementById('pageSubtitle').textContent = v === 'v2' ? 'Import Inventaire + Réception → Liste <20' : 'DL WMS local';
  renderNav();
  if (v === 'scan') setTimeout(() => document.getElementById('scanInput')?.focus(), 10);
}
function renderDataStatus() {
  const inv = state.datasets.inventory.length;
  const rec = state.datasets.reception.length;
  const total = state.datasets.consolidated.length;
  document.getElementById('dataStatus').innerHTML = `
  <span>Inventaire: ${inv ? `✅ ${inv} lignes` : '❌ non chargé'}</span>
  <span>Réception: ${rec ? `✅ ${rec} lignes` : '❌ non chargée'}</span>
  <span>Consolidé: ${total} items</span>
  <span>Dernier import inv: ${state.importsMeta.inventoryAt ? new Date(state.importsMeta.inventoryAt).toLocaleString('fr-CA') : '-'}</span>`;
}
function renderDashboard() {
  const el = document.getElementById('view-dashboard');
  el.innerHTML = `<div class="grid cards">${[
    ['v2', 'V2 – Import Inventaire + Réception → Liste <20'], ['scan', 'Scan Info (Item/Bin)'], ['consolidation', 'Consolidation'], ['shipping', 'Suivi expédition Langelier'], ['remise', 'Remise en stock Laval'], ['history', 'Historique / Archives'], ['settings', 'Paramètres'],
  ].map(([k, t]) => `<article class="card"><h3>${t}</h3><p>Accès rapide au module.</p><div class="row" style="margin-top:10px;"><button class="btn" data-go="${k}">Ouvrir</button></div></article>`).join('')}</div>`;
  el.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => switchView(b.dataset.go); });
}
function renderV2() {
  const th = state.settings.threshold ?? 20;
  const all = state.datasets.consolidated;
  const move = all.filter((x) => x.qty_total < th);
  const excludedZero = [...new Set([...state.datasets.inventory, ...state.datasets.reception].map((r) => r.item))].length - all.length;
  const el = document.getElementById('view-v2');
  el.innerHTML = `
  <div class="card">
    <h3>Import fichiers</h3>
    <div class="row">
      <div><label>Inventaire <input type="file" id="invFile" accept=".csv,.xlsx,.xls" /></label></div>
      <div><label>Réception <input type="file" id="recFile" accept=".csv,.xlsx,.xls" /></label></div>
      <div><label>Locations/Types (optionnel) <input type="file" id="locFile" accept=".csv,.xlsx,.xls" /></label></div>
      <button class="btn btn-secondary" id="runConso">Consolider</button>
    </div>
  </div>
  <div class="card"><h3>Résumé</h3>
    <div class="kpis">
      <div class="kpi"><div>Items inventaire</div><div class="v">${new Set(state.datasets.inventory.map((x) => x.item)).size}</div></div>
      <div class="kpi"><div>Items réception</div><div class="v">${new Set(state.datasets.reception.map((x) => x.item)).size}</div></div>
      <div class="kpi"><div>Items total</div><div class="v">${all.length}</div></div>
      <div class="kpi"><div>Items &lt;${th}</div><div class="v">${move.length}</div></div>
      <div class="kpi"><div>Exclus (0 total)</div><div class="v">${Math.max(0, excludedZero)}</div></div>
    </div>
  </div>
  <details class="details card" open><summary>Règles de calcul</summary>
    <ul><li>Grouper par item.</li><li>qty_total = inventaire + réception.</li><li>Exclure qty_total = 0.</li><li>Liste à déplacer: qty_total &lt; ${th}.</li><li>Si inv=0 et réception&gt;0, inclure.</li></ul>
  </details>
  <details class="details card" open><summary>Tableau À déplacer (&lt;${th})</summary>
    <div class="row no-print"><button class="btn" id="expCsvMove">Export CSV</button><button class="btn" id="expXlsx">Export Excel</button><button class="btn" id="printMove">Export PDF/Imprimer</button></div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Description</th><th>Inv</th><th>Réception</th><th>Total</th><th>Bins inv</th><th>Bins rec</th><th>Types location</th><th>Détails</th></tr></thead><tbody>
      ${move.map((r, i) => `<tr><td>${r.item}</td><td>${r.description}</td><td>${r.qty_inventaire_total}</td><td>${r.qty_reception_total}</td><td><span class="badge big ${r.qty_total < 10 ? 'danger' : 'warn'}">${r.qty_total}</span></td><td>${r.liste_bins_inventaire.map((b) => `${b.bin} (${b.qty})`).join(', ')}</td><td>${r.liste_bins_reception.map((b) => `${b.bin} (${b.qty})`).join(', ')}</td><td>${r.location_types || '-'}</td><td><button class="btn" data-detail="${i}">Détails</button></td></tr>`).join('')}
    </tbody></table></div>
  </details>
  <details class="details card"><summary>Tableau Tous les items consolidés</summary>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Description</th><th>Inv</th><th>Réception</th><th>Total</th></tr></thead><tbody>${all.map((r) => `<tr><td>${r.item}</td><td>${r.description}</td><td>${r.qty_inventaire_total}</td><td>${r.qty_reception_total}</td><td>${r.qty_total}</td></tr>`).join('')}</tbody></table></div>
  </details>
  <details class="details card"><summary>Logs / erreurs d'import</summary><div class="logs">${state.logs.map((l) => `<div>${l}</div>`).join('')}</div></details>
  <div class="modal" id="detailModal"><div class="modal-body card"></div></div>`;

  document.getElementById('runConso').onclick = consolidate;
  const bindImport = (id, type) => {
    const inp = document.getElementById(id);
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const rows = await parseFile(f);
        state.datasets[type] = sanitizeRows(type, rows);
        state.importsMeta[`${type}At`] = new Date().toISOString();
        log(`Import ${type}`, { file: f.name, rows: rows.length });
        consolidate();
      } catch (e) {
        log('Erreur import', { type, message: e.message });
        alert(e.message);
      }
    };
  };
  bindImport('invFile', 'inventory');
  bindImport('recFile', 'reception');
  bindImport('locFile', 'locations');
  document.getElementById('expCsvMove').onclick = () => { dl('A_DEPLACER_LT20.csv', csvFromRows(move)); log('Export CSV V2', { rows: move.length }); };
  document.getElementById('expXlsx').onclick = () => {
    if (!window.XLSX) return alert('XLSX indisponible');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(move), 'A_DEPLACER_LT20');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(all), 'CONSOLIDE_COMPLET');
    XLSX.writeFile(wb, 'DL_WMS_V2.xlsx');
    log('Export Excel V2', { rowsMove: move.length, rowsAll: all.length });
  };
  document.getElementById('printMove').onclick = () => { log('Export PDF V2', { scope: 'A_DEPLACER' }); window.print(); };
  el.querySelectorAll('[data-detail]').forEach((b) => {
    b.onclick = () => {
      const r = move[Number(b.dataset.detail)];
      const modal = document.getElementById('detailModal');
      const notes = state.notes[r.item] || '';
      modal.querySelector('.modal-body').innerHTML = `<h3>Détail ${r.item}</h3>
      <div class="row"><span class="badge">Inv: ${r.qty_inventaire_total}</span><span class="badge">Réception: ${r.qty_reception_total}</span><span class="badge big">Total: ${r.qty_total}</span></div>
      <h4>Bins inventaire (tri qty desc)</h4><ul>${[...r.liste_bins_inventaire].sort((a, b) => b.qty - a.qty).map((x) => `<li>${x.bin}: ${x.qty}</li>`).join('')}</ul>
      <h4>Bins réception (tri qty desc)</h4><ul>${[...r.liste_bins_reception].sort((a, b) => b.qty - a.qty).map((x) => `<li>${x.bin}: ${x.qty}</li>`).join('')}</ul>
      <label>Notes <textarea id="noteArea">${notes}</textarea></label>
      <div class="row"><button class="btn" id="saveNote">Sauvegarder note</button><button class="btn btn-ghost" id="closeModal">Fermer</button></div>`;
      modal.classList.add('active');
      modal.querySelector('#saveNote').onclick = () => { state.notes[r.item] = modal.querySelector('#noteArea').value; saveState(); modal.classList.remove('active'); };
      modal.querySelector('#closeModal').onclick = () => modal.classList.remove('active');
    };
  });
}
function renderScan() {
  const el = document.getElementById('view-scan');
  el.innerHTML = `<div class="card"><h3>Scan Info</h3>
  <div class="row"><label style="max-width:220px;">Mode<select id="scanMode"><option value="item">Scan ITEM</option><option value="bin">Scan BIN</option></select></label>
  <label style="flex:1;">Scan<input id="scanInput" placeholder="Scanner puis Entrée"/></label>
  <button class="btn" id="scanGo">Valider</button><button class="btn" id="scanCopy">Copier résultat</button><button class="btn" id="scanPdf">Export PDF</button><button class="btn btn-ghost" id="scanClear">Clear</button></div>
  <div id="scanOut" class="card" style="margin-top:10px;"></div></div>`;
  const out = el.querySelector('#scanOut');
  const run = () => {
    const q = el.querySelector('#scanInput').value.trim().toUpperCase();
    const mode = el.querySelector('#scanMode').value;
    if (!state.datasets.consolidated.length) {
      out.innerHTML = `<p>Aucun dataset chargé. <button class="btn" id="gotoV2">Aller importer</button></p>`;
      out.querySelector('#gotoV2').onclick = () => switchView('v2');
      return;
    }
    if (mode === 'item') {
      const r = state.datasets.consolidated.find((x) => x.item === q);
      out.innerHTML = r ? `<h4>${r.item} - ${r.description}</h4><p>Total: <b>${r.qty_total}</b></p><p>Inv: ${r.liste_bins_inventaire.map((b) => `${b.bin}(${b.qty})`).join(', ')}</p><p>Rec: ${r.liste_bins_reception.map((b) => `${b.bin}(${b.qty})`).join(', ')}</p>` : '<p>Item introuvable.</p>';
    } else {
      const rows = state.datasets.consolidated.filter((x) => x.liste_bins_inventaire.concat(x.liste_bins_reception).some((b) => b.bin === q));
      out.innerHTML = rows.length ? `<h4>BIN ${q}</h4><ul>${rows.map((r) => `<li>${r.item} - ${r.description} (inv ${r.qty_inventaire_total} / rec ${r.qty_reception_total})</li>`).join('')}</ul>` : '<p>Bin introuvable.</p>';
    }
    if (state.settings.scan.autofocus) el.querySelector('#scanInput').focus();
    if (state.settings.scan.vibration && navigator.vibrate) navigator.vibrate(20);
    if (state.settings.scan.sound) new Audio('data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAAAA////AAAA////AAAA').play().catch(() => {});
  };
  el.querySelector('#scanGo').onclick = run;
  el.querySelector('#scanInput').addEventListener('keydown', (e) => e.key === 'Enter' && run());
  el.querySelector('#scanCopy').onclick = async () => navigator.clipboard?.writeText(out.innerText || '');
  el.querySelector('#scanPdf').onclick = () => window.print();
  el.querySelector('#scanClear').onclick = () => { out.innerHTML = ''; el.querySelector('#scanInput').value = ''; el.querySelector('#scanInput').focus(); };
}
function renderConsolidation() {
  document.getElementById('view-consolidation').innerHTML = `<details class="card" open><summary>Règles de consolidation</summary><p>Vue lecture seule style WMS.</p></details>
  <details class="card" open><summary>Tâches proposées</summary><ul><li>Réappro bins faibles</li><li>Contrôle bins critiques</li></ul></details>
  <details class="card"><summary>Déplacements recommandés</summary><p>${state.datasets.consolidated.filter((x) => x.qty_total < (state.settings.threshold || 20)).length} items sous seuil.</p></details>
  <details class="card"><summary>Bins vides</summary><p>Structure prête (V1).</p></details>
  <details class="card"><summary>Exports</summary><div class="row"><button class="btn" id="consoCsv">CSV</button><button class="btn" id="consoXlsx">Excel</button><button class="btn" id="consoPdf">PDF</button></div></details>`;
  document.getElementById('consoCsv').onclick = () => dl('consolidation.csv', csvFromRows(state.datasets.consolidated));
  document.getElementById('consoXlsx').onclick = () => { if (!window.XLSX) return; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.datasets.consolidated), 'CONSOLIDATION'); XLSX.writeFile(wb, 'consolidation.xlsx'); };
  document.getElementById('consoPdf').onclick = () => window.print();
}
function renderShipping() {
  const el = document.getElementById('view-shipping');
  el.innerHTML = `<div class="card"><h3>Suivi expédition Langelier (V3)</h3>
  <div class="row"><input id="palId" placeholder="ID palette (MAJUSCULE)" style="max-width:220px"/><button class="btn" id="newPal">Créer palette</button></div>
  <div class="row" style="margin-top:8px;"><input id="palSearch" placeholder="Recherche palette" style="max-width:220px"/><input id="cmdId" placeholder="Commande" style="max-width:220px"/><button class="btn" id="addCmd">Ajouter commande</button></div>
  <div id="palList" class="table-wrap" style="margin-top:8px;"></div>
  <div class="row" style="margin-top:10px;"><button class="btn" id="shipCsv">CSV</button><button class="btn" id="shipXlsx">Excel</button><button class="btn" id="shipPdf">PDF palette</button></div></div>`;

  const refresh = () => {
    const q = el.querySelector('#palSearch').value.trim().toUpperCase();
    const rows = state.shipping.filter((p) => !q || p.id.includes(q));
    el.querySelector('#palList').innerHTML = `<table><thead><tr><th>Palette</th><th>Commandes</th><th>Actions</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${p.id}</td><td>${p.orders.join(', ')}</td><td>${p.orders.map((o, oi) => `<button class='btn btn-danger' data-del='${p.id}:${oi}'>🗑️ ${o}</button>`).join(' ')}</td></tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => {
        const [id, oiStr] = b.dataset.del.split(':');
        const oi = Number(oiStr);
        const pal = state.shipping.find((s) => s.id === id);
        if (!pal) return;
        if (confirm('Confirmer suppression ?')) {
          pal.orders.splice(oi, 1);
          saveState();
          refresh();
        }
      };
    });
  };

  el.querySelector('#newPal').onclick = () => {
    const id = el.querySelector('#palId').value.trim().toUpperCase();
    if (!id) return;
    if (!state.shipping.find((p) => p.id === id)) state.shipping.unshift({ id, orders: [] });
    saveState();
    refresh();
  };
  el.querySelector('#addCmd').onclick = () => {
    const id = el.querySelector('#palSearch').value.trim().toUpperCase();
    const cmd = el.querySelector('#cmdId').value.trim().toUpperCase();
    if (!id || !cmd) return;
    const pal = state.shipping.find((p) => p.id === id);
    if (!pal) return alert('Palette introuvable');
    pal.orders.push(cmd);
    saveState();
    refresh();
  };
  el.querySelector('#palSearch').oninput = refresh;
  el.querySelector('#shipCsv').onclick = () => dl('shipping.csv', csvFromRows(state.shipping.map((p) => ({ palette: p.id, commandes: p.orders.join('|') }))));
  el.querySelector('#shipXlsx').onclick = () => { if (!window.XLSX) return; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.shipping.map((p) => ({ palette: p.id, commandes: p.orders.join('|') }))), 'PALETTES'); XLSX.writeFile(wb, 'shipping.xlsx'); };
  el.querySelector('#shipPdf').onclick = () => window.print();
  refresh();
}
function renderRemise() {
  const el = document.getElementById('view-remise');
  const drafts = state.remise.drafts;
  el.innerHTML = `<div class="card"><h3>Remise en stock Laval (V1)</h3>
  <details open><summary>1. Accueil Remise</summary><div class="row"><button class="btn" id="newRem">Générer</button></div></details>
  <details open><summary>2. Générer remise (scan item = +1)</summary><div class="row"><input id="remScan" placeholder="Scanner item" style="max-width:220px"/><button class="btn" id="addRem">Ajouter</button><button class="btn" id="completeRem">Compléter</button></div><div id="remList"></div></details>
  <details><summary>3. Prochaine remise</summary><div>${state.remise.archives.map((r) => `<div>${r.id} (${r.items.length} items)</div>`).join('') || 'Aucune archive'}</div></details>
  <details><summary>4. Traitement</summary><p>Workflow prêt V1 (scan item puis bin, forcer avec justification à intégrer).</p></details>
  <details><summary>5. Modules Scrap/Rebox</summary><p>Structure prête + logs historisés.</p></details></div>`;
  if (!drafts[0]) drafts[0] = { id: `LAVREM${String(state.remise.archives.length + 1).padStart(4, '0')}`, items: {} };
  const refresh = () => {
    el.querySelector('#remList').innerHTML = `<ul>${Object.entries(drafts[0].items).map(([k, v]) => `<li>${k} x${v} <button class='btn' data-rm='${k}'>Supprimer</button></li>`).join('')}</ul>`;
    el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { delete drafts[0].items[b.dataset.rm]; saveState(); refresh(); }; });
  };
  el.querySelector('#addRem').onclick = () => {
    const it = el.querySelector('#remScan').value.trim().toUpperCase();
    if (!it) return;
    drafts[0].items[it] = (drafts[0].items[it] || 0) + 1;
    saveState();
    refresh();
  };
  el.querySelector('#completeRem').onclick = () => {
    state.remise.archives.unshift({ id: drafts[0].id, items: Object.entries(drafts[0].items).map(([item, qty]) => ({ item, qty })), at: new Date().toISOString() });
    drafts[0] = { id: `LAVREM${String(state.remise.archives.length + 1).padStart(4, '0')}`, items: {} };
    saveState();
    log('Remise complétée', { id: state.remise.archives[0].id });
    renderRemise();
  };
  refresh();
}
function renderHistory() {
  const el = document.getElementById('view-history');
  el.innerHTML = `<div class="card"><h3>Historique / Archives</h3><div class="row"><input id="hSearch" placeholder="Recherche action" style="max-width:220px"/><input type="date" id="hDate" style="max-width:180px"/><button class="btn btn-danger" id="purgeHist">Purger (avec backup)</button></div><div id="hList" class="logs" style="max-height:420px;margin-top:8px;"></div></div>`;
  const refresh = () => {
    const q = el.querySelector('#hSearch').value.toLowerCase();
    const d = el.querySelector('#hDate').value;
    const rows = state.history.filter((r) => (!q || r.action.toLowerCase().includes(q)) && (!d || r.at.startsWith(d)));
    el.querySelector('#hList').innerHTML = rows.map((r) => `<div>${new Date(r.at).toLocaleString('fr-CA')} — ${r.action}</div>`).join('');
  };
  el.querySelector('#hSearch').oninput = refresh;
  el.querySelector('#hDate').onchange = refresh;
  el.querySelector('#purgeHist').onclick = () => {
    dl(`backup-before-purge-${Date.now()}.json`, JSON.stringify(state, null, 2), 'application/json');
    state.history = [];
    saveState();
    refresh();
  };
  refresh();
}
function renderSettings() {
  const el = document.getElementById('view-settings');
  el.innerHTML = `<div class="card"><h3>Paramètres</h3>
  <label>Seuil "à déplacer" (défaut 20)<input id="setThreshold" type="number" min="1" value="${state.settings.threshold || 20}"/></label>
  <label><input type="checkbox" id="setSound" ${state.settings.scan.sound ? 'checked' : ''}/> Son scan</label>
  <label><input type="checkbox" id="setVib" ${state.settings.scan.vibration ? 'checked' : ''}/> Vibration scan</label>
  <label><input type="checkbox" id="setAuto" ${state.settings.scan.autofocus ? 'checked' : ''}/> Auto focus</label>
  <label><input type="checkbox" id="setCam" ${state.settings.scan.camera ? 'checked' : ''}/> Caméra on/off</label>
  <div class="row"><button class="btn" id="saveSettings">Sauvegarder</button><button class="btn btn-danger" id="resetAll">Reset complet</button></div>
  <details class="details" style="margin-top:10px;"><summary>Mapping colonnes préféré</summary><pre>${JSON.stringify(state.mappings, null, 2)}</pre></details>
  </div>`;
  el.querySelector('#saveSettings').onclick = () => {
    state.settings.threshold = Number(el.querySelector('#setThreshold').value || 20);
    state.settings.scan = {
      sound: el.querySelector('#setSound').checked,
      vibration: el.querySelector('#setVib').checked,
      autofocus: el.querySelector('#setAuto').checked,
      camera: el.querySelector('#setCam').checked,
    };
    saveState();
    renderV2();
    alert('Paramètres sauvegardés');
  };
  el.querySelector('#resetAll').onclick = () => {
    if (confirm('Confirmer reset complet ?')) {
      state = structuredClone(defaults);
      saveState();
      init();
    }
  };
}

function init() {
  renderNav();
  renderDashboard();
  renderV2();
  renderScan();
  renderConsolidation();
  renderShipping();
  renderRemise();
  renderHistory();
  renderSettings();
  renderDataStatus();
}

document.getElementById('backupJsonBtn').onclick = () => dl(`dlwms-backup-${Date.now()}.json`, JSON.stringify(state, null, 2), 'application/json');
document.getElementById('restoreJsonBtn').onclick = () => document.getElementById('restoreJsonInput').click();
document.getElementById('restoreJsonInput').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    state = JSON.parse(await f.text());
    saveState();
    init();
    log('Restore JSON', { file: f.name });
  } catch {
    alert('Backup JSON invalide');
  }
};

init();
