# Telling your agents about reports

This page explains the instruction block that tells a coding agent where Archon reports are, how to give you a report's link and how to start the report server. It is for a person who works with Claude or Codex alongside the kit.

Asked where a report is, an agent that has read nothing about the kit answers with a file path. The block fixes that with five bullets, and the same text goes into `CLAUDE.md`, which Claude reads, and `AGENTS.md`, which Codex reads. Codex nodes inside Archon load `AGENTS.md` too, so the block reaches workflow agents as well. It only tells them how to link reports.

## The block

```markdown
<!-- archon-kit:reports:start -->

## Archon reports

Archon workflow runs write their reports (plans, reviews, research) as HTML pages under `~/.archon/designs/<repo>/<slug>/`. A read-only server shows them at the address in `~/.archon/report-base-url`.

- Give the user a report's URL, not its file path. `~/.archon/scripts/report.sh link <file>` prints the URL, or the path when no server is set up.
- A paused run's message starts with the report's URL on its first line. Pass it on unchanged.
- If a URL does not open, run `archon-kit reports status`. `archon-kit reports up` starts the server on localhost.
- Build a page from a Markdown report with `~/.archon/scripts/report.sh markdown`, and do not edit files under `~/.archon/designs/` by hand.
- The server has no login. Do not bind it beyond localhost unless the user asks.
<!-- archon-kit:reports:end -->
```

The block costs context in every session, so it stays short. The two marker lines let `archon-kit agent-docs` find the block again and replace it when the text changes.

## Adding the block

`archon-kit agent-docs` inserts or replaces the block in both files and shows a diff. It writes only with `--yes`.

```bash
archon-kit agent-docs --repo ~/projects/my-repo
archon-kit agent-docs --repo ~/projects/my-repo --yes
```

`--repo` takes the repository root and defaults to the current repository. `--global` edits your own instruction files instead, `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, so the block applies to every project:

```bash
archon-kit agent-docs --global
archon-kit agent-docs --global --yes
```

`archon-kit init-repo` adds the block to a repository's files as part of its setup. Because the two files carry the same block, one run rewrites both.

## One file instead of two

If you prefer a single source, keep the block in `AGENTS.md` and put this line in `CLAUDE.md`, which Claude expands into the content of the other file:

```markdown
@AGENTS.md
```