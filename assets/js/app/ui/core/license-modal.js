/**
 * License modal wiring (loaded from `index.html`).
 *
 * Requirements:
 * - Must never throw (page should still load even if DOM changes).
 * - Minimal, dependency-free DOM bindings.
 *
 * Expected DOM:
 * - `#license-modal` containing `.license-backdrop`
 * - `#license-link` anchor/button that opens the modal
 * - `#license-close-btn` button that closes the modal
 */
(() => {
  const modal = document.getElementById('license-modal');
  const link = document.getElementById('license-link');
  const closeBtn = document.getElementById('license-close-btn');
  const backdrop = modal ? modal.querySelector('.license-backdrop') : null;

  if (!modal || !link || !closeBtn || !backdrop) return;

  /** @param {Event=} event */
  const openModal = (event) => {
    try {
      event?.preventDefault?.();
    } catch {
      // ignore
    }
    modal.classList.remove('hidden');
    try {
      document.body.style.overflow = 'hidden';
    } catch {
      // ignore
    }
  };

  const closeModal = () => {
    modal.classList.add('hidden');
    try {
      document.body.style.overflow = '';
    } catch {
      // ignore
    }
  };

  link.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });
})();
