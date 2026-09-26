import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { setPrefs, usePrefs } from "../settings/prefs";
import { THEMES } from "../theme/themes";
import type { ThemeId } from "../theme/themes";

/** Theme swatches plus sound and aura switches. Shared by the setup screen and the game. */
export function PrefsControls() {
  const prefs = usePrefs();
  return (
    <div className="prefs">
      <div className="field">
        <span className="field__label">Board</span>
        <div className="swatches" role="radiogroup" aria-label="Board theme">
          {Object.values(THEMES).map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={prefs.theme === t.id}
              className={`swatch ${prefs.theme === t.id ? "swatch--active" : ""}`}
              onClick={() => setPrefs({ theme: t.id as ThemeId })}
              data-theme-id={t.id}
            >
              <span className="swatch__board" aria-hidden="true">
                <span style={{ background: t.squareLight }} />
                <span style={{ background: t.squareDark }} />
                <span style={{ background: t.squareDark }} />
                <span style={{ background: t.squareLight }} />
              </span>
              <span className="swatch__name">{t.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="switches">
        <Switch label="Sound" checked={prefs.soundOn} onChange={(v) => setPrefs({ soundOn: v })} />
        <Switch
          label="Board sounds"
          checked={prefs.boardSounds}
          disabled={!prefs.soundOn}
          onChange={(v) => setPrefs({ boardSounds: v })}
        />
        <Switch
          label="Aura sounds"
          checked={prefs.auraSounds}
          disabled={!prefs.soundOn}
          onChange={(v) => setPrefs({ auraSounds: v })}
        />
        <Switch label="Aura lines" checked={prefs.auraMessages} onChange={(v) => setPrefs({ auraMessages: v })} />
      </div>
    </div>
  );
}

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`switch ${disabled ? "switch--disabled" : ""}`}>
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track" aria-hidden="true" />
    </label>
  );
}

/** Gear button opening PrefsControls in a popover. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="settings-menu" ref={ref}>
      <button
        type="button"
        className="icon-btn"
        aria-label="Settings"
        aria-expanded={open}
        title="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        <Settings2 size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="settings-menu__panel" role="dialog" aria-label="Settings">
          <PrefsControls />
        </div>
      )}
    </div>
  );
}
