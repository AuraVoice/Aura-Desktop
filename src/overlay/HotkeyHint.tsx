import "./HotkeyHint.css";

interface HotkeyHintProps {
  keys: readonly string[];
  action: string;
}

export function HotkeyHint({ keys, action }: HotkeyHintProps) {
  return (
    <span className="hotkey-hint">
      <span className="hotkey-hint-keys">
        {keys.map((key) => (
          <span key={key} className="hotkey-keycap">
            {key}
          </span>
        ))}
      </span>
      <span className="hotkey-hint-action">{action}</span>
    </span>
  );
}
