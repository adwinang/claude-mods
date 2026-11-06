# worktime

Tracks the **effective work time** of a Claude Code / Cowork conversation: only the time Claude is actually working on a turn, from the turn's start to its end. Idle time between your prompts is never counted, and time spent waiting on you inside a turn (a permission prompt, an `AskUserQuestion`) is subtracted.

Example: Claude works 10 min on your first prompt; you reply 10 min later and Claude works 20 min → **30 min** effective.

## What you get

- **Side pane** – running total, a live ticking timer while Claude works, unlogged time, the pinned task, and every turn.
- **`/worktime` command**
  - `/worktime` – summary of this conversation
  - `/worktime pane` – open the pane
  - `/worktime csv` – export turns and adjustments as CSV
  - `/worktime exclude <n>` / `include <n>` – leave a turn out of the total
  - `/worktime adjust +15m [note]` (or `-10m`, `1h30m`) – manual adjustment
  - `/worktime task <ClickUp task id or URL> [name]` – pin the task this conversation logs to
  - `/worktime log` – ask Claude to log the unlogged time to the pinned ClickUp task
- **Tools Claude can call** – `get_worktime` (totals, unlogged time, per-turn detail, CSV), `mark_logged` (records a created timesheet entry so nothing is logged twice) and `set_task`. With the ClickUp connector, Claude creates one time entry (`clickup_add_time_entry`) for all unlogged time, then marks it logged. Any other timesheet connector works the same way.

Data is kept per conversation (by session id) in the plugin's store, so a resumed conversation keeps adding to its total. If the app closes mid-turn, the turn is closed at the last moment it was seen working.

## Install

```
/plugin install worktime --marketplace adwinang/claude-mods
```
