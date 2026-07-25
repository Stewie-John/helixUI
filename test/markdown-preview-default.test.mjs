import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Markdown files open rendered and keep an explicit edit toggle', async () => {
  const source = await readFile(
    new URL('../src/components/code-editor/view/CodeEditor.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /useState\(\(\) => isMarkdownFilename\(file\.name\)\)/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setMarkdownPreview\(isMarkdownFilename\(file\.name\)\);\s*\}, \[file\.name, file\.path\]\)/,
  );
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
