const comingSoon = document.querySelector('#coming-soon');
const messages = {
  rent: ['Your next research companion is coming.', 'Kitten rentals are still being built. Soon, you’ll be able to give a bot a research mission and discover what it finds. Have an idea for a mission? We’d love to hear it.'],
  market: ['A universe of discoveries is coming.', 'The information marketplace is still being built. Soon, you’ll be able to browse available information and offer discoveries of your own. Get in touch to share your ideas.']
};
document.querySelectorAll('[data-destination]').forEach(button => {
  button.addEventListener('click', () => {
    const [title, description] = messages[button.dataset.destination];
    document.querySelector('#dialog-title').textContent = title;
    document.querySelector('#dialog-description').textContent = description;
    comingSoon.showModal();
  });
});
document.querySelector('.consultation-card').addEventListener('click', () => {
  document.querySelector('#consultation-offer').showModal();
});
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    }
  });
});
document.querySelector('#year').textContent = new Date().getFullYear();
