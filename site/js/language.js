(() => {
  const selector = document.querySelector('[data-language-switch]');
  if (!selector) return;
  const buttons = selector.querySelectorAll('button[data-language]');

  const labels = Array.from(document.querySelectorAll('[data-ko]'), element => ({
    element,
    en: element.textContent,
    ko: element.dataset.ko
  })).filter(label => label.ko);

  let language = 'en';
  try {
    if (localStorage.getItem('site-language') === 'ko') language = 'ko';
  } catch {}

  function render() {
    for (const { element, en, ko } of labels) {
      element.textContent = language === 'ko' ? ko : en;
      element.lang = language;
    }
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.language === language));
    }
    selector.setAttribute('aria-label', language === 'ko' ? '언어 선택' : 'Language');
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      language = button.dataset.language;
      try { localStorage.setItem('site-language', language); } catch {}
      render();
    });
  }

  render();
  selector.hidden = false;
})();
