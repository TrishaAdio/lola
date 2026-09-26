/**
 * Tunable UI constants. Change timing here, not at the call sites.
 */

/** Seconds the final position stays on screen before the post-game summary opens. */
export const GAME_OVER_REVIEW_SECONDS = 60;

/**
 * Time given to the final move's animation and end-state effects (mate glow, sound)
 * before the result strip appears.
 */
export const END_EFFECTS_MS = 900;

/** Piece movement. Ease-out cubic: fast departure, soft landing. */
export const MOVE_ANIMATION_MS = 190;
export const MOVE_EASING = "cubic-bezier(0.215, 0.61, 0.355, 1)";

/** Captured piece shrink-and-fade. */
export const CAPTURE_FADE_MS = 240;

/** How long a Tactics Aura line stays up. */
export const AURA_VISIBLE_MS = 6500;

/** Threat highlights after the engine's move. */
export const THREAT_VISIBLE_MS = 4500;
