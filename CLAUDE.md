# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

Behavioral guidelines to reduce common mistakes. They bias toward caution over speed; for trivial tasks, use judgment.

### Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that _your_ changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### Goal-driven execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and
clarifying questions come before implementation rather than after mistakes.

## Git Commits

- **Never include Claude as author or co-author** in commit messages, PR descriptions, or any other text. Do not add
  `Co-Authored-By: Claude…` trailers, "Generated with Claude Code" footers, or any similar attribution.
- The user's own git author identity (already configured in git) is the only identity that should appear on commits.
- This rule overrides the default Claude Code commit-template guidance.
- **Never prepend the JIRA ticket ID** (e.g. `[OND211-2386]`) to the commit subject yourself. The `giticket` pre-commit
  hook reads the ticket from the branch name (`(feature|bugfix|support|hotfix)/<TICKET>-…`) and prepends `[<ticket>]`
  (with a trailing space) automatically. Writing the prefix manually produces a duplicate like
  `[OND211-2386] [OND211-2386] feat: …`. Write the subject as plain Conventional Commits (`feat: …`, `fix(scope): …`,
  `docs(types): …`) and let the hook add the prefix on commit.

## General Principles

- Follow existing patterns before introducing new abstractions.
- Keep changes minimal and consistent with surrounding code.
- Validate inputs early with descriptive, context-rich error messages.
- Prefer region comments for grouping methods in files that already use them.
- End edited Markdown and YAML files with a trailing newline.

## What this repo is

A **plain-JS gRPC-web SDK** for the ONDEWO Text-to-Speech API. There is no Python, no `pyproject.toml`,
no Jenkinsfile.

| Path | Written by | Edited by hand? |
| --- | --- | --- |
| `api/ondewo_t2s_api{,.min}.js{,.map}` | proto-compiler codegen (`make build`) | **never** |
| `src/ondewo-t2s-api/` | git submodule (`tags/6.6.0`, `T2S_API_GIT_BRANCH`) | never |
| `ondewo-proto-compiler/` | git submodule | never (only the gitlink moves) |
| `auth/offlineTokenProvider.js` (+ `.spec.js`) | humans | **yes** |
| `examples/client.js` (+ `.spec.js`) | humans | **yes** |
| `src/package.json`, `src/README.md`, `src/RELEASE.md` | humans | **yes** -- these are the codegen's sources |

`make build` copies `src/{package.json,README.md,RELEASE.md}` over the ROOT copies, so **edit both** or the
next release silently reverts the root file. `README.md` / `src/README.md` are byte-identical today, and so
are `RELEASE.md` / `src/RELEASE.md`.

`package.json` is the deliberate exception: `src/package.json` is the codegen's source of truth and carries
no test setup, while the ROOT copy additionally holds the CI `test` / `test:drift` scripts and the
`c8` / `dotenv` devDeps that `make restore_ci_test_setup` merges back in from `.ci-package.json` right after
the codegen overwrites it (see the last section). The two files are therefore **divergent by design** --
`diff src/package.json package.json` is expected to be non-empty; never "fix" it by copying one over the
other. What must be mirrored into `src/package.json` is only what the _published_ package needs at runtime
(e.g. `undici`).

`auth/` and `examples/` are the entire hand-written surface; the coverage gate is scoped to exactly those
two directories.

## Tests and the coverage gate

```shell
npm install --no-audit --no-fund   # what CI runs; package-lock.json is committed
npm test                           # every spec in ONE c8 process, 100% gate
npm run test:drift                 # package.json <-> .ci-package.json mirror check
```

`npm test` is (`package.json` and `.ci-package.json` carry the identical string):

```text
c8 --100 --per-file --all --include 'auth/**/*.js' --include 'examples/**/*.js' --exclude '**/*.spec.js'
   --reporter text node --test auth/offlineTokenProvider.spec.js examples/client.spec.js
```

Each flag is load-bearing:

