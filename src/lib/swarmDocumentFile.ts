// Turns a Swarm document draft (markdown the report model wrote) into a real file on this
// machine: Word through `docx`, PDF through `pdf-lib`, or plain text. Both libraries load
// only when the user presses Save, so the dashboard bundle does not grow for anyone else.
// The bytes go to save_swarm_document (swarm_documents.rs), which picks a name that never
// overwrites anything in Downloads/Aura Documents.
import { invoke } from "@tauri-apps/api/core";
import { blobToBase64 } from "./chatAttachments";

export type DocumentFormat = "docx" | "pdf" | "txt";

export const FORMAT_LABEL: Record<DocumentFormat, string> = {
  docx: "Word",
  pdf: "PDF",
  txt: "Text",
};

interface Run {
  text: string;
  bold: boolean;
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "bullet"; runs: Run[] }
  | { type: "para"; runs: Run[] }
  | { type: "gap" };

/** "**bold** plain" into runs. Anything else markdown can do stays as written. */
function runsOf(line: string): Run[] {
  const runs: Run[] = [];
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    const bold = part.startsWith("**") && part.endsWith("**") && part.length > 4;
    runs.push({ text: bold ? part.slice(2, -2) : part.replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1$2"), bold });
  }
  return runs.length ? runs : [{ text: "", bold: false }];
}

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1].type !== "gap") blocks.push({ type: "gap" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, runs: runsOf(heading[2].replace(/\*\*/g, "")) });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ type: "bullet", runs: runsOf(bullet[1]) });
      continue;
    }
    blocks.push({ type: "para", runs: runsOf(line.trim()) });
  }
  return blocks;
}

function plainText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.type === "gap") return "";
      const text = b.runs.map((r) => r.text).join("");
      return b.type === "bullet" ? `- ${text}` : b.type === "heading" && b.level === 1 ? text.toUpperCase() : text;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

async function buildDocx(blocks: Block[]): Promise<Blob> {
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  const children = blocks
    .filter((b) => b.type !== "gap")
    .map((b) => {
      const runs = b.runs.map((r) => new TextRun({ text: r.text, bold: r.bold }));
      if (b.type === "heading") return new Paragraph({ heading: headings[b.level - 1], children: runs, spacing: { before: 200, after: 80 } });
      if (b.type === "bullet") return new Paragraph({ bullet: { level: 0 }, children: runs, spacing: { after: 40 } });
      return new Paragraph({ children: runs, spacing: { after: 120 } });
    });
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }, children }],
  });
  return Packer.toBlob(doc);
}

async function buildPdf(blocks: Block[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  // The standard fonts only carry WinAnsi; anything else (CJK, emoji) would throw.
  const supported = new Set(regular.getCharacterSet());
  const clean = (text: string) =>
    Array.from(text.replace(/[‐-―]/g, "-"))
      .map((ch) => (supported.has(ch.codePointAt(0) ?? 0) ? ch : "?"))
      .join("");

  const width = 612;
  const height = 792;
  const margin = 54;
  const maxWidth = width - margin * 2;
  let page = pdf.addPage([width, height]);
  let y = height - margin;

  const ensure = (needed: number) => {
    if (y - needed < margin) {
      page = pdf.addPage([width, height]);
      y = height - margin;
    }
  };

  const writeRuns = (runs: Run[], size: number, indent: number, forceBold: boolean) => {
    const lineHeight = size * 1.35;
    const words: { text: string; font: typeof regular }[] = [];
    for (const run of runs) {
      for (const word of clean(run.text).split(/(\s+)/)) {
        if (word) words.push({ text: word, font: forceBold || run.bold ? bold : regular });
      }
    }
    let line: typeof words = [];
    let lineWidth = 0;
    const flush = () => {
      while (line.length && !line[line.length - 1].text.trim()) line.pop();
      if (!line.length) return;
      ensure(lineHeight);
      y -= lineHeight;
      let x = margin + indent;
      for (const w of line) {
        page.drawText(w.text, { x, y, size, font: w.font, color: rgb(0.1, 0.1, 0.1) });
        x += w.font.widthOfTextAtSize(w.text, size);
      }
      line = [];
      lineWidth = 0;
    };
    for (const w of words) {
      const wWidth = w.font.widthOfTextAtSize(w.text, size);
      if (!line.length && !w.text.trim()) continue;
      if (lineWidth + wWidth > maxWidth - indent && line.length) flush();
      if (!line.length && !w.text.trim()) continue;
      line.push(w);
      lineWidth += wWidth;
    }
    flush();
  };

  for (const block of blocks) {
    if (block.type === "gap") {
      y -= 6;
      continue;
    }
    if (block.type === "heading") {
      const size = [18, 14, 12][block.level - 1];
      y -= block.level === 1 ? 6 : 8;
      writeRuns(block.runs, size, 0, true);
      y -= 3;
    } else if (block.type === "bullet") {
      // One full line of room first, so the bullet and its first line never split a page.
      ensure(10.5 * 1.35 + 1);
      page.drawText("•", { x: margin + 4, y: y - 10.5 * 1.35, size: 10.5, font: regular, color: rgb(0.1, 0.1, 0.1) });
      writeRuns(block.runs, 10.5, 16, false);
    } else {
      writeRuns(block.runs, 10.5, 0, false);
      y -= 3;
    }
  }
  return pdf.save();
}

/** Builds the file and writes it into Downloads/Aura Documents. Returns the saved path. */
export async function saveDocumentDraft(title: string, markdown: string, format: DocumentFormat): Promise<string> {
  const blocks = parseMarkdown(markdown);
  let blob: Blob;
  if (format === "docx") blob = await buildDocx(blocks);
  else if (format === "pdf") blob = new Blob([(await buildPdf(blocks)) as BlobPart], { type: "application/pdf" });
  else blob = new Blob([plainText(blocks)], { type: "text/plain" });
  const dataBase64 = await blobToBase64(blob);
  const saved = await invoke<{ path: string }>("save_swarm_document", {
    stem: title.trim() || "Aura document",
    extension: format,
    dataBase64,
  });
  return saved.path;
}
