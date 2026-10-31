// So that `npx playwright test` / `npm run test:e2e` from the repo root use the
// real config (baseURL, front server, teardown) and only tests/e2e — not the
// copies of the specs in .claude/worktrees.
export { default } from './tests/playwright.config.mjs';
