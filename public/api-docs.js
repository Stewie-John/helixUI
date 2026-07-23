import { CLAUDE_MODELS, CURSOR_MODELS, CODEX_MODELS } from '/shared/modelConstants.js';

document.querySelectorAll('.api-url').forEach((element) => {
  element.textContent = window.location.origin;
});

function appendModelLine(container, label, models, defaultModel, suffix = '') {
  const strong = document.createElement('strong');
  strong.textContent = `${label}:`;
  container.append(strong, ' ');

  models.forEach((model, index) => {
    if (index > 0) container.append(', ');
    const code = document.createElement('code');
    code.textContent = model.value;
    container.appendChild(code);
  });

  container.append(`${suffix} (default: `);
  const defaultCode = document.createElement('code');
  defaultCode.textContent = defaultModel;
  container.append(defaultCode, ')', document.createElement('br'), document.createElement('br'));
}

const modelCell = document.getElementById('model-options-cell');
if (modelCell) {
  modelCell.replaceChildren('Model identifier for the AI provider:', document.createElement('br'), document.createElement('br'));
  appendModelLine(modelCell, 'Claude', CLAUDE_MODELS.OPTIONS, CLAUDE_MODELS.DEFAULT);
  appendModelLine(modelCell, 'Cursor', CURSOR_MODELS.OPTIONS.slice(0, 8), CURSOR_MODELS.DEFAULT, ', and more');
  appendModelLine(modelCell, 'Codex', CODEX_MODELS.OPTIONS, CODEX_MODELS.DEFAULT);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('.tab-button[data-tab]');
  if (!button) return;

  const parentBlock = button.closest('.example-block');
  const tabName = button.dataset.tab;
  if (!parentBlock || !tabName) return;

  parentBlock.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));
  parentBlock.querySelectorAll('.tab-button').forEach((tabButton) => tabButton.classList.remove('active'));

  const targetTab = parentBlock.querySelector(`#${CSS.escape(tabName)}`);
  if (targetTab) {
    targetTab.classList.add('active');
    button.classList.add('active');
  }
});
