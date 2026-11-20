/**
 * PDF text extraction helpers.
 * We use pdf.js (pdfjs-dist) because it can read text page by page,
 * which matches the { id, page, text } shape the API returns.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Extract plain text from each page of a PDF buffer.
 * Returns one excerpt per page that actually contains text.
 */
export async function extractTextExcerptsFromPdf(pdfBuffer) {
  // pdf.js expects a Uint8Array; a Node Buffer works when wrapped this way.
  const data = new Uint8Array(pdfBuffer);

  // disableWorker: keeps extraction in-process — simpler for a small Express API.
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    disableWorker: true,
  });

  const pdfDocument = await loadingTask.promise;
  const excerpts = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();

    // Items are fragments in reading order; joining with spaces is enough
    // for tutoring context (we do not preserve exact layout).
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    // Skip blank pages so the client only sees useful excerpts.
    if (!pageText) {
      continue;
    }

    excerpts.push({
      id: `page-${pageNumber}`,
      page: pageNumber,
      text: pageText,
    });
  }

  return excerpts;
}
