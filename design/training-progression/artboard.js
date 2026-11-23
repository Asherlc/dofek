(() => {
  const board = document.getElementById('dofek-progression-board');
  board.addEventListener('click', (event) => {
    const save = event.target.closest('button[data-save]');
    if (save) {
      save.closest('.body').querySelector('[data-target]').textContent = save.dataset.next;
      save.textContent = save.dataset.save;
      save.disabled = true;
      return;
    }
    const effort = event.target.closest('button[data-effort]');
    if (!effort) return;
    const group = effort.closest('.effort-options');
    for (const button of group.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button === effort));
    }
    group.nextElementSibling.textContent = effort.dataset.effort;
  });
})();
