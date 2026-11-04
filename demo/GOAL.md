# Goal: Pocket Board

## What to build

**Pocket Board**, a small, fast task board that runs in the browser with no server. One person keeps a few lists of cards (To do, Doing, Done by default), moves cards between them by dragging or with the keyboard, and their board is still there when they come back. It should look good enough to show on screen: clean layout, readable type, a light and a dark theme.

## Must have

- A board with three columns (To do, Doing, Done). The user can add, rename and delete columns.
- Cards with a title and an optional note. Add, edit, delete.
- Move a card within and between columns by drag and drop, and with the keyboard (focus a card, then arrow keys move it; Enter edits; Delete deletes after a confirmation).
- The board is saved to `localStorage` on every change and restored on load. A corrupt or missing saved board starts a fresh default board instead of crashing.
- A search box that filters cards by text, live, across all columns.
- Light and dark theme, following the system setting, with a toggle that is remembered.
- Export the board as a JSON file and import one back (invalid files are rejected with a message, and the current board is left untouched).
- Accessible: every control reachable by keyboard, visible focus, labels for screen readers, colour contrast at least WCAG AA.

## Constraints

- TypeScript, Vite and Vitest (with jsdom for DOM tests). No UI framework; plain DOM. No runtime dependencies beyond what Vite produces.
- `npm test` runs the whole test suite and is the gate command. `npm run build` produces `dist/`. `npm run dev` serves the app locally.
- The board logic (columns, cards, moves, search, import validation) is pure functions with unit tests; the DOM layer has tests for its main interactions.
- A GitHub Actions workflow runs `npm ci && npm test && npm run build` on every pull request.
- MIT license. A README with a screenshot placeholder, how to run it, and the keyboard shortcuts.

## Out of scope

- Accounts, sync, a server, multiple boards, due dates, attachments, labels or colours on cards.
- Mobile-specific gestures (it must not break on a phone, but no touch drag is required).
- Deploying anywhere.

## Done when

- Every "Must have" item works in `npm run dev` and has tests.
- `npm test` and `npm run build` pass in CI on the default branch.
- The README describes how to run it and lists the keyboard shortcuts.
