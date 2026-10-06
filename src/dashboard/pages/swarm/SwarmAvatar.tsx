import { HubGlyph, SwarmMark } from "./SwarmGlyphs";
import type { Author } from "./swarmThread";
import { UserPhoto } from "../../components/UserPhoto";
import { useAuth } from "../../../state/AuthProvider";

export function managerInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() || "M";
}

export type AvatarState = "idle" | "working" | "paused";

/** You are the one human here, so you get your photo in a circle. Agents get
 * rounded tiles: managers their initial on their hue, the Supervisor its hub, Aura
 * its mark. Only a working agent moves. */
export function SwarmAvatar({ author, size = "md", state = "idle" }: { author: Author; size?: "xs" | "sm" | "md" | "lg"; state?: AvatarState }) {
  const tone = author.role === "manager" ? `is-hue-${author.hue}` : `is-${author.role}`;
  const glyph = size === "xs" ? 14 : size === "sm" ? 18 : size === "lg" ? 48 : 26;
  const meaning =
    author.role === "you"
      ? "You"
      : author.role === "supervisor"
        ? "The Supervisor: it coordinates every manager"
        : author.role === "aura"
          ? "Aura, before any manager is hired"
          : author.name;
  return (
    <span className={`db-swarm-avatar is-${size} ${tone}${state === "idle" ? "" : ` is-${state}`}`} aria-hidden="true" title={meaning}>
      {author.role === "you" ? (
        <YouPhoto />
      ) : author.role === "supervisor" ? (
        <HubGlyph size={glyph} />
      ) : author.role === "aura" ? (
        <SwarmMark size={glyph} />
      ) : (
        managerInitial(author.name)
      )}
    </span>
  );
}

function YouPhoto() {
  const { user } = useAuth();
  return <UserPhoto user={user} />;
}
