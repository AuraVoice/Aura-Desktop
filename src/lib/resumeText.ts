// Resume text extraction for the Interview Companion.
//
// Both heavy parsers are loaded with a dynamic import so the dashboard bundle
// stays the same size for everyone who never opens the resume dialog. The pdf.js
// worker URL is a static `?url` import instead, because Vite has to emit it as a
// same-origin asset for the app's CSP (`worker-src 'self' blob:`) to allow it,
// and because workerSrc must be set in the same module as the parse call - a
// separate module can be evaluated after pdf.js installs its own default and
// silently lose the assignment.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Matches the backend's own resume field limit in CompanyResearchRequest. */
export const RESUME_MAX_CHARS = 12_000;

export type ResumeExtractionCode = "unsupported" | "unreadable" | "empty";

export class ResumeExtractionError extends Error {
  code: ResumeExtractionCode;

  constructor(code: ResumeExtractionCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const RESUME_ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,text/plain,text/markdown";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Collapses runs of blank lines and trailing spaces without touching content. */
function tidy(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  // Text extraction never paints anything, so skipping font loading avoids
  // fetches the app's CSP would block anyway.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    disableFontFace: true,
  });
  const document = await loadingTask.promise;

  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let current = "";
      let lastY: number | null = null;

      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5] as number;
        // A new baseline means a new visual line. Without this every bullet on
        // the page runs together into one unreadable paragraph.
        if (lastY !== null && Math.abs(y - lastY) > 2 && current.trim()) {
          lines.push(current.trim());
          current = "";
        }
        current += item.str;
        if (item.hasEOL) {
          if (current.trim()) lines.push(current.trim());
          current = "";
          lastY = null;
          continue;
        }
        lastY = y;
      }
      if (current.trim()) lines.push(current.trim());
      pages.push(lines.join("\n"));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages.join("\n\n");
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth/mammoth.browser.js");
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}

/**
 * Reads a resume file into plain text.
 *
 * Throws a ResumeExtractionError so the caller can tell "wrong file type" apart
 * from "this PDF is a scan with no text layer", which need different advice.
 */
export async function extractResumeText(file: File): Promise<string> {
  const extension = extensionOf(file.name);
  let raw: string;
  try {
    if (extension === "pdf") raw = await extractPdf(file);
    else if (extension === "docx") raw = await extractDocx(file);
    else if (extension === "txt" || extension === "md" || extension === "markdown") {
      raw = await file.text();
    } else if (extension === "doc") {
      throw new ResumeExtractionError(
        "unsupported",
        "Older .doc files are not supported. Save it as .docx or PDF and try again.",
      );
    } else {
      throw new ResumeExtractionError(
        "unsupported",
        "Aura reads PDF, Word (.docx), and plain text resumes.",
      );
    }
  } catch (err) {
    if (err instanceof ResumeExtractionError) throw err;
    throw new ResumeExtractionError("unreadable", "Aura could not read that resume file.");
  }

  const text = tidy(raw);
  if (!text) {
    throw new ResumeExtractionError(
      "empty",
      extension === "pdf"
        ? "That PDF has no selectable text, so it is likely a scan. Paste the text instead."
        : "Aura could not find any text in that file.",
    );
  }
  return text;
}

export function resumeStats(text: string): { words: number; characters: number } {
  const trimmed = text.trim();
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    characters: text.length,
  };
}
