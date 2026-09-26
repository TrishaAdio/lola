# Assets and credits

## Pieces

`assets/pieces/cburnett/` holds the unmodified source SVGs: the Cburnett set by
[Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett), GPLv2 or later (as
listed in [Lichess's COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md);
also available under GFDL / CC BY-SA 3.0 on
[Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces)).

The app does not ship them stock. `scripts/build-pieces.mjs` resolves every element's paint
to a role (body, ink, detail) and writes `src/pieces/geometry.generated.ts`;
`src/pieces/PieceSet.tsx` then restyles the set:

- colours are CSS variables supplied by the active board theme, never hex in the asset
- bodies use a vertical gradient with a lit top edge instead of flat fill
- outlines use each theme's ink colour rather than pure black
- dark pieces carry a metallic detail colour on their inner lines
- a consistent 1.5 stroke weight with round joins across all twelve pieces
- a soft drop shadow lifts pieces off the board

The same component draws pieces on the board, in the captured tray and in the promotion
dialog, so there is one piece language everywhere.

## Board themes

Slate, Oxblood and Glacier, defined in `src/theme/themes.ts`. `themes.test.ts` enforces
legibility for each one (piece/square and detail/body contrast) and checks none of them
is the stock green/cream or brown/tan board.

## Icons

[Lucide](https://lucide.dev) (ISC), and only Lucide. Line icons in `currentColor`, so they
follow the theme.

## Sounds

`public/sounds/*.wav` are rendered by `scripts/build-sounds.mjs`; they are not recordings
or library samples. Every sound comes from one modal-synthesis model of a boxwood piece, a
felt-topped board, and a wooden bar under a felt mallet, with one damping law for all
modes, so the set shares a single material. The mix pass matches every file to the same
maximum momentary loudness (ITU-R BS.1770-4) under a -1.5 dBFS peak ceiling;
`src/audio/sounds.test.ts` fails if any file drifts off target or clips.

To replace a sound with a recording, drop a 48 kHz 16-bit mono WAV with the same name into
`public/sounds/` and run the tests. They check its level against the rest of the set.
