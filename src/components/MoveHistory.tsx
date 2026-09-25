import { useEffect, useRef } from "react";
import type { MoveRecord } from "../chess/analysis";

interface Props {
  records: MoveRecord[];
  startingTurn: "w" | "b";
  startingMoveNumber: number;
}

interface Row {
  number: number;
  white?: MoveRecord;
  black?: MoveRecord;
}

/** Groups plies into numbered rows, handling positions that start on Black's move. */
function toRows(records: MoveRecord[], startingTurn: "w" | "b", startNumber: number): Row[] {
  const rows: Row[] = [];
  let number = startNumber;
  let expectWhite = startingTurn === "w";

  for (const record of records) {
    if (expectWhite) {
      rows.push({ number, white: record });
    } else {
      const last = rows[rows.length - 1];
      if (last && !last.black) last.black = record;
      else rows.push({ number, black: record });
      number++;
    }
    expectWhite = !expectWhite;
  }
  return rows;
}

export function MoveHistory({ records, startingTurn, startingMoveNumber }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = toRows(records, startingTurn, startingMoveNumber);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [records.length]);

  return (
    <div className="history">
      <div className="history__scroll" ref={scrollRef}>
        {rows.length === 0 ? (
          <p className="history__empty">No moves yet.</p>
        ) : (
          <table className="history__table">
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.number}-${i}`}>
                  <td className="history__num">{row.number}.</td>
                  <td className={row.white?.byEngine ? "history__move history__move--engine" : "history__move"}>
                    {row.white?.san ?? ""}
                  </td>
                  <td className={row.black?.byEngine ? "history__move history__move--engine" : "history__move"}>
                    {row.black?.san ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
