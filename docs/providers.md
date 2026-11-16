# Providers

This page explains how to run the kit's workflows on Claude or on Codex, how to switch between them, and what changes on Codex. It is for a person who has installed the kit and wants to choose a provider for the whole install, for one run or for one node.

## How a workflow names its model

Every model setting in the workflows is a tier, `small`, `medium` or `large`, and never a model name. Archon resolves a tier to a provider and a model from its configuration. The install's `config.yaml` that the kit writes pins no tier, so each tier follows the default assistant. Changing the default assistant therefore moves every node.

With Archon 0.13.2 the built-in tiers are:

| Tier     | Claude | Codex           |
| -------- | ------ | --------------- |
| `small`  | haiku  | `gpt-5.6-luna`  |
| `medium` | sonnet | `gpt-5.6-terra` |
| `large`  | opus   | `gpt-5.6-sol`   |

`archon ai tier list` shows the tiers of the installed version, which is the source of truth for any other release.

## Switching providers

There are four ways to switch, from the widest to the narrowest.

- The install default. `archon-kit provider use codex` runs `archon ai default codex` after checking that Archon lists the provider as installed, and prints `archon provider add codex` when it does not. `archon-kit provider status` shows the tiers and the installed providers.
- One run. `archon-kit run codex <workflow> [arguments]` runs `archon workflow run <workflow> --config $ARCHON_HOME/profiles/codex.yaml [arguments]`. A profile sets the assistant and all three tiers, because a per-run layer has to win over an install that pins other models. `profiles/claude.yaml` does the same for Claude.
- One tier of one run. `archon workflow run <workflow> --model medium=claude/opus` rebinds one tier for that run.
- One node. A node can use `model: @name`, where `@name` is an alias set with `archon ai alias set @name <provider> <model>`. Aliases that mix providers inside one workflow are not tested.

A hand-off that a run starts through `start-run.sh` inherits the run's configuration layer: the script passes `--config-from-run <run-id>` when the run's artifacts directory is named by a run id, so a hand-off started by a Codex run runs on Codex. `--config-from-run` copies the config layer and not the run's `--model` bindings.

## Setting up Codex

Codex is a separate provider plugin that Archon installs on request.

```bash
archon provider add codex
archon ai login codex
archon workflow run research --dry-run --default-stubs --config "$ARCHON_HOME/profiles/codex.yaml" "test question"
```

The last command simulates a run on the Codex profile without contacting the provider. The kit's tests prove Codex support only statically, by checking that every output schema is acceptable to Codex's strict mode, until a dry run and a live probe have been done on your machine. [Testing the kit on Codex](codex-beta-test.md) walks through the dry run, the live probe and a first real run.

## What differs on Codex

- `allowed_tools` is ignored, with a warning for each node. The read-only agent nodes of the kit stay read-only because they also carry `mutates_checkout: false`, which Archon enforces by fingerprinting the checkout on any provider. That guard protects the checkout only, so an instruction such as "use no network" is not enforced on Codex.
- Archon starts Codex with a sandbox that does not restrict writes, so the sandbox cannot confine a stage to a lane. Lane enforcement does not depend on the provider: `lane.sh` compares the working tree at the end of a confined stage with a snapshot taken at its start, and fails the run on a write outside the lane. The real-time hook that refuses a write as it happens is a second layer, described below.
- Codex reads `~/.codex/AGENTS.md` in every node, and Archon's `settingSources` setting has no Codex counterpart, so every rule in your own file applies to the workflow agents. See [Your own AGENTS.md](#your-own-agentsmd).
- `research` uses web search. On Codex that is the `webSearchMode: live` setting, which the config template and the Codex profile set.
- Codex does not report cost, tokens per turn or stop reasons, so any cost note in the workflows describes Claude only.

## Your own AGENTS.md

Codex documents that it loads the user-level `~/.codex/AGENTS.md`, and the `AGENTS.md` of the repository, into each session. On Claude the kit's `config.yaml` sets `settingSources: [project]`, which skips `~/.claude/CLAUDE.md` so that personal rules never reach an unattended node. Codex offers no such switch, so the rules of your file reach every agent node of every workflow. The kit's prompts were written without them, and the kit has not been run on Codex yet, so the notes below come from reading the workflows, not from observed conflicts. Read your file against them before a first `build` or `workflow-cleanup` run.

