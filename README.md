# linear-tasks

A Claude Code mod that keeps your Linear work in a panel beside the chat, and lets Claude plan and implement an issue in one click.

- **Cycle progress:** days left in the current cycle, how many of your issues and the team's are done, how many should be done by now, and a "Behind pace" warning.
- **Needs you:** unread Linear comments and mentions, your issues that block someone else, and plans Claude has written that are ready for review.
- **Up next:** your open issues, sorted by status and priority, with blocked ones last.
- **By stage:** a count of issues per stage, for you or for the whole team's cycle.
- **Create plan:** Claude reads the issue, explores the issue's project folder without changing anything, and posts a step-by-step plan to the issue as a comment that starts with `## Claude plan for <issue>`.
- **Implement plan:** Claude follows that plan in the issue's project folder, on the issue's git branch, and runs the tests. It never pushes, opens a pull request or changes the Linear issue without asking you.

A **Show Linear / Hide Linear** button above the prompt box toggles the panel and shows how many items need you. `/linear` does the same. The panel starts closed; it opens only when you toggle it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install linear-tasks --marketplace Hamdi-flow/linear-tasks
```

From a shell:

```bash
claude plugin install linear-tasks --marketplace Hamdi-flow/linear-tasks
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Hamdi-flow/linear-tasks`, then Add plugin.

## Setup

1. **Connect Linear.** The panel uses the Linear connector your Claude Code session already has. If it isn't connected, run `/mcp` and connect Linear.
2. **Allow the panel's Linear reads.** The panel reads Linear in the background, outside a chat turn. In auto mode those calls need allow rules. Add these to `permissions.allow` in `~/.claude/settings.json`, using your Linear connector's tool prefix (shown by `/mcp`):

   ```
   mcp__<linear>__get_user
   mcp__<linear>__list_issues
   mcp__<linear>__get_issue
   mcp__<linear>__list_cycles
   mcp__<linear>__list_issue_statuses
   mcp__<linear>__get_notifications
   ```

   All six are read-only. The panel never writes to Linear itself: Claude only posts a plan comment after you press Create plan.
3. **Set your projects folder (optional).** Set the `projectsRoot` option to the folder that holds your code projects. Its subfolders then appear in each issue's folder picker, so Claude knows where to work. Left empty, Claude asks you which folder to use.

## Development

- `claude plugin test .` runs the tests, using made-up sample data.
- `claude plugin validate .` checks the manifest and hooks.
- `bash dev/preview/run.sh` renders the panel in several states and saves screenshots to `dev/preview/out/`. It needs Node, Google Chrome and the `claude` CLI, and is written for Git Bash on Windows.

## License

MIT
