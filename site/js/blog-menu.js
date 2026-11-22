const blogNav = document.querySelector('.blog-nav');
const blogToggle = blogNav.querySelector('.blog-nav__toggle');
const blogPanel = blogNav.querySelector('.blog-nav__panel');
const desktop = matchMedia('(min-width: 1025px)');

const groups = Array.from(blogNav.querySelectorAll('.blog-nav__group'), element => ({
  element,
  button: element.querySelector('.blog-nav__group-toggle'),
  topics: element.querySelector('.blog-nav__topics')
}));

function setActiveGroup(active) {
  for (const group of groups) {
    const open = group === active;
    group.button.setAttribute('aria-expanded', String(open));
    group.topics.toggleAttribute('inert', !open);
  }
}

for (const group of groups) {
  group.element.addEventListener('pointerenter', event => {
    if (desktop.matches && event.pointerType === 'mouse') setActiveGroup(group);
  });
  group.button.addEventListener('click', () => {
    setActiveGroup(group.topics.hasAttribute('inert') ? group : null);
  });
}

function setBlogMenu(open) {
  blogToggle.setAttribute('aria-expanded', String(open));
  blogPanel.toggleAttribute('inert', !open);
  if (!open) setActiveGroup(null);
}

blogToggle.hidden = false;
blogNav.addEventListener('pointerenter', event => {
  if (desktop.matches && event.pointerType === 'mouse') setBlogMenu(true);
});
blogNav.addEventListener('pointerleave', event => {
  if (desktop.matches && event.pointerType === 'mouse' && !blogNav.contains(document.activeElement)) setBlogMenu(false);
});
blogToggle.addEventListener('click', () => {
  setBlogMenu(blogPanel.hasAttribute('inert'));
});
blogNav.addEventListener('focusout', event => {
  if (!blogNav.contains(event.relatedTarget)) setBlogMenu(false);
});
document.addEventListener('click', event => {
  if (!blogNav.contains(event.target)) setBlogMenu(false);
});
blogNav.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || blogPanel.hasAttribute('inert')) return;
  const group = groups.find(item => !item.topics.hasAttribute('inert'));
  if (group && group.element.contains(event.target)) {
    group.button.focus();
    setActiveGroup(null);
    return;
  }
  blogToggle.focus();
  setBlogMenu(false);
});
