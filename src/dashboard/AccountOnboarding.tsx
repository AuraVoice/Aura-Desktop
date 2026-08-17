import { useMemo, useState } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { authFetch } from "../lib/api";
import { overlayStorePath } from "../lib/copy";
import { auth } from "../lib/firebase";
import { logError } from "../lib/log";

export interface AccountOnboardingProfile {
  display_name: string;
  date_of_birth: string | null;
  aura_consent_granted: boolean | null;
  gender: string | null;
  onboarding_interests: string[];
  locale: string | null;
  language: string | null;
}

export interface AccountOnboardingState {
  complete: boolean;
  version: number;
  profile: AccountOnboardingProfile;
  minimum_age: number;
  minimum_interests: number;
  interest_options: Array<{ slug: string; label: string }>;
}

const accountOnboardingConfirmedKey = (uid: string) =>
  `account_onboarding_confirmed_${encodeURIComponent(uid)}`;

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    return typeof data.error === "string" && data.error ? data.error : fallback;
  } catch {
    return fallback;
  }
}

export async function hasConfirmedAccountOnboarding(uid: string): Promise<boolean> {
  const store = await Store.load(overlayStorePath);
  return Boolean(await store.get<boolean>(accountOnboardingConfirmedKey(uid)));
}

export async function markAccountOnboardingConfirmed(uid: string): Promise<void> {
  const store = await Store.load(overlayStorePath);
  await store.set(accountOnboardingConfirmedKey(uid), true);
  await store.save();
}

function parseAccountOnboardingState(value: unknown): AccountOnboardingState {
  if (!value || typeof value !== "object") throw new Error("Aura returned an invalid account setup response.");
  const data = value as Record<string, unknown>;
  const profile = data.profile as Record<string, unknown> | undefined;
  const options = data.interest_options;
  if (
    typeof data.complete !== "boolean"
    || typeof data.version !== "number"
    || typeof data.minimum_age !== "number"
    || typeof data.minimum_interests !== "number"
    || !profile
    || typeof profile.display_name !== "string"
    || !(profile.date_of_birth === null || typeof profile.date_of_birth === "string")
    || !(profile.aura_consent_granted === null || typeof profile.aura_consent_granted === "boolean")
    || !(profile.gender === null || typeof profile.gender === "string")
    || !Array.isArray(profile.onboarding_interests)
    || !profile.onboarding_interests.every((interest) => typeof interest === "string")
    || !(profile.locale === null || typeof profile.locale === "string")
    || !(profile.language === null || typeof profile.language === "string")
    || !Array.isArray(options)
    || !options.every((option) => (
      option
      && typeof option === "object"
      && typeof (option as Record<string, unknown>).slug === "string"
      && typeof (option as Record<string, unknown>).label === "string"
    ))
  ) throw new Error("Aura returned an invalid account setup response.");
  return data as unknown as AccountOnboardingState;
}

function requireAccount(uid: string) {
  if (auth.currentUser?.uid !== uid) throw new Error("The signed-in account changed during setup.");
}

export async function fetchAccountOnboarding(uid: string): Promise<AccountOnboardingState> {
  requireAccount(uid);
  const response = await authFetch("/account/onboarding");
  if (!response.ok) {
    throw new Error(await responseError(response, `Account setup failed (${response.status}).`));
  }
  requireAccount(uid);
  return parseAccountOnboardingState(await response.json());
}

async function completeAccountOnboarding(uid: string, payload: {
  display_name: string;
  date_of_birth: string;
  aura_consent_granted: boolean;
  gender: string;
  onboarding_interests: string[];
  locale: string;
  language: string;
}): Promise<AccountOnboardingState> {
  requireAccount(uid);
  const response = await authFetch("/account/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await responseError(response, `Account setup failed (${response.status}).`));
  }
  requireAccount(uid);
  const state = parseAccountOnboardingState(await response.json());
  if (!state.complete) throw new Error("Aura did not confirm account setup.");
  return state;
}

