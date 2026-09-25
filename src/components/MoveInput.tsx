import { useState } from "react";

interface Props {
  disabled: boolean;
  onSubmit: (san: string) => string | null;
}

/** Text entry for algebraic notation, for players who would rather type than drag. */
export function MoveInput({ disabled, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const err = onSubmit(value);
    setError(err);
    if (!err) setValue("");
  };

  return (
    <form className="moveinput" onSubmit={submit}>
      <input
        type="text"
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder={disabled ? "Engine is thinking…" : "Type a move — Nf3, e4, O-O, exd5, e8=Q"}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        aria-label="Move in algebraic notation"
      />
      <button type="submit" className="btn btn--ghost" disabled={disabled || !value.trim()}>
        Play
      </button>
      {error && <p className="moveinput__error">{error}</p>}
    </form>
  );
}