- `--100` -- statements, branches, functions **and** lines all at 100.
- `--per-file` -- a weak file cannot be averaged away by a strong one.
- `--all` -- a **new hand-written file that no spec requires** is reported at 0% and fails the build.
  Without it the gate is blind to exactly the file most likely to be untested. (Verified: dropping an
  untested `examples/probe.js` makes `npm test` exit 1 with four `does not meet threshold` errors.)

Both specs are hermetic: the Keycloak token endpoint is driven through the injectable `fetchImpl` option
(or a stubbed `globalThis.fetch`), the gRPC-web client and message classes are fakes, and `node:test`
`mock.timers` drives the refresh loop. **No network, no live server, no `api/` bundle is loaded.**

There are exactly **two** coverage exclusions in the hand-written surface, each a single site carrying its
reason in the comment. `grep -rn 'c8 ignore' auth/ examples/` must keep returning these two and nothing else:

- `examples/client.js` -- `/* c8 ignore next 6 */` over the `if (require.main === module)` CLI auto-run at
  the bottom of the file: unreachable under `node --test`, where `require.main` is the spec file.
- `auth/offlineTokenProvider.js` -- `// c8 ignore next` over the `typeof this.timer.unref === 'function'`
  guard in the refresh-timer scheduler: Node's real `setTimeout` always returns a `Timeout` exposing
  `unref()`, so the false branch only guards exotic non-Node shims.

Do not add broader ones -- no file-level or blanket pragmas; write a test instead.

## CI: `.github/workflows/tests.yml` is the only workflow

Runs on push to any branch and on every pull request. Five steps, in order:
`actions/checkout@v5` -> `actions/setup-node@v5` (Node **20**) -> `npm install --no-audit --no-fund` ->
`npm run test:drift` -> `npm test`. There is no deploy step and no publish step in CI; releasing is
manual (`make ondewo_release`).

What turns it red, in practice:

- a spec failure, or **any** drop below 100% on `auth/` or `examples/` -- including a brand-new
  hand-written file with no spec;
- `package.json` and `.ci-package.json` disagreeing on a script / devDependency / dependency.

Reproduce it locally by running those three `run:` blocks verbatim. `make eslint` and
`make prettier` are **not** in CI -- they run in `.husky/pre-commit`.

## Proto-compiler pin: gitlink + Makefile, never codegen

Two things must agree, and nothing else changes:

1. the `ondewo-proto-compiler` submodule gitlink -- currently
   `b71f8ed4575ecc4ee8084389a075514acac61ff4` = tag **5.14.0**;
2. `ONDEWO_PROTO_COMPILER_GIT_BRANCH=tags/5.14.0` in the `Makefile`, which
   `make check_out_correct_submodule_versions` checks out before every build. **If the Makefile pin is
   older than the gitlink, `make build` silently DOWNGRADES the submodule** -- that is exactly how the
   6.6.1 release regressed the gitlink from 5.13.0 back to 5.11.0.

To bump:

```shell
git submodule update --init --recursive
git -C ondewo-proto-compiler fetch --tags origin
git -C ondewo-proto-compiler checkout <VERSION>
git add ondewo-proto-compiler
perl -i -pe 's|^ONDEWO_PROTO_COMPILER_GIT_BRANCH=.*|ONDEWO_PROTO_COMPILER_GIT_BRANCH=tags/<VERSION>|' Makefile
git submodule status | grep proto-compiler    # must show the new tag
```

Verified no-ops for the 5.11.0 -> 5.14.0 bump, so they must NOT appear in the diff:

- `Dockerfile.utils` already declares `ENV NODE_VERSION=24.14.0`, exactly what 5.14.0's Makefile wants.
- The canonical `update_proto_compiler_dependency.sh` jq merge of
  `ondewo-proto-compiler/js/image-data/default-lib-files/package.json` into `src/package.json` (the `js`
  special case -- note `default-lib-files/`) produces a byte-identical file: between 5.11.0 and 5.14.0
  only the image manifest's own `"version"` changed, and the merge never reads `.version`.