function dateInputValue(date: Date): string {
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function ageFor(dateOfBirth: string): number | null {
  const parts = dateOfBirth.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const [year, month, day] = parts;
  const born = new Date(year, month - 1, day);
  if (
    born.getFullYear() !== year
    || born.getMonth() !== month - 1
    || born.getDate() !== day
  ) return null;
  const today = new Date();
  let age = today.getFullYear() - year;
  if (
    today.getMonth() < month - 1
    || (today.getMonth() === month - 1 && today.getDate() < day)
  ) age -= 1;
  return age;
}

export function AccountOnboarding({
  uid,
  state,
  onComplete,
}: {
  uid: string;
  state: AccountOnboardingState;
  onComplete: (state: AccountOnboardingState) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(state.profile.display_name);
  const [dateOfBirth, setDateOfBirth] = useState(state.profile.date_of_birth ?? "");
  const [gender, setGender] = useState<string | null>(state.profile.gender);
  const [interests, setInterests] = useState(() => {
    const allowed = new Set(state.interest_options.map((option) => option.slug));
    return new Set(state.profile.onboarding_interests.filter((interest) => allowed.has(interest)));
  });
  const [consent, setConsent] = useState(state.profile.aura_consent_granted ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = useMemo(() => new Date(), []);
  const latestBirthDate = useMemo(() => {
    const date = new Date(today.getFullYear() - state.minimum_age, today.getMonth(), today.getDate());
    return dateInputValue(date);
  }, [state.minimum_age, today]);
  const selectedAge = ageFor(dateOfBirth);
  const isMinor = selectedAge !== null && selectedAge < 18;
  const valid = displayName.trim().length > 0
    && displayName.trim().length <= 40
    && selectedAge !== null
    && selectedAge >= state.minimum_age
    && gender !== null
    && interests.size >= state.minimum_interests;

  function toggleInterest(slug: string) {
    setInterests((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  }

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const locale = navigator.language || "en-US";
      const languageCode = locale.split("-")[0];
      const language = new Intl.DisplayNames([locale], { type: "language" }).of(languageCode)
        ?? languageCode;
      const completed = await completeAccountOnboarding(uid, {
        display_name: displayName.trim(),
        date_of_birth: dateOfBirth,
        aura_consent_granted: isMinor ? false : consent,
        gender: gender ?? "",
        onboarding_interests: Array.from(interests),
        locale,
        language,
      });
      await onComplete(completed);
    } catch (err) {
      logError("AccountOnboarding: complete", err);
      setError(err instanceof Error ? err.message : "Aura couldn't save your account setup.");
      setSaving(false);
    }
  }

  return (
    <div className="account-onboarding" aria-labelledby="account-onboarding-heading">
      <div className="account-onboarding-scroll">
        <h2 id="account-onboarding-heading">Help Buddy get to know you</h2>
        <p>These choices belong to your Aura account, so they follow you across desktop and mobile.</p>

        <label className="account-onboarding-field">
          <span>What should Buddy call you?</span>
          <input
            type="text"
            maxLength={40}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>

        <label className="account-onboarding-field">
          <span>Date of birth</span>
          <input
            type="date"
            min="1900-01-01"
            max={latestBirthDate}
            value={dateOfBirth}
            onChange={(event) => setDateOfBirth(event.target.value)}
          />
          <small>Aura is available to users age {state.minimum_age} or older.</small>
        </label>

        <fieldset className="account-onboarding-group">
          <legend>Gender</legend>
          <div className="account-onboarding-choices">
            {[
              ["Male", "male"],
              ["Female", "female"],
              ["Non-binary", "non-binary"],
              ["Prefer not to say", ""],
            ].map(([label, value]) => (
              <button
                key={label}
                type="button"
                className={gender === value ? "is-selected" : ""}
                onClick={() => setGender(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="account-onboarding-group">
          <legend>What should Buddy keep you posted on? Pick {state.minimum_interests} or more.</legend>
          <div className="account-onboarding-choices">
            {state.interest_options.map((option) => (
              <button
                key={option.slug}
                type="button"
                className={interests.has(option.slug) ? "is-selected" : ""}
                onClick={() => toggleInterest(option.slug)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className={`account-onboarding-consent${isMinor ? " is-disabled" : ""}`}>
          <span>
            <strong>{isMinor ? "Aura memory is unavailable under 18" : "Enable Aura memory"}</strong>
            <small>
              {isMinor
                ? "Behavioral profiling is disabled for users under 18."
                : "Buddy can build a private profile from your conversations. Change this anytime in Settings."}
            </small>
          </span>
          <input
            type="checkbox"
            checked={isMinor ? false : consent}
            disabled={isMinor}
            onChange={(event) => setConsent(event.target.checked)}
          />
        </label>
      </div>

      {error && <p className="account-onboarding-error" role="alert">{error}</p>}
      <button
        type="button"
        className="onboarding-primary-button"
        disabled={!valid || saving}
        onClick={() => void submit()}
      >
        {saving ? "Saving..." : "Continue"}
      </button>
    </div>
  );
}
