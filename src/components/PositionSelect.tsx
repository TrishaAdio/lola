import { useEffect, useMemo, useState } from "react";
import { Chessboard } from "react-chessboard";
import type { Color } from "chess.js";
import {
  LIBRARY_POSITIONS,
  STANDARD_FEN,
  randomLegalPosition,
  validateFen,
} from "../chess/positions";
import type { PositionCategory, StartingPosition } from "../chess/positions";
import { ENGINE_TIERS, detectBestTier, isTierAvailable, supportsThreads } from "../engine/tiers";
import type { EngineTierId } from "../engine/types";
import type { GameSetup } from "../hooks/useGame";
import { storedAuraPreference } from "../hooks/useGame";
import { TIME_CONTROLS } from "../hooks/useClock";
import type { DrawClaimMode } from "../chess/rules";
import { boardTheme } from "./boardTheme";

type Tab = "standard" | "library" | "fen" | "chaos";
type StrengthMode = "no-mercy" | "practice";

const CATEGORY_LABEL: Record<PositionCategory, string> = {
  opening: "Openings",
  endgame: "Endgame technique",
  puzzle: "Sharp positions",
};

const STANDARD_POSITION: StartingPosition = {
  id: "standard",
  name: "Standard starting position",
  category: "opening",
  description: "The full game, from move one.",
  fen: STANDARD_FEN,
  history: [],
  suggestedSide: "w",
};

interface Props {
  onStart: (setup: GameSetup) => void;
}

