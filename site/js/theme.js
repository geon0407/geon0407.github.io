(() => {
  const key = 'site-theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['system', 'light', 'dark'].includes(value);
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (valid(saved)) preference = saved; } catch {}
  function render() {
    document.documentElement.dataset.theme = preference === 'system'
      ? (media.matches ? 'dark' : 'light') : preference;
    const control = document.querySelector('.theme-select');
    if (control) control.value = preference;
  }
  render();
  media.addEventListener('change', render);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue) ? event.newValue : 'system';
      render();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.querySelector('.theme-select');
    if (!control) return;
    control.hidden = false;
    control.value = preference;
    control.addEventListener('change', () => {
      preference = control.value;
      try { localStorage.setItem(key, preference); } catch {}
      render();
    });
  });
})();