**A pin bump ships NONE of the compiler's fixes.** `git diff --stat 5.11.0..5.14.0` in the compiler
touches only `angular/`, `js/`, `nodejs/`, `typescript/`, `tests/` and root tooling -- they are entirely
codegen changes. Moving the pin changes which image `make build` _would_ build; it does not rewrite one
byte of the already-committed `api/` bundle. Never write a RELEASE.md line claiming "regenerated with
proto-compiler X" for a pin-only bump.

## Pre-commit: hook ORDER is the rule that bites

`.pre-commit-config.yaml` declares two `commit-msg`-stage hooks, and pre-commit runs repos in
**declaration order**:

1. `compilerla/conventional-pre-commit` -- validates the subject;
2. `milin/giticket` -- rewrites it to `[OND231-624] feat: ...` from the branch name.

**Validate first, decorate second.** With giticket first, giticket's `[TICKET]` prefix was handed to
conventional-pre-commit, which rejected it: every commit on a `feature/OND231-...` branch failed and
could only be made with `--no-verify`. The bug is invisible on `master`, where the branch name matches no
ticket and giticket adds nothing. Verified on a throwaway `feature/OND231-624-probe` branch: `chore: probe`
passes both hooks and becomes `[OND231-624] chore: probe`.

Never prepend the ticket id yourself -- giticket does it, and doing both yields
`[OND231-624] [OND231-624] feat: ...`.

Hook revs, all at the newest stable as of this writing: `markdownlint-cli2 v0.23.2`,
`pre-commit-hooks v6.0.0`, `conventional-pre-commit v4.4.0`, `giticket '1.92'` (keep it **quoted** --
unquoted `1.92` is a YAML float and the tag lookup then fails).

## Prettier vs. pre-commit: the deadlock, and why `.prettierignore` is long

`.husky/pre-commit` runs `make prettier PRETTIER_WRITE=-w` **before** `pre-commit run`. Any file prettier
rewrites there is left unstaged; if that file is `.pre-commit-config.yaml`, `pre-commit run` aborts with
_"Your pre-commit configuration is unstaged"_ and the commit (or the release) dies. So `.prettierignore`
deliberately lists, each with the reason inline: `.pre-commit-config.yaml`, `.markdownlint-cli2.yaml`,
`CLAUDE.md`, `README.md`, `RELEASE.md`, `.ci-package.json`, `package.json`, `coverage/`, `.nyc_output/`.
`make prettier` must report _"All matched files use Prettier code style!"_ -- if it does not, fix the
file or add it to `.prettierignore` with a reason; do not leave it warning.

`README.md` is ignored for a second, harder reason: prettier rewrites
`[comment]: <> (START OF GITHUB README)` into `[comment]: <> 'START OF GITHUB README'`, and `make build`
slices the published README between exactly those markers.

**markdownlint MD053 is disabled** in `.markdownlint-cli2.yaml` for the same markers -- its auto-fix
DELETES them as "unused link reference definitions". Never re-enable it here.

`RELEASE.md` / `src/RELEASE.md` survive markdownlint's auto-fix (verified): it only normalises trailing
whitespace, blank lines and list indentation. The `## Release ONDEWO T2S Js Client <VERSION>` headings and
the `*****************` separators -- both of which `CURRENT_RELEASE_NOTES` and `ondewo_release` grep for
-- are untouched. Confirm with `make TEST`, which prints the slice for the current version.

## Local-environment sharp edges

- **`pre-commit` may not be on `PATH`.** `.husky/pre-commit` guards its call with `command -v pre-commit`
  and silently skips it; `.husky/commit-msg` does **not** and will fail. Install it
  (`make install_precommit_hooks`) or run the framework as `uvx pre-commit ...`.
- **`uvx pre-commit run --hook-stage commit-msg ...` refuses to run while `.pre-commit-config.yaml` has
  unstaged changes.** `git add .pre-commit-config.yaml` first.
