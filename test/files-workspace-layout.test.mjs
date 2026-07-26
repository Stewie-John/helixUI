import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (relativePath) => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8',
);

test('Files uses the HUD space and exposes a persistent file-tree toggle', async () => {
  const [app, editor, header, sidebar, editorState, projectSidebar, styles] = await Promise.all([
    readSource('src/components/app/AppContent.tsx'),
    readSource('src/components/code-editor/view/CodeEditor.tsx'),
    readSource('src/components/code-editor/view/subcomponents/CodeEditorHeader.tsx'),
    readSource('src/components/code-editor/view/EditorSidebar.tsx'),
    readSource('src/components/code-editor/hooks/useEditorSidebar.ts'),
    readSource('src/components/sidebar/view/Sidebar.tsx'),
    readSource('src/index.css'),
  ]);

  assert.match(app, /const showHudPanels = showTechDecor && activeTab !== 'files'/);
  assert.match(app, /\{showHudPanels && \(/);
  assert.match(app, /style=\{techLayoutStyle\}/);
  assert.match(app, /'--tech-sidebar-width': uiPreferences\.sidebarVisible \? '24rem' : '3rem'/);
  assert.match(app, /style=\{showHudPanels \? \{ paddingRight:/);
  assert.doesNotMatch(app, /showInputSeparator/);
  assert.match(header, /PanelLeftClose/);
  assert.match(header, /PanelLeftOpen/);
  assert.match(header, /onClick=\{onToggleExpand\}/);
  assert.match(header, /aria-label=\{isExpanded \? labels\.showFileTree : labels\.hideFileTree\}/);
  assert.match(editor, /onToggleExpand=\{onToggleExpand\}/);
  assert.match(editor, /onToggleExpand: null/);
  assert.match(sidebar, /editorExpanded \? '' : 'border-l border-gray-200 dark:border-gray-700'/);
  assert.match(sidebar, /role="separator"/);
  assert.match(sidebar, /onKeyDown=\{onResizeKeyDown\}/);
  assert.match(editorState, /event\.key === 'ArrowLeft' \? 32 : -32/);
  assert.match(projectSidebar, /const shouldShowSidebar = activeTab !== 'files'/);
  assert.match(projectSidebar, /setPreference\('sidebarVisible', shouldShowSidebar\)/);
  assert.match(styles, /left: var\(--tech-sidebar-width, 24rem\)/);
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
