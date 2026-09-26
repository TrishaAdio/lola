import type { CSSProperties } from "react";
import type { AuraMessage } from "../aura/aura";
import { AURA_VISIBLE_MS } from "../config";

const FADE_MS = 900;

/**
 * Tactics Aura readout: a HUD line above the board, not a toast. It occupies a slot of
 * fixed height so nothing shifts when it appears, slides in, and fades on its own.
 */
export function AuraHud({ message }: { message: (AuraMessage & { id: number }) | null }) {
  return (
    <div className="aura-hud" aria-live="polite">
      {message && (
        <p
          key={message.id}
          className="aura-hud__line"
          data-trigger={message.trigger}
          style={{ "--hud-out-delay": `${AURA_VISIBLE_MS - FADE_MS}ms`, "--hud-out-ms": `${FADE_MS}ms` } as CSSProperties}
        >
          <span className="aura-hud__tick" aria-hidden="true" />
          {message.text}
        </p>
      )}
    </div>
  );
}