- **husky hooks only fire once `core.hooksPath` is set** (`npx husky install`, from
  `make install_precommit_hooks`; husky 9 prints a DEPRECATED warning but still writes the config). On a
  fresh clone `git commit` runs no hooks at all, so `npm test` / `make eslint` are on you.
- **`auth/*.js` is in `eslint.config.mjs`'s `ignores`.** `make eslint` does not lint the auth provider or
  its spec; only `examples/` and the config files are checked. `examples/client.js:59` has a standing
  `no-ternary` **warning** (not an error) -- pre-existing, leave it.

## Release: `make ondewo_release`

`release` builds, checks the generated code, runs the husky hooks, commits, pushes, publishes to npm via
the utils docker image, then creates the release branch, tag and GitHub release. Gotchas that are real
here:

- **The `git commit` in `release` is `-git commit --no-verify`.** The leading `-` makes make ignore the
  non-zero exit git returns when the build produced nothing to stage -- without it an unchanged build
  aborted the entire release. `--no-verify` stops husky reformatting the freshly generated
  `RELEASE.md` / `package.json` mid-commit.
- **`create_npm_package` strips test files.** `cp -R auth npm` used to ship
  `auth/offlineTokenProvider.spec.js` inside the published tarball; the recipe now runs
  `rm -f npm/auth/*.spec.* npm/auth/*.test.*` and writes an `npm/.npmignore`. The **root** `.npmignore` is
  never consulted, because `npm_release` publishes `./npm`. Check with
  `make create_npm_package && npm pack --dry-run ./npm | grep -c spec` (must print `0`).
- **Token-bearing recipe lines are `@`-prefixed** (`docker run -e ...`, `echo $(TOKEN) | gh auth`,
  `make release $(info)`) so make never echoes a secret. Do not regress that.
- **Codegen must run TTY-free** -- `docker run` without `-it`, else the non-interactive release dies with
  `cannot attach stdin to a TTY-enabled container because stdin is not a terminal`. Verified: `-it`
  appears nowhere in the `Makefile`, `package.json` or `src/package.json` today. Keep it that way.
- **npm package name is `@ondewo/ondewo-t2s-client-js`** (double `ondewo`). Check `src/package.json`'s
  `name` before querying the registry.

## The release regenerates root `package.json` -- CI scripts survive via `.ci-package.json`

The codegen (`cd src && npm run build`, output-volume = the **repo root**) rewrites the ROOT
`package.json` from the compiler's template, dropping the CI test scripts and test devDeps. The durable
fix, present here:

- **`.ci-package.json`** holds `test`, `test:drift`, and the test-only deps (`c8`, `dotenv`, `undici`);
  it is immune to the codegen.
- **`make restore_ci_test_setup`** runs inside `build` before `create_npm_package` and merges
  `.ci-package.json` back into the regenerated root `package.json`. It is an **inline `node -e`** on
  purpose -- a helper `.js` file gets linted by the release's eslint pass and fails the release.
- **`npm run test:drift`** (also a CI step) fails the build when the two files disagree on any script,
  devDependency or dependency `.ci-package.json` declares -- so a stale mirror is caught on the commit
  that introduced it rather than after the next release.
- **Runtime deps the shipped auth helper needs (`undici`) must be declared in `src/package.json`**, the
  codegen's source of truth, or the published package loses them.
- **`remove_npm_script`** strips the scripts block from the `npm/` _copy_ only, and is guarded against a
  missing `npm/` dir and an empty scripts block.

## Releasing: preflight and the traps that have actually bitten

Written after a release program across every ONDEWO client in one session. Each item below
cost real time or a broken artefact; every statement is derived from THIS repo's Makefile.

### Before you touch the version, check the released tag is in `master`

