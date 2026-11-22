(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem('geon-theme'); if (['light','dark'].includes(saved)) preference = saved; } catch {}
  function apply() {
    const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelectorAll('[data-theme]').forEach(b => { if (b.tagName === 'BUTTON') b.setAttribute('aria-pressed', String(b.dataset.theme === preference)); });
    const status = document.getElementById('theme-status');
    if (status) status.textContent = (preference === 'system' ? '시스템 설정 · ' : '') + (resolved === 'dark' ? '다크' : '라이트');
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('button[data-theme]').forEach(b => b.addEventListener('click', () => {
      preference = b.dataset.theme;
      try { if (preference === 'system') localStorage.removeItem('geon-theme'); else localStorage.setItem('geon-theme',preference); } catch {}
      apply();
    }));
    apply();
  });
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
})();
