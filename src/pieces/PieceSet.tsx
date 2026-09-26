/**
 * The app's piece set: Cburnett geometry (GPLv2+, Colin M.L. Burnett), restyled.
 *
 * - Every colour is a CSS variable, so a theme recolours the set without new assets.
 * - Bodies take a soft vertical gradient (lit top edge) instead of flat fill.
 * - Outlines use the theme's ink colour, never pure black; dark pieces get a metallic
 *   detail colour for their inner lines.
 * - One stroke weight and round joins across all twelve pieces.
 *
 * Gradients are defined once in <PieceDefs/> and referenced by id, so hundreds of piece
 * renders share them.
 */
import type { CSSProperties } from "react";
import { PIECE_GEOMETRY } from "./geometry.generated";
import type { PieceElement, PieceRole } from "./geometry.generated";

const STROKE_WIDTH = 1.5;

type Side = "w" | "b";

function paint(role: PieceRole | null, side: Side, kind: "fill" | "stroke"): string {
  if (!role) return "none";
  if (role === "body") return kind === "fill" ? `url(#rc-body-${side})` : `var(--p${side}-body)`;
  return `var(--p${side}-${role})`;
}

function Element({ el, side }: { el: PieceElement; side: Side }) {
  const common = {
    fill: paint(el.fill, side, "fill"),
    stroke: paint(el.stroke, side, "stroke"),
    strokeWidth: el.stroke ? (el.strokeWidth === 1 ? 1 : STROKE_WIDTH) : undefined,
    strokeLinecap: el.linecap,
    strokeLinejoin: el.stroke ? "round" : undefined,
    fillRule: el.fillRule,
  } as const;
  if (el.tag === "circle") return <circle cx={el.cx} cy={el.cy} r={el.r} {...common} />;
  return <path d={el.d} {...common} />;
}

export interface PieceSvgProps {
  /** e.g. "wN", "bQ" */
  code: string;
  style?: CSSProperties;
  className?: string;
}

export function PieceSvg({ code, style, className }: PieceSvgProps) {
  const elements = PIECE_GEOMETRY[code];
  if (!elements) return null;
  const side = code[0] as Side;
  return (
    <svg
      viewBox="0 0 45 45"
      width="100%"
      height="100%"
      className={["piece", `piece--${side}`, className].filter(Boolean).join(" ")}
      style={style}
      aria-hidden="true"
      focusable="false"
      data-piece-code={code}
    >
      {elements.map((el, i) => (
        <Element key={i} el={el} side={side} />
      ))}
    </svg>
  );
}

/** Shared gradient definitions. Mount once, near the root. */
export function PieceDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        {(["w", "b"] as const).map((side) => (
          <linearGradient key={side} id={`rc-body-${side}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: `var(--p${side}-body-hi)` }} />
            <stop offset="0.55" style={{ stopColor: `var(--p${side}-body)` }} />
            <stop offset="1" style={{ stopColor: `var(--p${side}-body)` }} />
          </linearGradient>
        ))}
      </defs>
    </svg>
  );
}
