# Codex Monitor project rules

- Use Bun for installs, scripts, builds, and tests.
- After source or asset changes, run `bun test` and `bun run typecheck`.
- Rebuild and update the installed app with `bun run install:mac` before finishing an implementation task.
- Launch and verify `/Applications/Codex Monitor.app`, not the generic Electron development host. `bun start` installs and launches the correct app.
