const themeSelector = document.getElementById('site-theme');
const languageSelector = document.getElementById('site-language');
themeSelector.value = document.documentElement.dataset.theme;
languageSelector.value = document.documentElement.dataset.interfaceLanguage;
themeSelector.addEventListener('change', () => window.blogPreferences.theme(themeSelector.value));
languageSelector.addEventListener('change', () => window.blogPreferences.language(languageSelector.value));
