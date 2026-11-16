# Testing the kit on Codex

This guide is for a person who has Codex and agrees to run the kit's Codex path once, so that the maintainer learns what works. The kit's tests prove Codex support only statically, because nobody has run the kit on Codex yet. You need about an hour, and the probe costs a few small-tier requests on your Codex account.

You do not need to read the workflows. Follow the steps in order, and send back the report file that step 8 writes, plus anything odd you saw in step 9.

## Prerequisites

- Archon 0.13.2, installed. Other versions are untested.
- This repository, cloned and installed with `./install.sh`, as the [README](../README.md#quickstart) describes. That puts the scripts, workflows and profiles under `~/.archon`.
- `git`, `jq` and `node` 20 or later on your `PATH`. The probe is a shell script that uses all three.
- A Git repository of your own with a few commits, for step 9. Any small project works, and the run does not change it.
- A Codex account that Archon can log in to.

## Steps

1. Install Codex by following OpenAI's instructions, and check that `codex --version` prints a version.

2. Add Codex to Archon and log in.

   ```bash
   archon provider add codex
   archon ai login codex
   ```

3. Check the install.

   ```bash
   archon-kit doctor
   ```

   Lines that start with `warn` are acceptable. A line that starts with `fix` or a final line other than `all checks passed` is not, so copy the output into your reply.

4. Simulate a research run on the Codex profile. This does not contact Codex.

   ```bash
   archon workflow run research --dry-run --default-stubs --config ~/.archon/profiles/codex.yaml "test question"
   ```

   The run should finish without an error. Copy any warning it prints into your reply.

5. If you have a `~/.codex/AGENTS.md`, read it against the four kinds of rule in [Your own AGENTS.md](providers.md#your-own-agentsmd). Codex loads that file into every workflow agent, and the kit's prompts were written without it. Note any rule of yours that matches one of the four kinds, and send the rule's text along with the report.

6. Register the lane hook for your user, then trust it once.

   ```bash
   archon-kit hooks install codex --yes
   ```

   Open an interactive `codex` session, type `/hooks`, review the `lane-hook.mjs` entry and trust it, then leave the session. Codex refuses to run a hook that nobody has reviewed, and only a person can review it. If Codex shows no such entry, say so in your reply.

7. Check that the hook is registered.

   ```bash
   archon-kit hooks status
   ```

   The first line should say that the lane hook block is present in `~/.codex/config.toml`.

8. Run the probe from the kit clone.

   ```bash
   ./test/codex-lane-probe.sh
   ```

   The probe runs two cases in throwaway repositories under your home directory, `~/codex-lane-probe-user` and `~/codex-lane-probe-repo`. Each case starts one small-tier Codex agent that tries seven writes, some of which the lane hook should refuse. The probe runs for a few minutes per case, deletes the repositories when it finishes and writes `~/codex-lane-probe-report-<date>.md`. If Codex stops and waits for an answer, note what it asked, press Ctrl-C and send that note with the report. `./test/codex-lane-probe.sh --help` lists the options.

9. Run a real workflow on Codex. Pick a small question about your own repository, and run the command from inside that repository.

   ```bash
   archon-kit run codex research "Where does this project read its configuration?"
   ```

   The run pauses when it needs a decision and shows a report as a web page; answer the pauses as you would on any run. If the page does not open, run `archon-kit reports up` first.

## What to send back

Send the report file `~/codex-lane-probe-report-<date>.md`. It holds versions, tool names, paths inside the probe repositories and the probe's own test payloads, and none of your files. Also send the following when they apply:

- The output of step 3 or step 4 when either printed more than warnings.
- The text of any rule from step 5 that matches one of the four kinds.
- A description of anything odd in step 9: an error, a node that failed, an agent that stopped to ask a question, or a report that read strangely. Include the run's id, which `archon workflow runs` lists.

## What the probe settles

The kit contains a lane hook, `lane-hook.mjs`, that refuses a write outside a build stage's lane as it happens. [The Codex lane hook](providers.md#the-codex-lane-hook) says which facts about it OpenAI's documentation settles and which are still unverified. The probe records each of the following.

- Whether a Codex `PreToolUse` hook fires inside an Archon node. The report counts the calls that a capture hook received and the refusals that the lane hook made.
- What the payload of an `apply_patch` call looks like to a hook. OpenAI's source says `tool_input.command` holds the raw patch text, and the report quotes the first payload of each tool to confirm it.
- Whether the `command` of a shell call reaches a hook as a string or as an argument array. The report lists its type for each call.
- Whether a hook runs after it is trusted, with its trust stored as OpenAI's documentation describes (`[hooks.state."<file>:pre_tool_use:<group>:<handler>"] trusted_hash` in the user's config), and whether a hook in a project's `.codex/config.toml` runs at all in a worktree. The two cases differ in where the hook is registered, so the report shows which of them fired.
- Whether Archon adds `additionalProperties: false` to the `output_format` schemas it sends to Codex. Step 9 shows this: the `research` workflow returns structured output, and a node that fails with a schema error names the schema.

The check at the end of each stage does not depend on the hook, so a hook that never fires costs the kit a real-time refusal and not the final check.