Releases here are cut from a `release/<version>` branch and are **not always merged back**, so
`master` can be missing work that is already published — and because a later version number
sorts above the unmerged one, a consumer upgrading silently loses it. The ondewo-nlu-client-python
7.1.0 release was exactly this: it shipped from a `master` that had never seen 7.0.5's
offline-token hand-off, so PyPI's newest release was a regression against its predecessor.

```bash
latest=$(git tag --sort=-v:refname | head -1)
git merge-base --is-ancestor "$latest" master && echo "in master" || echo "NOT in master -- merge first"
```

A fast-forward (`git merge --ff-only <tag>`) is the common case. A true merge needs care: resolve
metadata toward `master` and keep BOTH release-note sections, newest first — a reader upgrading
from the older line still needs the older entry.

### `git add` on a dirty submodule stages the WRONG commit

This repo has submodules (`ondewo-proto-compiler`, `src/ondewo-t2s-api`). If a submodule's working
tree is dirty, `git add <submodule>` stages **its current HEAD**, not the pointer you resolved
during a merge — silently regressing it to an older commit. `git checkout master -- <submodule>`
fixes the index but the next `git add` re-breaks it. Move the working tree instead:

```bash
want=$(git ls-tree master <submodule> | awk '{print $3}')
git -C <submodule> checkout -q "$want" && git add <submodule>
```

### The release notes are sliced by an EXACTLY-CASED heading

`CURRENT_RELEASE_NOTES` slices `RELEASE.md` with a perl range. In THIS repo the opening
pattern is, verbatim:

```text
Release ONDEWO T2S Js Client ${ONDEWO_T2S_VERSION}
```

So the heading of a new entry must read exactly `## Release ONDEWO T2S Js Client <version>`. **This wording is
not consistent across the ONDEWO repos** — some say `... <Name> Client`, some `... Client
<Name>` with the words reversed, the API repos say `... API` with no `Client` at all, and the
casing varies (`Js`, `Nodejs`, `Typescript`, `Survey`). Do not carry a heading over from a
sibling repo. Copy the PREVIOUS entry in this file and change only the version, or read the
pattern above out of the Makefile.

A heading that does not match yields an **empty slice**, and the GitHub release is then
created with empty notes or fails outright. Verify before releasing:

```bash
grep -c '^## Release ONDEWO T2S Js Client ' RELEASE.md     # must be >= 1 for your new version
```

### `src/RELEASE.md` is the source of truth; the root file is GENERATED

The build runs `cp src/RELEASE.md .`, so an edit to the root `RELEASE.md` is **discarded by
the next build**. Write the entry in `src/RELEASE.md` (and copy it to the root if you want to
read it before building). This is silent: the release completes and the notes are simply gone.

### Publish order decides how a partial failure is recovered

`make release` in this repo runs:

1. `publish_npm_via_docker`
2. `create_release_branch`
3. `create_release_tag`
4. `release_to_github_via_docker_image`

The **npm publish happens FIRST**. So a failure in a later step (tag, GitHub release)
leaves the package already published. Do **not** re-run `make ondewo_release` to recover: the
`spc` guard refuses when the branch or tag already exists, and re-publishing the same version
is rejected by the registry. Re-run only the step that failed, passing the credential it needs.

### Verify against the registry, with the REAL package name

This package publishes as **`@ondewo/ondewo-t2s-client-js`**, which is not always the repository name — the JS client
publishes as `@ondewo/ondewo-nlu-client-js` (doubled `ondewo`), so a lookup by repo name returns
a 404 that reads like a failed release. Check the name in the manifest first, then:

```bash
npm view @ondewo/ondewo-t2s-client-js versions --json
```

**An npm publish can be STAGED but not yet served.** Immediately after a publish the registry may
answer 404 for the new version while refusing a re-publish with
`409 Cannot publish over previously staged version`. That is not a failure and the version is
not burned — wait and re-check before bumping to a new number.

### The release prints credentials — read the log BEFORE you scrub it

