(() => {
  const root = document.documentElement;
  const themeButton = document.getElementById('site-theme');
  const languageButton = document.getElementById('site-language');
  const themeIcon = themeButton.querySelector('ion-icon');
  const preferences = window.blogPreferences;
  const modes = ['system', 'light', 'dark'];
  const icons = { system: 'desktop-outline', light: 'sunny-outline', dark: 'moon-outline' };
  const labels = {
    ko: { system: '자동', light: '라이트', dark: '다크' },
    en: { system: 'System', light: 'Light', dark: 'Dark' }
  };

  function render() {
    const { theme, interfaceLanguage: lang } = root.dataset;
    const next = modes[(modes.indexOf(theme) + 1) % modes.length];
    const names = labels[lang];
    const themeLabel = lang === 'ko'
      ? `테마: ${names[theme]} (클릭하면 ${names[next]})`
      : `Theme: ${names[theme]} (switch to ${names[next]})`;
    const languageLabel = lang === 'ko' ? 'Switch to English' : '한국어로 전환';
    themeIcon.setAttribute('name', icons[theme]);
    themeButton.title = themeLabel;
    themeButton.setAttribute('aria-label', themeLabel);
    languageButton.title = languageLabel;
    languageButton.setAttribute('aria-label', languageLabel);
    languageButton.firstElementChild.textContent = lang === 'ko' ? 'EN' : 'KO';
    if (!root.dataset.contentLanguage) root.lang = lang;
    const pageTitle = document.querySelector('meta[name="interface-title"]');
    if (pageTitle) document.title = pageTitle.dataset[lang];
  }

  themeButton.addEventListener('click', () => {
    preferences.theme(modes[(modes.indexOf(root.dataset.theme) + 1) % modes.length]);
    render();
  });
  languageButton.addEventListener('click', () => {
    preferences.language(root.dataset.interfaceLanguage === 'ko' ? 'en' : 'ko');
    render();
  });
  render();
  themeButton.parentElement.hidden = false;
})();
