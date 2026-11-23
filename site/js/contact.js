// Contact links (see _includes/contact-email.html): the email address is stored reversed in
// the page so simple scrapers don't pick it up; here it becomes a normal mailto: link.
(() => {
  const links = document.querySelectorAll('[data-contact-email]');
  if (!links.length) return;
  const email = links[0].dataset.contactEmail.split('').reverse().join('');

  links.forEach(link => {
    link.href = 'mailto:' + email;
    const text = link.querySelector('.contact-email__text');
    if (text) text.textContent = email;
  });
  document.querySelectorAll('[data-contact-mailto]').forEach(link => { link.href = 'mailto:' + email; });

  document.querySelectorAll('[data-contact-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(email);
      } catch {
        // Older browsers / insecure contexts: copy through a temporary text field.
        const field = document.createElement('textarea');
        field.value = email;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        document.execCommand('copy');
        field.remove();
      }
      const icon = button.querySelector('ion-icon');
      button.classList.add('is-copied');
      icon?.setAttribute('name', 'checkmark-outline');
      clearTimeout(button.copiedTimer);
      button.copiedTimer = setTimeout(() => {
        button.classList.remove('is-copied');
        icon?.setAttribute('name', 'copy-outline');
      }, 1600);
    });
  });
})();