`make ondewo_release` clones `ondewo-devops-accounts` and passes the registry and GitHub tokens on
the make command line, so they are echoed into the console and into any transcript capturing it.
This is a known and accepted property of the shared release path: do **not** re-plumb the recipe.
Redirect the run to a file, read it through a filter, and shred the file afterwards — and read it
**before** shredding, or a genuine failure is lost with the secrets:

```bash
umask 077; make ondewo_release > /tmp/rel.log 2>&1; echo "RC=$?"
grep -avE 'TOKEN|PASSWORD|USERNAME|_authToken' /tmp/rel.log | tail -20   # read FIRST
shred -u /tmp/rel.log; rm -rf ondewo-devops-accounts                     # then scrub
```

### Run the release from `master`, and check with `git branch --show-current`

A release ends by checking out `release/<version>`, and **nothing checks you out back**. Start the
next release from that leftover checkout and `git commit` + `git push` land on the OLD release
branch: the new `release/<version>` is cut from it, the tag points into it, and `master` never sees
the release at all. Measured on ondewo-csi-client-typescript 5.5.1 -- npm had it, the tag had it,
and `origin/master` was still at 5.5.0. Recovery was a fast-forward (`git merge --ff-only
release/5.5.1`), which worked only because nothing else had moved; a diverged `master` needs a real
merge.

```bash
git branch --show-current            # must print master BEFORE `make ondewo_release`
```

### The release `git add` list is an ALLOW-LIST, so anything outside it ships but is never committed

`make build` writes files the release target then stages from a fixed list of paths. Anything the
build touches that is not on that list reaches the registry and is **absent from the tag of that
same version** -- two different things under one name, with nothing anywhere reporting it.

- **`auth/`** -- the hand-written Keycloak provider and its spec. It is top-level, so `git add src`
  does not cover it. csi-client-js and csi-client-typescript 5.5.1 went to npm carrying the refresh
  fix and tagged a commit without it; 5.5.2 exists only to make the two agree.

- **`README.md`**, which is a BUILD OUTPUT -- `make build` runs `cp src/README.md .`. Anything
  written only in the root copy is destroyed by the next build. The typescript NLU client's
  "Authentication" section lived in git history and nowhere else for exactly that reason; it belongs
  in `src/README.md`, which is the source of truth.

The general check costs nothing:

```bash
git status --porcelain    # MUST be empty after a release; anything left is published-but-uncommitted
```

### `git commit` exits 1 on a clean tree and takes the whole target down with it

If the release content was already committed by hand, `git commit` finds nothing to commit, returns
1, and make abandons the target -- **before** the publish, the branch, the tag and the GitHub
release -- while printing only `nothing to commit, working tree clean`. Read as a build failure it
sends you hunting a compile error that is not there. The line is prefixed with `-` so the step is
advisory; `spc` still refuses an existing branch or tag, so the guard cannot mask a double release.

### Write the RELEASE.md section BEFORE releasing, or the release body is silently empty

`CURRENT_RELEASE_NOTES` slices RELEASE.md between the heading naming this exact version and the next
`*****` separator. No heading means an EMPTY slice, `gh release create -n ""` succeeds, and you get a
release with no notes and no error anywhere. ondewo-nlu-client-js and -typescript 7.1.1 shipped that
way and had to be repaired after the fact.

```bash
cat RELEASE.md | perl -ne 'print if /<the exact heading> <version>/../^\*{5}/' | wc -l   # must be > 0
```

### Verify the three artefacts separately -- they fail independently

GitHub's release API returned 500 twice in one session, leaving the registry and the tag correct and
**no release object at all** (nlu-client-js and -angular 7.1.1); `gh release create` after the fact
repairs it without touching the artefact.
And npm answering `409 Cannot publish over previously staged
version` is NOT a failure -- the publish SUCCEEDED and the registry has not served it yet, so a 404
from `npm view` in the same minute is the same fact from the other side. Do not burn a version
number over it; wait and re-check.

```bash
npm view <pkg> version ; git tag --list <version> ; gh release view <version> --json body --jq '.body|length'
```
