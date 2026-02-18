(() => {
  const KEY = 'wms_updates_history';
  const CURRENT_VERSION = '2026.02-menu-settings-help';
  const entries = JSON.parse(localStorage.getItem(KEY) || '[]');

  if (!entries.some((entry) => entry.version === CURRENT_VERSION)) {
    entries.unshift({
      version: CURRENT_VERSION,
      date: new Date().toISOString(),
      notes: 'Ajout menu paramètres avancés, import Excel/PDF, règles par page, aide/support et FAQ.',
    });
    localStorage.setItem(KEY, JSON.stringify(entries));
  }

  const list = document.getElementById('updateList');
  list.innerHTML = entries
    .map((entry) => `<li><strong>${entry.version}</strong> — ${new Date(entry.date).toLocaleString('fr-CA')}<br>${entry.notes}</li>`)
    .join('');
})();
