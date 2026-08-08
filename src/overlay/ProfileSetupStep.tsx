import { useEffect, useState } from "react";
import { Store } from "@tauri-apps/plugin-store";
import {
  desktopProfileSyncedForUidKey,
  desktopRoleForUidKey,
  desktopWhereHeardForUidKey,
  overlayStorePath,
  role as roleCopy,
  whereHeard as whereHeardCopy,
} from "../lib/copy";
import { setPersonProperties } from "../lib/analytics";
import {
  recordDesktopOnboardingEvent,
  syncProfileOnSignIn,
  type StoredAnswer,
} from "../lib/profile";
import { trackOnboardingStepCompleted } from "../lib/acquisitionAnalytics";
import { logError } from "../lib/log";
import "./ProfileSetupStep.css";

interface ChoiceOption {
  id: string;
  label: string;
}

interface QuestionProps {
  heading: string;
  options: readonly ChoiceOption[];
  selected: StoredAnswer | null;
  otherPlaceholder: string;
  onChange: (answer: StoredAnswer) => void;
}

function Question({
  heading,
  options,
  selected,
  otherPlaceholder,
  onChange,
}: QuestionProps) {
  return (
    <fieldset className="profile-question">
      <legend>{heading}</legend>
      <div className="profile-choice-grid" role="radiogroup" aria-label={heading}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected?.id === option.id}
            className={`profile-choice${selected?.id === option.id ? " profile-choice-selected" : ""}`}
            onClick={() => onChange({ id: option.id })}
          >
            {option.label}
          </button>
        ))}
      </div>
      {selected?.id === "other" && (
        <input
          type="text"
          className="profile-other-input"
          placeholder={otherPlaceholder}
          value={selected.other ?? ""}
          onChange={(event) => onChange({ id: "other", other: event.target.value })}
        />
      )}
    </fieldset>
  );
}

export function ProfileSetupStep({
  uid,
  onContinue,
}: {
  uid: string;
  onContinue: () => void;
}) {
  const [whereHeard, setWhereHeard] = useState<StoredAnswer | null>(null);
  const [role, setRole] = useState<StoredAnswer | null>(null);
  const [resolved, setResolved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Store.load(overlayStorePath)
      .then(async (store) => {
        const [savedWhereHeard, savedRole] = await Promise.all([
          store.get<StoredAnswer>(desktopWhereHeardForUidKey(uid)),
          store.get<StoredAnswer>(desktopRoleForUidKey(uid)),
        ]);
        if (cancelled) return;
        setWhereHeard(savedWhereHeard ?? null);
        setRole(savedRole ?? null);
        setResolved(true);
      })
      .catch((err) => {
        logError("ProfileSetupStep: load", err);
        if (!cancelled) {
          setError("Aura couldn't load this screen. Please try again.");
          setResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveAndContinue() {
    if (!whereHeard || !role || saving) return;
    setSaving(true);
    setError(null);
    try {
      const store = await Store.load(overlayStorePath);
      await Promise.all([
        store.set(desktopWhereHeardForUidKey(uid), {
          ...whereHeard,
          other: whereHeard.other?.trim() || undefined,
        }),
        store.set(desktopRoleForUidKey(uid), {
          ...role,
          other: role.other?.trim() || undefined,
        }),
        store.set(desktopProfileSyncedForUidKey(uid), false),
      ]);

      const properties: Record<string, unknown> = {
        where_heard: whereHeard.id,
        role: role.id,
      };
      if (whereHeard.other?.trim()) properties.where_heard_other = whereHeard.other.trim();
      if (role.other?.trim()) properties.role_other = role.other.trim();
      setPersonProperties(properties, uid);
      await recordDesktopOnboardingEvent(
        "desktop_profile_answers_saved",
        properties,
        "profile_answers_saved",
      );

      await Promise.all([
        trackOnboardingStepCompleted("where_heard"),
        trackOnboardingStepCompleted("role"),
        syncProfileOnSignIn(uid),
      ]);
      onContinue();
    } catch (err) {
      logError("ProfileSetupStep: save", err);
      setError("Aura couldn't save your answers. Please try again.");
      setSaving(false);
    }
  }

  if (!resolved) return null;

  return (
    <div className="onboarding-step onboarding-profile-step">
      <Question
        heading={whereHeardCopy.heading}
        options={whereHeardCopy.options}
        selected={whereHeard}
        otherPlaceholder={whereHeardCopy.otherPlaceholder}
        onChange={setWhereHeard}
      />
      <div className="profile-question-divider" aria-hidden="true" />
      <Question
        heading={roleCopy.heading}
        options={roleCopy.options}
        selected={role}
        otherPlaceholder={roleCopy.otherPlaceholder}
        onChange={setRole}
      />

      {error && <p className="profile-save-error" role="alert">{error}</p>}
      <button
        type="button"
        className="profile-continue-button"
        disabled={!whereHeard || !role || saving}
        onClick={() => void saveAndContinue()}
      >
        {saving ? "Saving..." : "Continue"}
      </button>
    </div>
  );
}