Four kinds of rule can matter.

- A rule that requires confirmation before a hard-to-reverse action is the most likely to cause trouble. Several agent nodes, such as `sync_resolve` and `sync_fix`, are told that no person is available and that the run lands the branch as soon as the gates pass. An agent that stops to ask a question returns no result, and its node fails. Only the implementer of an `interactive=yes` build is meant to ask.
- A rule that forbids a git command a prompt uses would conflict outright. The agent nodes commit new commits, stage named files, resolve a conflict with `git add` and `git rebase --continue`, and never push, amend, reset or skip a rebase. A rule against pushing, amending or `reset --hard` agrees with them. A rule that forbids rebasing or resolving conflicts by hand would block `sync_resolve`. The steps that push, reset, delete branches or land a change are bash nodes, which no AGENTS.md rule governs.
- A rule that adds work to every session, such as building after each change, running the whole test suite in a fixed order, measuring a file before reading it, copying results to a clipboard or writing a recap at the end, makes nodes slower and their text longer. It does not normally change a node's result, because a node that has an `output_format` still has to return its fields.
- A rule about style, such as brevity or a required voice, changes how the reports read.

To resolve a conflict, trim the user-level file, or move the rules that only apply to your interactive work into the `AGENTS.md` of the projects where you work interactively. The kit never edits your file.

## The Codex lane hook

The lane hook, `lane-hook.mjs`, refuses a write outside a stage's lane as it happens. On Claude it runs from the repository's `.claude/settings.json`. For Codex, `archon-kit hooks install codex` adds a `[[hooks.PreToolUse]]` block to `~/.codex/config.toml` between `archon-kit:lane-hook` markers. The command shows a diff and writes only with `--yes`. Codex asks for a review before it runs a hook, which only a person can give: open an interactive `codex` session and trust the hook in `/hooks`.

The hook reads `apply_patch` calls and shell commands whose command is a string or an argument array. Codex's hook payload names shell calls `Bash` and patches `apply_patch`, and `tool_input.command` holds the command text or the whole patch (`*** Begin Patch`, `*** Add File: <path>`, and so on). The patch format is not documented as a contract, so the hook searches the patch text in every string of the tool input, and refuses an `apply_patch` call whose files it cannot read while a stage is confined. The hook denies a call with `hookSpecificOutput.permissionDecision: "deny"`, which Codex accepts. Codex lets a call through on any other outcome: a crash, a timeout, invalid output, or exit code 2 with nothing on stderr.

OpenAI's hook documentation and the Codex source (read on 2026-11-11) settle most of what the kit could not verify. `codex exec` runs hooks, but only trusted ones: a hook that is new or changed is skipped, with no error, until a person trusts it. Codex records the trust in the user's config as `[hooks.state."<config file>:pre_tool_use:<group>:<handler>"] trusted_hash`, keyed by the file that declares the hook, so the user-level `~/.codex/config.toml` that `hooks install codex` writes needs one review and then covers every worktree. A hook in a project's `.codex/config.toml` needs the project to be trusted too, and in a linked worktree Codex reads the project's hooks from the root checkout. `--dangerously-bypass-hook-trust` runs hooks without the saved trust. `CODEX_HOME` moves the user-level config. Codex's own documentation calls tool hooks a guardrail and not a complete enforcement boundary.

Still unverified is whether a hook fires inside an Archon node, which starts Codex itself and may pass its own configuration. `test/codex-lane-probe.sh` records that, and [Testing the kit on Codex](codex-beta-test.md) says how to run it. A registered hook that was never trusted does nothing, and `lane.sh verify` cannot see that, so rely on the check at the end of each stage until the probe shows the hook firing. `lane.sh verify` takes `--provider` for each provider that runs the confined stages, and the `build` workflow passes the provider of this run, so a Claude registration no longer stands in on a Codex run. A repository that wants only that check sets `"lane_enforcement": "check"` in `.archon/build.json`, which satisfies `lane.sh verify`.

Result of the probe: not yet verified.