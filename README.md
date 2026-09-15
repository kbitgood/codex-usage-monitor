# Codex Usage Monitor

A compact macOS widget for tracking Codex usage limits and paid-credit activity. It stays above other windows, works across Spaces, and remains available from the menu bar when hidden.

The widget shows:

- Remaining usage in the active five-hour and weekly windows
- The reset time for each available window
- Seven days of actual paid Codex credits when Admin Console access is available
- A deliberately high local estimate when actual credit data is unavailable

## Requirements

- macOS on Apple silicon
- [Bun](https://bun.sh/)
- A working Codex login

The current packaging script targets `arm64`. Other architectures have not been tested.

## Install

Clone the repository and run:

```sh
bun install
bun start
```

`bun start` builds the application, installs it at `/Applications/Codex Monitor.app`, and launches the installed copy.

To rebuild and install without launching:

```sh
bun run install:mac
```

## Development

```sh
bun test
bun run typecheck
bun run install:mac
```

Use `bun dev` only when you specifically want the generic Electron development host. The packaged application has different login-item behavior, so final verification should use `/Applications/Codex Monitor.app`.

## Usage

The reset countdown updates every two seconds. Live limits are fetched at most every 15 seconds or immediately through **Refresh now**. Credit data refreshes once per minute.

Drag the usage area to move the widget. Resize it from any edge. Hover over the widget to reveal the hide button, or press `Escape`. The menu-bar menu can refresh the data, show or hide the widget, enable launch at login, and quit the application.

## Data sources

### Usage limits

The application reads the Codex login from `$CODEX_HOME/auth.json`, normally `~/.codex/auth.json`, and requests the same live usage information used by Codex status views. It does not display or copy the login token. If the live request fails, the monitor falls back to the newest `token_count` event in the local Codex rollout files.

### Actual paid credits

When the signed-in user can access credit analytics, click **Connect** and sign in through the separate Admin Console window. Electron keeps this login in a dedicated persistent browser session. The application does not extract or save browser cookies.

The chart then displays actual paid Codex credits for the last seven days.

### Estimated credits

Users without Admin Console access see the same chart under the title **Estimated Credits**. The estimate is intentionally biased high:

- Requests reported at 99% or 100% usage are included.
- The full request that crosses the included limit is counted.
- Usage continues to count until the exhausted window resets.
- Missing model metadata uses GPT-6 Astra credit rates.
- Missing or Fast effective service-tier metadata adds a 2.5x Fast-mode reserve.

The estimate covers Codex activity recorded locally on that Mac. It may still omit cloud tasks, activity on other computers, and separately billed tools.

## Privacy and limitations

The monitor reads local Codex authentication and session files. It sends the existing access token only to the Codex usage endpoint and uses the isolated Admin Console browser session only with OpenAI domains.

The live usage endpoint, rollout-file format, and Business Admin Console credit endpoint are undocumented. OpenAI may change them without notice, which can require an application update.
