// English / Korean, chosen like the colour theme (theme.js):
//   - a choice made with the EN / 한국어 buttons is remembered and wins;
//   - otherwise follow the browser / OS language: Korean if Korean comes before English in the
//     visitor's preferred languages, English otherwise — and follow it if it changes.
(() => {
  const key = 'site-language';
  const valid = value => value === 'en' || value === 'ko';

  function systemLanguage() {
    const tags = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
    for (const tag of tags) {
      const lang = String(tag).toLowerCase();
      if (lang.startsWith('ko')) return 'ko';
      if (lang.startsWith('en')) return 'en';
    }
    return 'en';
  }

  let preference = null;
  try { const saved = localStorage.getItem(key); if (valid(saved)) preference = saved; } catch {}

  const selector = document.querySelector('[data-language-switch]');
  const buttons = selector ? selector.querySelectorAll('button[data-language]') : [];
  const labels = Array.from(document.querySelectorAll('[data-ko]'), element => ({
    element,
    en: element.textContent,
    ko: element.dataset.ko
  })).filter(label => label.ko);
  // Text with links (news, timeline details): swap HTML instead of plain text.
  const richLabels = Array.from(document.querySelectorAll('[data-ko-html]'), element => ({
    element,
    en: element.innerHTML,
    ko: element.dataset.koHtml
  })).filter(label => label.ko);

  function render() {
    const language = preference || systemLanguage();
    document.documentElement.lang = language;
    for (const { element, en, ko } of labels) {
      element.textContent = language === 'ko' ? ko : en;
      element.lang = language;
    }
    for (const { element, en, ko } of richLabels) {
      element.innerHTML = language === 'ko' ? ko : en;
      element.lang = language;
    }
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.language === language));
    }
    if (selector) selector.setAttribute('aria-label', language === 'ko' ? '언어 선택' : 'Language');
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      preference = button.dataset.language;
      try { localStorage.setItem(key, preference); } catch {}
      render();
    });
  }
  // The OS/browser language changed, or another tab picked a language.
  window.addEventListener('languagechange', render);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue) ? event.newValue : null;
      render();
    }
  });

  render();
  if (selector) selector.hidden = false;
})();
