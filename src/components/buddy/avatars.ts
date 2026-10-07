// The companion avatars a user can pick in Settings > Companion. Adding one is
// a row here plus a renderer; the picker and the setting read this list.

export type CompanionAvatarId = "bolt";

export interface CompanionAvatar {
  id: CompanionAvatarId;
  name: string;
  tagline: string;
}

export const COMPANION_AVATARS: CompanionAvatar[] = [
  { id: "bolt", name: "Bolt", tagline: "Buddy, always one tap away." },
];
