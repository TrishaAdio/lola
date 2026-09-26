/**
 * Persisted UI preferences: one small external store, so every component reads the same
 * values without a provider tree.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_THEME, THEMES } from "../theme/themes";
import type { ThemeId } from "../theme/themes";

export interface Prefs {
  theme: ThemeId;
  /** Master switch for every sound. */
  soundOn: boolean;
  /** Move, capture, check and game-end sounds. */
  boardSounds: boolean;
  /** The cue that accompanies a Tactics Aura line. */
  auraSounds: boolean;
  /** Tactics Aura lines themselves. */
  auraMessages: boolean;
}

const STORAGE_KEY = "ruthless-chess:prefs";
const LEGACY_AURA_KEY = "ruthless-chess:aura";

const DEFAULTS: Prefs = {
  theme: DEFAULT_THEME,
  soundOn: true,
  boardSounds: true,
  auraSounds: true,
  auraMessages: true,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    const legacyAura = localStorage.getItem(LEGACY_AURA_KEY);
    const merged: Prefs = { ...DEFAULTS, ...parsed };
    if (!raw && legacyAura) merged.auraMessages = legacyAura !== "off";
    if (!(merged.theme in THEMES)) merged.theme = DEFAULT_THEME;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

let current: Prefs = typeof window === "undefined" ? { ...DEFAULTS } : load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}
