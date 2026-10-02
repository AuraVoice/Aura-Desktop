// Reads a file the user attaches to Aura Swarm into plain text, on this machine.
//
// Only the text leaves the computer (POST /swarm/docs); the file itself never does, and
// nothing here is written to disk. The PDF path is resumeText.ts's, kept per page so a
// manager can read and cite "page 2". A Word file goes through mammoth's HTML output
// rather than its raw text, because the headings and bullets it keeps are what let a
// manager find a section and rewrite the file without flattening it.
import { extractPdfPages } from "./resumeText";

/** Equal to juno-backend swarm/docs.py MAX_DOC_CHARS: the server keeps no more than this. */
export const DOCUMENT_MAX_CHARS = 150_000;
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type DocumentKind = "pdf" | "docx" | "txt" | "md";

export interface ExtractedDocument {
  kind: DocumentKind;
  pages: string[];
  chars: number;
  /** Only the first DOCUMENT_MAX_CHARS were kept. */
  truncated: boolean;
}

export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function tidy(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** mammoth's HTML as markdown-ish text: # headings, - bullets, | table cells. */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
      if (/^h[1-6]$/.test(tag)) {
        if (text) out.push("", `${"#".repeat(Number(tag[1]))} ${text}`);
      } else if (tag === "p") {
        if (text) out.push(text);
      } else if (tag === "ul" || tag === "ol") {
        for (const li of Array.from(child.children)) {
          const item = (li.textContent ?? "").replace(/\s+/g, " ").trim();
          if (item) out.push(`- ${item}`);
        }
      } else if (tag === "table") {
        for (const row of Array.from(child.querySelectorAll("tr"))) {
          const cells = Array.from(row.children).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim());
          if (cells.some(Boolean)) out.push(cells.join(" | "));
        }
      } else {
        walk(child);
      }
    }
  };
  walk(doc.body);
  return out.join("\n");
}

async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import("mammoth/mammoth.browser.js");
  const arrayBuffer = await file.arrayBuffer();
  const { value } = await mammoth.convertToHtml({ arrayBuffer });
  const structured = htmlToText(value);
  if (structured.trim()) return structured;
  return (await mammoth.extractRawText({ arrayBuffer })).value;
}

/**
 * Reads one attached file into pages of text. Throws a DocumentExtractionError whose
 * message is the user copy: what went wrong and what to do instead.
 */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  const extension = extensionOf(file.name);
  if (extension === "doc") {
    throw new DocumentExtractionError(`${file.name} is an older Word file. Save it as .docx and attach it again.`);
  }
  if (!["pdf", "docx", "txt", "md", "markdown"].includes(extension)) {
    throw new DocumentExtractionError(`${file.name} isn't a PDF, Word (.docx) or text file.`);
  }
  if (file.size > DOCUMENT_MAX_BYTES) {
    throw new DocumentExtractionError(`${file.name} is over 10 MB.`);
  }
  const kind: DocumentKind = extension === "markdown" ? "md" : (extension as DocumentKind);

  let raw: string[];
  try {
    if (kind === "pdf") raw = await extractPdfPages(file);
    else if (kind === "docx") raw = [await extractDocxText(file)];
    else raw = [await file.text()];
  } catch (err) {
    if (err instanceof Error && err.name === "PasswordException") {
      throw new DocumentExtractionError(`${file.name} is password protected. Save an unlocked copy and attach that.`);
    }
    throw new DocumentExtractionError(`Aura couldn't open ${file.name}. It may be damaged.`);
  }

  const pages: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const page of raw.map(tidy)) {
    if (chars + page.length > DOCUMENT_MAX_CHARS) {
      const room = DOCUMENT_MAX_CHARS - chars;
      if (room > 200) pages.push(page.slice(0, room));
      chars += Math.max(0, room);
      truncated = true;
      break;
    }
    pages.push(page);
    chars += page.length;
  }

  // A scan has pages but no text layer. Aura has no OCR, so say so before anything is sent.
  if (chars < 20) {
    throw new DocumentExtractionError(
      kind === "pdf"
        ? `${file.name} is a scan with no readable text. Aura can't read scans yet.`
        : `There's no text in ${file.name}.`,
    );
  }
  return { kind, pages: pages.length ? pages : [""], chars, truncated };
}
