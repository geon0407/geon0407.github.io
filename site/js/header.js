// Sticky header: once the page is scrolled, mark it so CSS can make it compact with a shadow.
(() => {
  const header = document.querySelector('.c-header');
  if (!header) return;
  const update = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  update();
  window.addEventListener('scroll', update, {passive: true});
})();
