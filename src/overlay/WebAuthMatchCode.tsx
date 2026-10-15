import { formatMatchCode, webAuthCopy } from "../lib/webAuthCopy";
import "./WebAuthMatchCode.css";

/** The code the browser sign-in page asks for. Typing it there is what proves the
 * person finishing sign-in is sitting at this computer, so a sign-in link someone
 * else sent can never connect their account to the sender's computer. */
export function WebAuthMatchCode({ code }: { code: string }) {
  const shown = formatMatchCode(code);
  return (
    <div className="web-auth-match-code" role="status">
      <span className="web-auth-match-code-label">{webAuthCopy.matchCodeLabel}</span>
      <span className="web-auth-match-code-value" aria-label={shown.split("").join(" ")}>{shown}</span>
      <span className="web-auth-match-code-hint">{webAuthCopy.matchCodeHint}</span>
    </div>
  );
}
