import { useState } from "react";
import { type User as FirebaseUser } from "firebase/auth";

export function initialsFor(user: FirebaseUser | null): string {
  const source = user?.displayName || user?.email || "";
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Photo URLs that already failed this session. Google avatars are often
 * rate-limited inside the desktop webview; once one fails, every later avatar for
 * that URL goes straight to initials instead of each one retrying and flickering. */
const failedPhotos = new Set<string>();

/** The signed-in user's photo, falling back to initials when there is no photo or
 * it fails to load (which otherwise leaves a broken-image glyph). The caller owns
 * the frame: size, shape and background. */
export function UserPhoto({ user }: { user: FirebaseUser | null }) {
  const photo = user?.photoURL;
  const [failed, setFailed] = useState(() => !!photo && failedPhotos.has(photo));
  if (photo && !failed) {
    return (
      <img
        src={photo}
        alt=""
        className="db-avatar-img"
        referrerPolicy="no-referrer"
        onError={() => {
          failedPhotos.add(photo);
          setFailed(true);
        }}
      />
    );
  }
  return <span className="db-avatar-initials">{initialsFor(user)}</span>;
}
