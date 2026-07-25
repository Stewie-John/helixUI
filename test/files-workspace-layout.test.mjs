import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (relativePath) => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

test('Files uses the HUD space and exposes a persistent file-tree toggle', async () => {
  const [app, editor, header] = await Promise.all([
    readSource('src/components/app/AppContent.tsx'),
    readSource('src/components/code-editor/view/CodeEditor.tsx'),
    readSource('src/components/code-editor/view/subcomponents/CodeEditorHeader.tsx'),
  ]);

  assert.match(app, /const showHudPanels = showTechDecor && activeTab !== 'files'/);
  assert.match(app, /\{showHudPanels && \(/);
  assert.match(app, /style=\{showHudPanels \? \{ paddingRight:/);
  assert.match(header, /PanelLeftClose/);
  assert.match(header, /PanelLeftOpen/);
  assert.match(header, /onClick=\{onToggleExpand\}/);
  assert.match(editor, /onToggleExpand=\{onToggleExpand\}/);
  assert.match(editor, /onToggleExpand: null/);
});

test('chat Markdown opens local text links internally without intercepting web links', async () => {
  const [markdown, message] = await Promise.all([
    readSource('src/components/chat/view/subcomponents/Markdown.tsx'),
    readSource('src/components/chat/view/subcomponents/MessageComponent.tsx'),
  ]);

  assert.match(markdown, /export function resolveLocalFileHref/);
  assert.match(markdown, /\^\(\?:https\?\|mailto\|tel\|data\|blob\):/);
  assert.match(markdown, /event\.preventDefault\(\)/);
  assert.match(markdown, /onFileOpen\(localFilePath\)/);
  assert.match(markdown, /a: MarkdownLink/);
  const markdownRenderCount = (message.match(/<Markdown\b/g) || []).length;
  const fileOpenBindingCount = (
    message.match(/<Markdown\b[^>]*onFileOpen=\{onFileOpen\}[^>]*>/g) || []
  ).length;
  assert.ok(markdownRenderCount >= 4);
  assert.equal(fileOpenBindingCount, markdownRenderCount);
});
