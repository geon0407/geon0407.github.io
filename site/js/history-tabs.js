// About page history tabs (Education / Research & Award / Teaching Experience / Military Service).
// Without this script every panel shows under its own heading; with it, one panel at a time.
(() => {
  const box = document.querySelector('[data-history]');
  if (!box) return;
  const tabs = Array.from(box.querySelectorAll('[role="tab"]'));
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  if (!tabs.length) return;

  function select(index, focus = false) {
    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[i].hidden = !active;
    });
    if (focus) tabs[index].focus();
    tabs[index].scrollIntoView({block: 'nearest', inline: 'nearest'});
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i));
    tab.addEventListener('keydown', event => {
      const last = tabs.length - 1;
      const next = {ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(next, true);
    });
  });

  box.classList.add('is-tabbed');
  const initial = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
  tabs.forEach(tab => { tab.tabIndex = -1; });
  tabs[initial].tabIndex = 0;
  panels.forEach((panel, i) => { panel.hidden = i !== initial; });
})();
