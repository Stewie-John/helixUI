import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Markdown files open rendered and keep an explicit edit toggle', async () => {
  const source = await readFile(
    new URL('../src/components/code-editor/view/CodeEditor.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /useState\(\(\) => isMarkdownFilename\(file\.name\)\)/);
  assert.match(source, /setMarkdownPreview\(isMarkdownFilename\(file\.name\)\)/);
  assert.match(source, /\}, \[file\.name, file\.path\]\)/);
  assert.match(source, /onToggleMarkdownPreview=\{\(\) => setMarkdownPreview\(\(previous\) => !previous\)\}/);
});

test('Markdown preview normalizes common LaTeX delimiters before rendering', async () => {
  const source = await readFile(
    new URL('../src/components/code-editor/view/subcomponents/markdown/MarkdownPreview.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /normalizeLatexDelimiters\(content\)/);
  assert.match(source, /\{normalizedContent\}/);
  assert.match(source, /strict:\s*false/);
  assert.match(source, /throwOnError:\s*false/);
});

test('Markdown preview resolves and authenticated-loads local image assets', async () => {
  const [preview, surface, editor] = await Promise.all([
    readFile(
      new URL('../src/components/code-editor/view/subcomponents/markdown/MarkdownPreview.tsx', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../src/components/code-editor/view/subcomponents/CodeEditorSurface.tsx', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../src/components/code-editor/view/CodeEditor.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(preview, /export function resolveMarkdownAssetPath/);
  assert.match(preview, /authenticatedFetch\(/);
  assert.match(preview, /files\/content\?path=/);
  assert.match(preview, /img: MarkdownImage/);
  assert.match(preview, /URL\.createObjectURL\(blob\)/);
  assert.match(surface, /<MarkdownPreview content=\{content\} filePath=\{filePath\} projectName=\{projectName\}/);
  assert.match(editor, /filePath=\{file\.path\}/);
  assert.match(editor, /projectName=\{file\.projectName\}/);
});

test('Rendered Markdown can be exported through a print-only PDF document', async () => {
  const [editor, header, exporter] = await Promise.all([
    readFile(new URL('../src/components/code-editor/view/CodeEditor.tsx', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/components/code-editor/view/subcomponents/CodeEditorHeader.tsx', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../src/components/code-editor/utils/exportMarkdownPdf.ts', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(editor, /exportMarkdownPdf\(\{/);
  assert.match(header, /isMarkdownFile && markdownPreview/);
  assert.match(header, /onClick=\{onExportMarkdownPdf\}/);
  assert.match(exporter, /class="markdown-pdf-document prose max-w-none"/);
  assert.match(exporter, /querySelectorAll\('button, \[role="button"\]'\)/);
  assert.match(exporter, /@page \{ size: A4;/);
  assert.match(exporter, /printWindow\.print\(\)/);
});
