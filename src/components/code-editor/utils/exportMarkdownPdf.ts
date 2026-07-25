type ExportMarkdownPdfOptions = {
  root: HTMLElement;
  fileName: string;
  language?: string;
};

const escapeHtmlAttribute = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const waitForImages = (document: Document) => Promise.all(
  Array.from(document.images).map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  }),
);

export const exportMarkdownPdf = ({
  root,
  fileName,
  language = document.documentElement.lang || 'en',
}: ExportMarkdownPdfOptions) => {
  const printWindow = window.open('', '_blank', 'popup,width=960,height=1080');
  if (!printWindow) return false;

  printWindow.opener = null;
  const documentTitle = fileName.replace(/\.(?:md|markdown)$/i, '') || fileName;
  const printableRoot = root.cloneNode(true) as HTMLElement;
  printableRoot.querySelectorAll('button, [role="button"]').forEach((node) => node.remove());
  const stylesheets = Array.from(
    document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style'),
  )
    .map((node) => node.outerHTML)
    .join('\n');

  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html lang="${escapeHtmlAttribute(language)}">
  <head>
    <meta charset="utf-8">
    <base href="${escapeHtmlAttribute(document.baseURI)}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtmlAttribute(documentTitle)}</title>
    ${stylesheets}
    <style>
      :root { color-scheme: light; }
      html, body {
        margin: 0;
        background: #fff !important;
        color: #111827 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC",
          "Noto Sans SC", "Microsoft YaHei", Arial, sans-serif;
      }
      .markdown-pdf-document {
        box-sizing: border-box;
        width: min(100%, 180mm);
        margin: 0 auto;
        padding: 18mm 0;
        background: #fff !important;
        color: #111827 !important;
        overflow: visible !important;
      }
      .markdown-pdf-document, .markdown-pdf-document * {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      .markdown-pdf-document pre,
      .markdown-pdf-document blockquote,
      .markdown-pdf-document table,
      .markdown-pdf-document img,
      .markdown-pdf-document .katex-display {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .markdown-pdf-document table { width: 100%; }
      .markdown-pdf-document img { max-width: 100%; height: auto; }
      .markdown-pdf-document pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .markdown-pdf-document .katex-display {
        overflow: visible;
        max-width: 100%;
      }
      .markdown-pdf-document a {
        color: #075985 !important;
        text-decoration: underline;
      }
      @page { size: A4; margin: 16mm 15mm; }
      @media print {
        .markdown-pdf-document {
          width: auto;
          max-width: none;
          margin: 0;
          padding: 0;
        }
      }
    </style>
  </head>
  <body>
    <main class="markdown-pdf-document prose max-w-none">${printableRoot.innerHTML}</main>
  </body>
</html>`);
  printWindow.document.close();

  const printWhenReady = async () => {
    try {
      await printWindow.document.fonts?.ready;
      await waitForImages(printWindow.document);
      await new Promise<void>((resolve) => printWindow.requestAnimationFrame(() => resolve()));
      printWindow.focus();
      printWindow.print();
    } catch {
      printWindow.close();
    }
  };

  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  void printWhenReady();
  return true;
};
