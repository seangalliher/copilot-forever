# Goal: build LoopBoard, a local-first kanban board that runs in the browser.

## Must have

- Three columns (To do, Doing, Done) with add, edit and delete for cards (title, optional note, optional due date).
- Move cards by drag and drop **and** by keyboard (accessible: focus order, ARIA labels, visible focus).
- A work-in-progress limit per column, set by the user; the column warns when it is over the limit.
- Everything persists in `localStorage`; export the board to JSON and import it back.
- Light and dark themes, following the system setting with a manual toggle.
- Works on a phone-width screen.

## Engineering

- Vite + TypeScript, no UI framework. Unit tests with Vitest for the board logic; one Playwright smoke test (add a card, move it, reload, it is still there).
- GitHub Actions CI running lint, unit tests and the smoke test on every PR.
- Deploy to GitHub Pages from `main`.

**Not in scope:** accounts, a backend, sync between devices, multiple boards.

**Done when:** every issue is closed, CI is green on `main`, and the board is live on GitHub Pages.
