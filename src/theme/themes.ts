/**
 * Board themes. Each theme is one palette for squares, notation, highlights and pieces,
 * applied as CSS custom properties so the SVG pieces, the board and the UI chrome all
 * restyle together without re-exporting any asset.
 */

export interface PiecePalette {
  /** Top of the body gradient (the lit edge) and its base. */
  bodyHi: string;
  body: string;
  ink: string;
  /** Inner lines on dark pieces. */
  detail: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  squareLight: string;
  squareDark: string;
  lastMove: string;
  selected: string;
  target: string;
  /** Soft ring on a king in check. */
  checkGlow: string;
  light: PiecePalette;
  dark: PiecePalette;
}

export type ThemeId = "slate" | "oxblood" | "glacier";

export const THEMES: Record<ThemeId, Theme> = {
  slate: {
    id: "slate",
    name: "Slate",
    squareLight: "#a7b0bd",
    squareDark: "#5b6576",
    lastMove: "rgba(214, 181, 110, 0.42)",
    selected: "rgba(214, 181, 110, 0.6)",
    target: "rgba(24, 28, 34, 0.38)",
    checkGlow: "rgba(236, 88, 72, 0.9)",
    light: { bodyHi: "#ffffff", body: "#e2dccf", ink: "#1b1f26", detail: "#1b1f26" },
    dark: { bodyHi: "#3a3f48", body: "#15181d", ink: "#07080a", detail: "#c9a96e" },
  },
  oxblood: {
    id: "oxblood",
    name: "Oxblood",
    squareLight: "#dccab0",
    squareDark: "#8c4b45",
    lastMove: "rgba(238, 196, 120, 0.46)",
    selected: "rgba(238, 196, 120, 0.62)",
    target: "rgba(40, 18, 16, 0.34)",
    checkGlow: "rgba(255, 120, 84, 0.9)",
    light: { bodyHi: "#fffcf4", body: "#e8dcc4", ink: "#2b1713", detail: "#2b1713" },
    dark: { bodyHi: "#3b2a27", body: "#1a1110", ink: "#080404", detail: "#d9a066" },
  },
  glacier: {
    id: "glacier",
    name: "Glacier",
    squareLight: "#d3dee6",
    squareDark: "#6a8698",
    lastMove: "rgba(120, 190, 230, 0.42)",
    selected: "rgba(120, 190, 230, 0.6)",
    target: "rgba(16, 28, 40, 0.34)",
    checkGlow: "rgba(236, 96, 96, 0.9)",
    light: { bodyHi: "#ffffff", body: "#dde6ee", ink: "#142130", detail: "#142130" },
    dark: { bodyHi: "#2c3b4a", body: "#0f1822", ink: "#04080c", detail: "#a8cbe2" },
  },
};

export const DEFAULT_THEME: ThemeId = "slate";

/** CSS custom properties for a theme. */
export function themeVariables(theme: Theme): Record<string, string> {
  return {
    "--sq-light": theme.squareLight,
    "--sq-dark": theme.squareDark,
    "--hl-last": theme.lastMove,
    "--hl-selected": theme.selected,
    "--hl-target": theme.target,
    "--hl-check": theme.checkGlow,
    "--pw-body-hi": theme.light.bodyHi,
    "--pw-body": theme.light.body,
    "--pw-ink": theme.light.ink,
    "--pw-detail": theme.light.detail,
    "--pb-body-hi": theme.dark.bodyHi,
    "--pb-body": theme.dark.body,
    "--pb-ink": theme.dark.ink,
    "--pb-detail": theme.dark.detail,
  };
}

/** Applies a theme to the whole document. */
export function applyTheme(id: ThemeId) {
  const theme = THEMES[id] ?? THEMES[DEFAULT_THEME];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVariables(theme))) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
}

// ---- colour maths, used by the contrast tests -------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
