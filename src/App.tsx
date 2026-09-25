import { useState } from "react";
import { PositionSelect } from "./components/PositionSelect";
import { PlayScreen } from "./components/PlayScreen";
import type { GameSetup } from "./hooks/useGame";

export default function App() {
  const [setup, setSetup] = useState<GameSetup | null>(null);
  /** Bumped on rematch to remount the play screen and reset all game state. */
  const [gameId, setGameId] = useState(0);

  if (!setup) {
    return (
      <PositionSelect
        onStart={(next) => {
          setSetup(next);
          setGameId((n) => n + 1);
        }}
      />
    );
  }

  return (
    <PlayScreen
      key={gameId}
      setup={setup}
      onExit={() => setSetup(null)}
      onRematch={() => setGameId((n) => n + 1)}
    />
  );
}
