import { useEffect, useState } from "react";
import {
  captureShortcut,
  findConflict,
  isDoubleTapAccelerator,
  loadDoubleTapPermission,
  requestDoubleTapPermission,
  type DoubleTapPermission,
  updateHotkeyBinding,
  updateVoiceToggleKey,
  DOUBLE_TAP_PRESETS,
  type HotkeyBinding,
  type VoiceToggleKeyStatus,
} from "../lib/hotkeys";
import "./ShortcutEditorDialog.css";

interface ShortcutEditorDialogProps {
  /** A hotkey id from SPECS, or "voice" for the talk trigger. */
  id: string;
  label: string;
  bindings: HotkeyBinding[];
  voice: VoiceToggleKeyStatus | null;
  onSavedBindings: (next: HotkeyBinding[]) => void;
  onSavedVoice: (next: VoiceToggleKeyStatus) => void;
  onClose: () => void;
}

interface Candidate {
  accelerator: string;
  keys: string[];
  /** Advisory only. A candidate with a warning still saves. */
  warning?: string;
  /** Set when the pick is a double-tap preset rather than a captured chord. */
  doubleTap?: boolean;
}

/** The one place a shortcut gets rebound, shared by first-run onboarding and
 * Settings. Rust re-validates everything on save; the checks here exist so the
 * user sees the problem while pressing keys instead of after clicking Save. */
export function ShortcutEditorDialog({
  id,
  label,
  bindings,
  voice,
  onSavedBindings,
  onSavedVoice,
  onClose,
}: ShortcutEditorDialogProps) {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Only the double-tap gesture needs an OS grant: it watches raw keystrokes,
  // which macOS gates behind Input Monitoring. A chord is registered through
  // Carbon and needs nothing, so this is fetched but only ever shown once a
  // double-tap preset is the pending pick.
  const [tapPermission, setTapPermission] = useState<DoubleTapPermission | null>(null);
  const [permissionAsked, setPermissionAsked] = useState(false);

  const isVoice = id === "voice";
  useEffect(() => {
    if (!isVoice) return;
    let cancelled = false;
    void loadDoubleTapPermission()
      .then((next) => { if (!cancelled) setTapPermission(next); })
      .catch(() => { if (!cancelled) setTapPermission(null); });
    return () => { cancelled = true; };
  }, [isVoice]);
  const conflict = candidate && !candidate.doubleTap
    ? findConflict(candidate.accelerator, bindings, voice, id)
    : null;

  function capture(event: React.KeyboardEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    // Escape closes rather than binds, so it never reaches captureShortcut.
    if (event.code === "Escape") {
      onClose();
      return;
    }
    const result = captureShortcut(event.nativeEvent);
    if (result.kind === "pending") return;
    if (result.kind === "rejected") {
      setCandidate(null);
      setError(result.reason);
      return;
    }
    setError(null);
    setCandidate({ accelerator: result.accelerator, keys: result.keys, warning: result.warning });
  }

  async function save() {
    if (!candidate || conflict) return;
    setSaving(true);
    setError(null);
    try {
      if (isVoice) {
        onSavedVoice(await updateVoiceToggleKey(candidate.accelerator));
      } else {
        onSavedBindings(await updateHotkeyBinding(id, candidate.accelerator));
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="shortcut-editor-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="shortcut-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-editor-title"
        tabIndex={0}
        onKeyDown={capture}
        onMouseDown={(event) => event.stopPropagation()}
        ref={(node) => node?.focus()}
      >
        <h3 id="shortcut-editor-title">{label}</h3>
        <p className="shortcut-editor-hint">
          {isVoice
            ? "Press the keys you want, or pick a key to double-tap below."
            : "Press the keys you want to use."}
        </p>

        <div className="shortcut-editor-candidate">
          {candidate
            ? candidate.keys.map((key, index) => (
                <span key={`${key}:${index}`}>
                  {index > 0 && <b>+</b>}
                  <kbd>{key}</kbd>
                </span>
              ))
            : <span className="shortcut-editor-placeholder">Waiting for keys</span>}
          {candidate?.doubleTap && <span className="shortcut-editor-twice">twice</span>}
        </div>

        {conflict && (
          <p className="shortcut-editor-error" role="alert">{conflict.label} already uses that shortcut.</p>
        )}
        {!conflict && error && <p className="shortcut-editor-error" role="alert">{error}</p>}
        {!conflict && !error && candidate?.warning && (
          <p className="shortcut-editor-warning">{candidate.warning}</p>
        )}

        {isVoice && (
          <div className="shortcut-editor-presets">
            <span className="shortcut-editor-presets-label">Double-tap instead</span>
            <div className="shortcut-editor-presets-row">
              {DOUBLE_TAP_PRESETS.map((preset) => (
                <button
                  key={preset.accelerator}
                  type="button"
                  className={candidate?.accelerator === preset.accelerator ? "selected" : ""}
                  onClick={() => {
                    setError(null);
                    setCandidate({
                      accelerator: preset.accelerator,
                      keys: [preset.label],
                      doubleTap: true,
                      warning: isDoubleTapAccelerator(preset.accelerator) && preset.accelerator === "ShiftLeft"
                        ? "Left Shift is the one most people hold while typing. Right Shift misfires less."
                        : undefined,
                    });
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {candidate?.doubleTap && tapPermission?.required && !tapPermission.granted && (
              <div className="shortcut-editor-permission">
                <p>
                  Double-tap has to watch your keystrokes, so macOS needs to allow it.
                  A key combination works straight away instead.
                </p>
                <button
                  type="button"
                  className="shortcut-editor-permission-button"
                  onClick={() => {
                    setPermissionAsked(true);
                    void requestDoubleTapPermission()
                      .then(setTapPermission)
                      .catch(() => undefined);
                  }}
                >
                  {permissionAsked ? "Open System Settings again" : "Allow in System Settings"}
                </button>
                {permissionAsked && (
                  // macOS reads this grant once at launch, so it cannot take
                  // effect in the running process however long we wait.
                  <p className="shortcut-editor-permission-note">
                    Turn on Aura under Input Monitoring, then restart Aura to finish.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="shortcut-editor-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!candidate || !!conflict || saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save shortcut"}
          </button>
        </div>
      </div>
    </div>
  );
}
