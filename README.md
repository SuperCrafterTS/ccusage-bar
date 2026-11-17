# ccusage-bar

A Claude Code mod that shows your token usage while you work.

- **A bar above the prompt**, two lines:
  - This session's tokens and their API-equivalent value at the model's prices, context-window fill, and your 5-hour and weekly usage limits as colour-coded bars with reset countdowns (Pro/Max plans).
  - Today's and this month's API value, the current 5-hour block's burn rate and projection, plus fun stats: daily streak, best day, "novels" Claude has written, lattes' worth of usage, active days.
- **`/ccusage`**: a full report with live session stats, limits, the 5-hour block, the last 14 days, monthly totals, recent sessions, cost by model and fun stats.
  - `/ccusage bar` hides or shows the bar
  - `/ccusage refresh` refreshes it now
  - `/ccusage <args>` runs ccusage with any arguments, e.g. `/ccusage blocks`

Dollar figures are API-equivalent estimates from your local logs, not your bill.

## Requirements

[ccusage](https://github.com/ccusage/ccusage) installed and on your PATH, for example `npm install -g ccusage` (pinning a version is recommended).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ccusage-bar --marketplace SuperCrafterTS/ccusage-bar
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```
claude plugin install ccusage-bar --marketplace SuperCrafterTS/ccusage-bar
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `SuperCrafterTS/ccusage-bar`, then Add plugin.

## License

MIT
