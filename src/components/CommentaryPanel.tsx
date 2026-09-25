import { useMemo } from "react";
import type { Color } from "chess.js";
import { formatSanLine, pvToSan } from "../chess/moves";
import { glossFromPv } from "../chess/gloss";
import { formatScore, winProbability } from "../chess/evaluation";
import type { EngineInfo } from "../engine/types";
import type { PolicyDecision } from "../engine/policy";

const REASON_TEXT: Record<PolicyDecision["reason"], string> = {
  "only-move": "Forced — no alternative.",
  "fastest-mate": "Forced mate found. Playing the shortest line.",
  "avoid-draw": "Equal alternatives led to a repetition. Refused it.",
  "pressure-tiebreak": "Equal on eval, so it chose the move that keeps the most pressure.",
  "best-eval": "Highest evaluation.",
};

interface Props {
  /** Live search info while the engine is thinking. */
  liveInfo: EngineInfo | null;
  /** Position the live search is running on. */
  liveFen: string;
  /** The engine's last completed decision. */
  decision: PolicyDecision | null;
  thinking: boolean;
  /** Side the live search is evaluating for. */
  searchTurn: Color;
}

function WdlBar({ wdl }: { wdl: [number, number, number] }) {
  const total = wdl[0] + wdl[1] + wdl[2] || 1;
  const pct = (v: number) => `${((v / total) * 100).toFixed(0)}%`;
  return (
    <div className="wdl">
      <div className="wdl__bar">
        <span className="wdl__win" style={{ width: pct(wdl[0]) }} />
        <span className="wdl__draw" style={{ width: pct(wdl[1]) }} />
        <span className="wdl__loss" style={{ width: pct(wdl[2]) }} />
      </div>
      <span className="wdl__legend">
        win {pct(wdl[0])} · draw {pct(wdl[1])} · loss {pct(wdl[2])}
      </span>
    </div>
  );
}

export function CommentaryPanel({ liveInfo, liveFen, decision, thinking, searchTurn }: Props) {
  const live = useMemo(() => {
    if (!liveInfo) return null;
    const san = pvToSan(liveFen, liveInfo.pv, 10);
    return {
      line: formatSanLine(liveFen, san),
      score: formatScore(liveInfo, searchTurn),
      gloss: glossFromPv(liveFen, liveInfo),
      winPct: Math.round(winProbability(liveInfo) * 100),
    };
  }, [liveInfo, liveFen, searchTurn]);

  const done = useMemo(() => {
    if (!decision) return null;
    const probe = decision.candidates[0]?.info;
    if (!probe) return null;
    const turn: Color = decision.fen.split(" ")[1] === "w" ? "w" : "b";
    return {
      turn,
      chosenLine: formatSanLine(
        decision.fen,
        pvToSan(decision.fen, decision.chosen.info.pv, 10),
      ),
      gloss: glossFromPv(decision.fen, decision.chosen.info),
      score: formatScore(decision.chosen.info, turn),
      winPct: Math.round(winProbability(decision.chosen.info) * 100),
    };
  }, [decision]);

  return (
    <div className="commentary">
      <div className="commentary__head">
        <h3>Engine reasoning</h3>
        {thinking && <span className="pulse">searching</span>}
      </div>

      {thinking && live && (
        <div className="commentary__body">
          <div className="statline">
            <span className="statline__score">{live.score.text}</span>
            <span className="statline__meta">
              depth {liveInfo!.depth}
              {liveInfo!.seldepth ? `/${liveInfo!.seldepth}` : ""}
              {liveInfo!.nodes ? ` · ${(liveInfo!.nodes / 1000).toFixed(0)}k nodes` : ""}
              {liveInfo!.nps ? ` · ${(liveInfo!.nps / 1000).toFixed(0)}k nps` : ""}
            </span>
          </div>
          {liveInfo!.wdl ? (
            <WdlBar wdl={liveInfo!.wdl} />
          ) : (
            <p className="commentary__win">win probability {live.winPct}%</p>
          )}
          {live.gloss && <p className="commentary__gloss">{live.gloss}</p>}
          <p className="commentary__pv">{live.line}</p>
        </div>
      )}

      {!thinking && done && decision && (
        <div className="commentary__body">
          <div className="statline">
            <span className="statline__score">{done.score.text}</span>
            <span className="statline__meta">
              depth {decision.chosen.info.depth} · played <strong>{decision.san}</strong>
            </span>
          </div>
          {decision.chosen.info.wdl ? (
            <WdlBar wdl={decision.chosen.info.wdl} />
          ) : (
            <p className="commentary__win">win probability {done.winPct}%</p>
          )}

          <p className={`verdict verdict--${decision.reason}`}>{REASON_TEXT[decision.reason]}</p>
          {done.gloss && <p className="commentary__gloss">{done.gloss}</p>}
          <p className="commentary__pv">{done.chosenLine}</p>

          {decision.candidates.length > 1 && (
            <table className="cands">
              <thead>
                <tr>
                  <th>move</th>
                  <th>eval</th>
                  <th>replies</th>
                  <th>pressure</th>
                </tr>
              </thead>
              <tbody>
                {decision.candidates.map((c) => (
                  <tr
                    key={c.uci}
                    className={[
                      c.uci === decision.uci ? "cands__row--chosen" : "",
                      c.contested ? "cands__row--pool" : "",
                    ].join(" ")}
                  >
                    <td>
                      {c.san}
                      {c.uci === decision.uci && (
                        <span className="cands__mark" aria-label="played" />
                      )}
                    </td>
                    <td>{formatScore(c.info, done.turn).text}</td>
                    <td>{c.report.replies}</td>
                    <td>
                      {c.allowsDrawClaim ? "draw" : Math.round(c.pressure.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {decision.overrode && (
            <p className="note">
              Stockfish's first choice was {decision.overrode.san}; the tie-break preferred{" "}
              {decision.san} at equal evaluation.
            </p>
          )}
        </div>
      )}

      {!thinking && !done && <p className="commentary__idle">Waiting for the first search.</p>}
    </div>
  );
}
