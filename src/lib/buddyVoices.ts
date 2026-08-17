import archiePreview from "../assets/voices/archie.mp3";
import dallasPreview from "../assets/voices/dallas.mp3";
import jolenePreview from "../assets/voices/jolene.mp3";
import katiePreview from "../assets/voices/katie.mp3";
import kiraPreview from "../assets/voices/kira.mp3";
import kylePreview from "../assets/voices/kyle.mp3";
import laylaPreview from "../assets/voices/layla.mp3";
import tessaPreview from "../assets/voices/tessa.mp3";

export interface BuddyVoice {
  slug: string;
  label: string;
  blurb: string;
  paidOnly: boolean;
  tint: string;
  previewUrl: string;
}

// Mirrors Aura mobile's buddy_voices.dart. Slugs are the backend contract;
// labels, blurbs, order, colors, and bundled previews are presentation data.
export const buddyVoices: readonly BuddyVoice[] = [
  {
    slug: "katie",
    label: "Katie",
    blurb: "Bright and clear. The voice Buddy has always had.",
    paidOnly: false,
    tint: "#d98a7a",
    previewUrl: katiePreview,
  },
  {
    slug: "dallas",
    label: "Dallas",
    blurb: "Easy and grounded, like a friend on a long call.",
    paidOnly: false,
    tint: "#7fa98a",
    previewUrl: dallasPreview,
  },
  {
    slug: "tessa",
    label: "Tessa",
    blurb: "Warm and close. Sounds glad you called.",
    paidOnly: true,
    tint: "#e0a97e",
    previewUrl: tessaPreview,
  },
  {
    slug: "kira",
    label: "Kira",
    blurb: "Soft and steady. Leans in when things get heavy.",
    paidOnly: true,
    tint: "#8391c4",
    previewUrl: kiraPreview,
  },
  {
    slug: "layla",
    label: "Layla",
    blurb: "Cool and unhurried. Never in a rush.",
    paidOnly: true,
    tint: "#4fb3a5",
    previewUrl: laylaPreview,
  },
  {
    slug: "jolene",
    label: "Jolene",
    blurb: "Honeyed and Southern. Slow warmth.",
    paidOnly: true,
    tint: "#c98f3f",
    previewUrl: jolenePreview,
  },
  {
    slug: "kyle",
    label: "Kyle",
    blurb: "Open and easy, quick to laugh.",
    paidOnly: true,
    tint: "#6fa8c9",
    previewUrl: kylePreview,
  },
  {
    slug: "archie",
    label: "Archie",
    blurb: "British, warm and a little dry.",
    paidOnly: true,
    tint: "#b5715a",
    previewUrl: archiePreview,
  },
] as const;

export const defaultBuddyVoiceSlug = "katie";
