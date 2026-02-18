(() => {
  const root = document.querySelector('.screen');
  const themeSelect = document.getElementById('themeMode');
  const contrast = document.getElementById('a11yContrast');
  const fonts = document.getElementById('a11yFonts');
  const motion = document.getElementById('a11yMotion');
  const output = document.getElementById('a11yOutput');

  document.querySelectorAll('.rule-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const current = tab.dataset.tab;
      document.querySelectorAll('.rule-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.rule-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === current));
    });
  });

  const applyTheme = () => {
    root.classList.toggle('theme-bright', themeSelect.value === 'bright');
    root.classList.toggle('theme-dark', themeSelect.value === 'dark');
    root.classList.toggle('a11y-contrast', contrast.checked);
    root.classList.toggle('a11y-large-font', fonts.checked);
    root.classList.toggle('a11y-reduce-motion', motion.checked);
  };

  document.getElementById('generateAccessibility')?.addEventListener('click', () => {
    applyTheme();
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
})();
