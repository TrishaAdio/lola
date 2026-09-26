import { useEffect, useState } from "react";
import { PositionSelect } from "./components/PositionSelect";
import { PlayScreen } from "./components/PlayScreen";
import type { GameSetup } from "./hooks/useGame";
import { PieceDefs } from "./pieces/PieceSet";
import { usePrefs } from "./settings/prefs";
import { applyTheme } from "./theme/themes";
import { installAudioUnlock } from "./audio/sound";

export default function App() {
  const [setup, setSetup] = useState<GameSetup | null>(null);
  /** Bumped on rematch to remount the play screen and reset all game state. */
  const [gameId, setGameId] = useState(0);
  const { theme } = usePrefs();

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => installAudioUnlock(), []);

  return (
    <>
      <PieceDefs />
      {setup ? (
        <PlayScreen
          key={gameId}
          setup={setup}
          onExit={() => setSetup(null)}
          onRematch={() => setGameId((n) => n + 1)}
        />
      ) : (
        <PositionSelect
          onStart={(next) => {
            setSetup(next);
            setGameId((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
