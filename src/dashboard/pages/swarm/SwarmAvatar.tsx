import { CrownGlyph, Sigil, SwarmMark, YouGlyph } from "./SwarmGlyphs";
import type { Author } from "./swarmThread";

/** One avatar for every voice in the Swarm tab. Each manager wears its own generated
 * sigil in a stable hue; the Supervisor wears the crown, you the core, Aura the mark. */
export function SwarmAvatar({ author, size = "md", live = false }: { author: Author; size?: "sm" | "md" | "lg"; live?: boolean }) {
  const tone = author.role === "manager" ? `is-hue-${author.hue}` : `is-${author.role}`;
  const glyph = size === "sm" ? 16 : size === "lg" ? 40 : 24;
  return (
    <span className={`db-swarm-avatar is-${size} ${tone}${live ? " is-live" : ""}`} aria-hidden="true">
      {author.role === "you" ? (
        <YouGlyph size={glyph} />
      ) : author.role === "supervisor" ? (
        <CrownGlyph size={glyph} />
      ) : author.role === "aura" ? (
        <SwarmMark size={glyph} />
      ) : (
        <Sigil id={author.id} size={glyph} />
      )}
    </span>
  );
}
