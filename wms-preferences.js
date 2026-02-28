(function () {
  const PREF_KEY = 'wms_ui_preferences_v1';
  const defaultPrefs = {
    theme: 'dark',
    contrast: false,
    largeFonts: false,
    reduceMotion: false,
    rules: {
      dashboard: '',
      consolidation: '',
      suivi: '',
      remise: '',
      reception: '',
      layout: '',
      stock: '',
    },
  };

  const mergePrefs = (raw) => ({
    ...defaultPrefs,
    ...raw,
    rules: { ...defaultPrefs.rules, ...(raw?.rules || {}) },
  });

  const readPrefs = () => {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      return mergePrefs(raw ? JSON.parse(raw) : {});
    } catch (e) {
      return mergePrefs({});
    }
  };

  const applyTheme = (root, prefs) => {
    if (!root) return;
    root.classList.toggle('theme-bright', prefs.theme === 'bright');
    root.classList.toggle('theme-dark', prefs.theme !== 'bright');
    root.classList.toggle('a11y-contrast', !!prefs.contrast);
    root.classList.toggle('a11y-large-font', !!prefs.largeFonts);
    root.classList.toggle('a11y-reduce-motion', !!prefs.reduceMotion);
  };

  const renderRuleHint = (prefs) => {
    document.querySelectorAll('[data-rule-display]').forEach((el) => {
      const key = el.getAttribute('data-rule-display');
      const text = prefs.rules[key];
      el.textContent = text && text.trim().length
        ? `Préférence active: ${text.trim()}`
        : 'Aucune préférence enregistrée pour cette page.';
    });
  };

  const init = () => {
    const prefs = readPrefs();
    applyTheme(document.querySelector('.screen'), prefs);
    renderRuleHint(prefs);
  };

  window.WMSPreferences = { readPrefs, applyTheme, PREF_KEY, defaultPrefs };
  document.addEventListener('DOMContentLoaded', init);
})();
