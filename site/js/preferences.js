(() => {
  const root = document.documentElement;
  function get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }
  window.blogPreferences = {
    theme(value, persist = true) {
      const choice = ['system', 'light', 'dark'].includes(value) ? value : 'system';
      root.dataset.theme = choice;
      if (persist) save('blog-theme', choice);
    },
    language(value, persist = true) {
      const language = value === 'en' ? 'en' : 'ko';
      root.dataset.interfaceLanguage = language;
      if (persist) save('blog-language', language);
    }
  };
  window.blogPreferences.theme(get('blog-theme'), false);
  window.blogPreferences.language(get('blog-language'), false);
})();