export function PositionSelect({ onStart }: Props) {
  const [tab, setTab] = useState<Tab>("standard");
  const [selected, setSelected] = useState<StartingPosition>(STANDARD_POSITION);
  /**
   * Null means "follow the side on move in the chosen position". An explicit choice
   * overrides it. Derived during render rather than synced in an effect.
   */
  const [sideOverride, setSideOverride] = useState<Color | null>(null);

  const [fenInput, setFenInput] = useState("");
  const [chaos, setChaos] = useState<StartingPosition | null>(null);

  const [tier, setTier] = useState<EngineTierId>("lite-single");
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<StrengthMode>("no-mercy");
  const [depth, setDepth] = useState(20);
  const [movetime, setMovetime] = useState(4000);
  const [skillLevel, setSkillLevel] = useState(20);
  const [capElo, setCapElo] = useState(false);
  const [uciElo, setUciElo] = useState(1800);
  const [strategic, setStrategic] = useState(true);
  const [drawClaims, setDrawClaims] = useState<DrawClaimMode>("claim");
  const [timeControlId, setTimeControlId] = useState("off");
  const [aura, setAura] = useState(storedAuraPreference);
  const [engineMayResign, setEngineMayResign] = useState(false);

  // Probe which engine builds are actually present, then pick the best default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        Object.values(ENGINE_TIERS).map(async (t) => [t.id, await isTierAvailable(t)] as const),
      );
      if (cancelled) return;
      setAvailable(Object.fromEntries(entries));
      setTier(await detectBestTier());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fenCheck = useMemo(() => (tab === "fen" ? validateFen(fenInput) : null), [tab, fenInput]);

  const activePosition: StartingPosition | null = useMemo(() => {
    if (tab === "standard") return STANDARD_POSITION;
    if (tab === "library") return selected.id === "standard" ? null : selected;
    if (tab === "chaos") return chaos;
    if (fenCheck?.ok && fenCheck.fen) {
      return {
        id: "custom-fen",
        name: "Custom position",
        category: "puzzle",
        description: "Loaded from FEN.",
        fen: fenCheck.fen,
        history: [],
        suggestedSide: fenCheck.turn ?? "w",
      };
    }
    return null;
  }, [tab, selected, chaos, fenCheck]);

  // Derived: an explicit choice wins, otherwise follow whoever is on move.
  const userColor: Color = sideOverride ?? activePosition?.suggestedSide ?? "w";

  const grouped = useMemo(() => {
    const out: Record<PositionCategory, StartingPosition[]> = {
      opening: [],
      endgame: [],
      puzzle: [],
    };
    for (const p of LIBRARY_POSITIONS) out[p.category].push(p);
    return out;
  }, []);

  const start = () => {
    if (!activePosition) return;
    onStart({
      fen: activePosition.fen,
      history: activePosition.history,
      userColor,
      positionName: activePosition.name,
      strategic: mode === "no-mercy" ? strategic : false,
      drawClaims,
      aura,
      engineMayResign,
      timeControl: TIME_CONTROLS.find((t) => t.id === timeControlId) ?? null,
      engineConfig: {
        tier,
        threads: Math.min(navigator.hardwareConcurrency || 4, 8),
        hashMb: ENGINE_TIERS[tier].fullNet ? 256 : 128,
        // The strategic layer re-ranks Stockfish's top 5 lines.
        multiPv: mode === "no-mercy" && strategic ? 5 : 1,
        limitStrength: mode === "practice" && capElo,
        skillLevel: mode === "practice" ? skillLevel : 20,
        uciElo,
        limits:
          mode === "practice"
            ? { depth: Math.min(depth, 12), movetimeMs: Math.min(movetime, 800) }
            : { depth, movetimeMs: movetime },
      },
    });
  };

  const engineName = ENGINE_TIERS[tier];

  return (
    <div className="setup">
      <header className="setup__header">
        <h1>
          Ruthless<span className="accent">Chess</span>
        </h1>
        <p className="setup__tagline">
          Stockfish {ENGINE_TIERS[tier].base.split("-")[1]} NNUE, full strength, in your browser.
          It will not offer you a draw and it will not resign.
        </p>
      </header>

      <div className="setup__grid">
        <section className="panel">
          <h2 className="panel__title">Choose your board</h2>

          <div className="tabs">
            {(
              [
                ["standard", "Standard"],
                ["library", "Library"],
                ["fen", "Custom FEN"],
                ["chaos", "Chaos"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`tab ${tab === id ? "tab--active" : ""}`}
                onClick={() => {
                  setTab(id);
                  setSideOverride(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "standard" && (
            <p className="hint">
              The classic game from the initial position. Pick your colour on the right.
            </p>
          )}

          {tab === "library" && (
            <div className="library">
              {(Object.keys(grouped) as PositionCategory[]).map((cat) => (
                <div key={cat} className="library__group">
                  <h3 className="library__heading">{CATEGORY_LABEL[cat]}</h3>
                  <div className="library__items">
                    {grouped[cat].map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`chip ${selected.id === p.id ? "chip--active" : ""}`}
                        onClick={() => {
                          setSelected(p);
                          setSideOverride(null);
                        }}
                        title={p.description}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "fen" && (
            <div className="field">
              <label htmlFor="fen">Paste a FEN</label>
              <textarea
                id="fen"
                rows={3}
                spellCheck={false}
                placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
                value={fenInput}
                onChange={(e) => {
                  setFenInput(e.target.value);
                  setSideOverride(null);
                }}
              />
              {fenInput.trim() && fenCheck && (
                <p className={fenCheck.ok ? "note note--ok" : "note note--bad"}>
                  {fenCheck.ok ? `Valid. ${fenCheck.turn === "w" ? "White" : "Black"} to move.` : fenCheck.error}
                </p>
              )}
              {fenCheck?.ok && fenCheck.removedCastling && (
                <p className="note" data-testid="castling-removed">
                  Castling rights {fenCheck.removedCastling.join("")} removed: king or rook not on its
                  starting square.
                </p>
              )}
            </div>
          )}

          {tab === "chaos" && (
            <div className="field">
              <button type="button" className="btn btn--ghost" onClick={() => {
                  setChaos(randomLegalPosition());
                  setSideOverride(null);
                }}>
                {chaos ? "Generate another" : "Generate a random legal position"}
              </button>
              {chaos && <code className="fen-readout">{chaos.fen}</code>}
            </div>
          )}
        </section>

        <section className="panel">
          <h2 className="panel__title">Preview</h2>
          <div className="preview">
            {activePosition ? (
              <Chessboard
                options={{
                  position: activePosition.fen,
                  boardOrientation: userColor === "w" ? "white" : "black",
                  allowDragging: false,
                  showNotation: true,
                  animationDurationInMs: 0,
                  ...boardTheme,
                }}
              />
            ) : (
              <div className="preview__empty">Select a position to preview it.</div>
            )}
          </div>
          {activePosition && (
            <p className="preview__meta">
              <strong>{activePosition.name}</strong> — {activePosition.description}
            </p>
          )}

          <div className="field">
            <span className="field__label">You play</span>
            <div className="segmented">
              {(
                [
                  ["w", "White"],
                  ["b", "Black"],
                ] as const
              ).map(([c, label]) => (
                <button
                  key={c}
                  type="button"
                  className={`segmented__item ${userColor === c ? "segmented__item--active" : ""}`}
                  onClick={() => setSideOverride(c)}
                >
                  {label}
                </button>
              ))}
            </div>
            {activePosition && activePosition.suggestedSide !== userColor && (
              <p className="note">The engine moves first from this position.</p>
            )}
          </div>
        </section>

        <section className="panel panel--wide">
          <h2 className="panel__title">Engine</h2>

          <div className="field">
            <span className="field__label">Build</span>
            <div className="tier-list">
              {Object.values(ENGINE_TIERS).map((t) => {
                const ok = available[t.id];
                const blockedByHeaders = t.threaded && !supportsThreads();
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={!ok}
                    className={`tier ${tier === t.id ? "tier--active" : ""}`}
                    onClick={() => setTier(t.id)}
                  >
                    <span className="tier__name">{t.label}</span>
                    <span className="tier__size">{t.sizeLabel}</span>
                    <span className="tier__note">
                      {ok
                        ? t.note
                        : blockedByHeaders
                          ? "Needs cross-origin isolation (COOP/COEP)."
                          : "Not installed. Run npm run engine:full."}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="note">
              Every build runs at Skill Level 20 with UCI_LimitStrength off. The difference
              between them is net size and threading, not an artificial handicap.
            </p>
          </div>

          <div className="field">
            <span className="field__label">Strength</span>
            <div className="segmented">
              {(
                [
                  ["no-mercy", "No mercy"],
                  ["practice", "Practice"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  className={`segmented__item ${mode === m ? "segmented__item--active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {mode === "no-mercy" ? (
            <>
              <div className="field field--row">
                <label htmlFor="depth">
                  Depth <output>{depth}</output>
                </label>
                <input
                  id="depth"
                  type="range"
                  min={12}
                  max={32}
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                />
              </div>
              <div className="field field--row">
                <label htmlFor="movetime">
                  Max time per move <output>{(movetime / 1000).toFixed(1)}s</output>
                </label>
                <input
                  id="movetime"
                  type="range"
                  min={500}
                  max={15000}
                  step={500}
                  value={movetime}
                  onChange={(e) => setMovetime(Number(e.target.value))}
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={strategic}
                  onChange={(e) => setStrategic(e.target.checked)}
                />
                <span>
                  Strategic layer. Stockfish's top 5 lines are re-ranked by king safety, activity,
                  pawn structure, plan and prophylaxis. Tactics stay Stockfish's.
                </span>
              </label>
              <p className="note">
                Search stops at depth {depth} or {(movetime / 1000).toFixed(1)}s, whichever comes
                first.
              </p>
            </>
          ) : (
            <>
              <div className="field field--row">
                <label htmlFor="skill">
                  Skill Level <output>{skillLevel}</output>
                </label>
                <input
                  id="skill"
                  type="range"
                  min={0}
                  max={20}
                  value={skillLevel}
                  onChange={(e) => setSkillLevel(Number(e.target.value))}
                />
              </div>
              <label className="check">
                <input type="checkbox" checked={capElo} onChange={(e) => setCapElo(e.target.checked)} />
                <span>Cap rating with UCI_LimitStrength</span>
              </label>
              {capElo && (
                <div className="field field--row">
                  <label htmlFor="elo">
                    Target Elo <output>{uciElo}</output>
                  </label>
                  <input
                    id="elo"
                    type="range"
                    min={1320}
                    max={3190}
                    step={10}
                    value={uciElo}
                    onChange={(e) => setUciElo(Number(e.target.value))}
                  />
                </div>
              )}
              <p className="note">
                Below 20, Stockfish deliberately picks weaker moves. Search is also capped to a
                shallow depth and a short clock.
              </p>
            </>
          )}

          <div className="settings">
            <div className="field">
              <span className="field__label">Repetition and 50-move draws</span>
              <div className="segmented">
                {(
                  [
                    ["claim", "Claimable"],
                    ["automatic", "Automatic"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    className={`segmented__item ${drawClaims === m ? "segmented__item--active" : ""}`}
                    onClick={() => setDrawClaims(m)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="note">
                {drawClaims === "claim"
                  ? "FIDE over-the-board: you claim them. Fivefold and 75 moves end the game on their own."
                  : "Chess.com online: the game ends the moment they occur."}
              </p>
            </div>

            <div className="field">
              <label htmlFor="clock">Clock</label>
              <select
                id="clock"
                className="select"
                value={timeControlId}
                onChange={(e) => setTimeControlId(e.target.value)}
              >
                <option value="off">Off</option>
                {TIME_CONTROLS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="check">
              <input type="checkbox" checked={aura} onChange={(e) => setAura(e.target.checked)} />
              <span>Tactics Aura</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={engineMayResign}
                onChange={(e) => setEngineMayResign(e.target.checked)}
              />
              <span>Engine may resign lost endgames</span>
            </label>
          </div>

          <button type="button" className="btn btn--primary" disabled={!activePosition} onClick={start}>
            {activePosition ? `Play ${engineName.fullNet ? "full" : "lite"} Stockfish` : "Pick a position first"}
          </button>
        </section>
      </div>
    </div>
  );
}
