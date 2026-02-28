(() => {
  const root = document.querySelector('.screen');
  const themeSelect = document.getElementById('themeMode');
  const contrast = document.getElementById('a11yContrast');
  const fonts = document.getElementById('a11yFonts');
  const motion = document.getElementById('a11yMotion');
  const output = document.getElementById('a11yOutput');
  const saveBtn = document.getElementById('savePreferences');

  if (!window.WMSPreferences) return;
  const { readPrefs, PREF_KEY, defaultPrefs } = window.WMSPreferences;

  const getCurrentValues = () => {
    const rules = {};
    document.querySelectorAll('[data-rule-key]').forEach((field) => {
      rules[field.dataset.ruleKey] = field.value;
    });

    return {
      theme: themeSelect.value,
      contrast: contrast.checked,
      largeFonts: fonts.checked,
      reduceMotion: motion.checked,
      rules,
    };
  };

  const persist = (showMessage = false) => {
    const prefs = getCurrentValues();
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    WMSPreferences.applyTheme(root, prefs);

    if (showMessage) {
      output.textContent = 'Préférences sauvegardées pour toutes les pages WMS.';
    }
  };

  const hydrate = () => {
    const prefs = readPrefs();
    themeSelect.value = prefs.theme;
    contrast.checked = prefs.contrast;
    fonts.checked = prefs.largeFonts;
    motion.checked = prefs.reduceMotion;
    document.querySelectorAll('[data-rule-key]').forEach((field) => {
      field.value = prefs.rules[field.dataset.ruleKey] || '';
    });
    WMSPreferences.applyTheme(root, prefs);
  };

  document.querySelectorAll('.rule-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const current = tab.dataset.tab;
      document.querySelectorAll('.rule-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.rule-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === current));
    });
  });

  [themeSelect, contrast, fonts, motion].forEach((input) => {
    input.addEventListener('change', () => persist(false));
  });
  document.querySelectorAll('[data-rule-key]').forEach((field) => {
    field.addEventListener('input', () => persist(false));
  });

  document.getElementById('generateAccessibility')?.addEventListener('click', () => {
    persist(false);
    const enabled = [
      themeSelect.value === 'dark' ? 'Mode sombre' : 'Mode éclatant',
      contrast.checked ? 'Contraste élevé' : null,
      fonts.checked ? 'Grande police' : null,
      motion.checked ? 'Animations réduites' : null,
    ].filter(Boolean);

    output.textContent = enabled.length
      ? `Options d’accessibilité générées: ${enabled.join(', ')}.`
      : 'Aucune option activée.';
  });

  saveBtn?.addEventListener('click', () => persist(true));

  document.getElementById('resetPreferences')?.addEventListener('click', () => {
    localStorage.setItem(PREF_KEY, JSON.stringify(defaultPrefs));
    hydrate();
    output.textContent = 'Préférences réinitialisées.';
  });

  hydrate();
})();
