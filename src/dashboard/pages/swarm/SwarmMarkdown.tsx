import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** A manager's words as light markdown: paragraphs, lists, emphasis, inline code and
 * quotes. Model text is untrusted, so raw HTML and images are dropped, and a link is a
 * button that opens through the caller (openUrl) because the webview ignores target. */

const ALLOWED = ["p", "ul", "ol", "li", "strong", "em", "code", "pre", "blockquote", "a", "br", "del", "h1", "h2", "h3", "h4"];

function SwarmMarkdownImpl({ text, onOpenLink, className = "" }: { text: string; onOpenLink?: (url: string) => void; className?: string }) {
  const components: Components = {
    a: ({ href, children }) =>
      href && onOpenLink && /^https?:/i.test(href) ? (
        <button type="button" className="db-swarm-md-link" title={href} onClick={() => onOpenLink(href)}>
          {children}
        </button>
      ) : (
        <>{children}</>
      ),
    // Headings inside a chat message read as bold lines, never as page titles.
    h1: ({ children }) => <p className="db-swarm-md-head">{children}</p>,
    h2: ({ children }) => <p className="db-swarm-md-head">{children}</p>,
    h3: ({ children }) => <p className="db-swarm-md-head">{children}</p>,
    h4: ({ children }) => <p className="db-swarm-md-head">{children}</p>,
  };
  return (
    <div className={`db-swarm-md ${className}`.trim()}>
      <Markdown remarkPlugins={[remarkGfm]} skipHtml allowedElements={ALLOWED} unwrapDisallowed components={components}>
        {text}
      </Markdown>
    </div>
  );
}

export const SwarmMarkdown = memo(SwarmMarkdownImpl);
