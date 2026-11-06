# claude-mods

Mods for Claude (interface and behaviour add-ons). Each mod lives in `plugins/<mod-name>/`.

## Install a mod

Terminal session:

```
/plugin install <mod> --marketplace adwinang/claude-mods
```

Shell:

```
claude plugin install <mod> --marketplace adwinang/claude-mods
```

Desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `adwinang/claude-mods` → **Add plugin**.

## Mods

- **[worktime](plugins/worktime)** — tracks effective work time per conversation (only while Claude works, minus waits on you), with a side pane, `/worktime` commands, CSV export, and tools Claude uses to log time to ClickUp.
