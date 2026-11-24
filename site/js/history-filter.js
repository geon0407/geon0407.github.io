// About page history: filter buttons (All / Education / Research / Awards / Experience).
// Without this script the buttons stay hidden and every entry shows.
(() => {
  const box = document.querySelector('[data-history]');
  if (!box) return;
  const bar = box.querySelector('.about-history__tabs');
  const buttons = Array.from(bar.querySelectorAll('[data-filter]'));
  const items = Array.from(box.querySelectorAll('.about-timeline__item'));
  const empty = box.querySelector('.about-history__empty');

  function show(filter) {
    let visible = 0;
    for (const item of items) {
      const match = filter === 'all' || item.dataset.group === filter;
      item.hidden = !match;
      if (match) visible++;
    }
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    if (empty) empty.hidden = visible > 0;
    box.dataset.filter = filter;
  }

  buttons.forEach((button, i) => {
    button.addEventListener('click', () => show(button.dataset.filter));
    button.addEventListener('keydown', event => {
      const last = buttons.length - 1;
      const next = {ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      buttons[next].focus();
    });
  });

  bar.hidden = false;
  box.classList.add('is-filterable');
  show('all');
})();
