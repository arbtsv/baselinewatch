---
name: public-pr
description: Ship changes in this public repository as a pull request through the leak guard. Covers committing on a branch, pushing through the pre-push hook, opening a draft PR, posting the leak-review marker, marking the PR ready, watching CI and squash-merging when the maintainer asks. Use it for every push to this repository.
---

# public-pr

Everything pushed here is public. The pre-push hook (`.githooks/pre-push`) reviews
each commit, and CI accepts a pull request only after this skill posts the hook's
verdict as a marker comment. Policy: `docs/public-hygiene.md`.

## Rules

- Never `git push --no-verify`. Never set `BASELINEWATCH_LEAK_*` variables: the
  maintainer alone decides on overrides, and the others exist for tests.
- Never quote a finding, a denylisted term or the matching text in a commit
  message, PR title, PR body, comment or CI input. Findings stay in
  `.git/leak-review/`.
- Stage explicit paths. Never `git add -A`, `git add .` or `git add -f`.
- Never push to `main`. Never merge without the maintainer's go-ahead.

## 1. Preconditions

```sh
git config core.hooksPath     # must print .githooks
gh auth status
git branch --show-current     # must not be main
```

If `core.hooksPath` is not `.githooks`, stop and ask the maintainer to run
`git config core.hooksPath .githooks`. Without the hook there is no verdict and
no marker. If you are on `main`, create a branch first:
`git switch -c <type>/<short-slug>`, where type is feat, fix, docs, chore, test or ci.

## 2. Commit

Write commit messages in English, about the change itself. Mention no context
from outside this repository. Check the size of the range:

```sh
git fetch origin
git rev-list --count HEAD --not --remotes=origin
```

If it is above 20, squash first:
`git reset --soft $(git merge-base HEAD origin/main)`, then commit once.

## 3. Push through the hook

```sh
git push -u origin HEAD
```

The LLM review takes up to 2 minutes per commit and 15 minutes per push. Give
the command a timeout of at least 16 minutes. Outcomes:

- **Clean**: the hook prints `pre-push: clean (...)`. Continue.
- **Finding** (denylist, image or reviewer LEAK): read the report in the
  terminal or in `.git/leak-review/commits/<sha>.review.txt`. Fix it like this:
  `git reset --soft <last pushed commit or merge-base>`, edit, commit once, push
  again. If you believe it is a false positive, stop and tell the maintainer.
  Do not argue with the reviewer by rewording around it.
- **Manifest change** (`docs/img/MANIFEST.txt`): the hook refuses without a
  terminal. Ask the maintainer to look at the images and push from their own
  terminal, then continue from step 4.
- **Anything else** (missing `.private/`, reviewer not found, timeout, malformed
  answer): report the message to the maintainer. Do not work around it.

## 4. Read the verdict

```sh
head=$(git rev-parse HEAD)
cat ".git/leak-review/$head.txt"
```

The first line decides the marker. The second line must be `head: <$head>`.

| First line          | Marker                           |
|---------------------|----------------------------------|
| `VERDICT: CLEAN`    | `Leak review: clean at <head>`   |
| `VERDICT: OVERRIDE` | `Leak review: override at <head>`|
| anything else, no file, other head | none: stop and report |

Use the full 40-character sha. Post nothing else in the marker comment.

## 5. Open or update the pull request

```sh
gh pr view --json number,isDraft,state
```

**No PR yet:**

```sh
gh pr create --draft --base main --title "<title>" --body-file <file>
gh pr comment <number> --body "Leak review: clean at <head>"
gh pr ready <number>
```

`ready_for_review` starts the leak-marker job, and by then the marker exists.

**Draft PR:** post the marker, then run `gh pr ready <number>`.

**Ready PR** (new commits pushed): post the marker, then find the CI run of this
head and wait for it to finish:

```sh
gh run list --commit <head> --workflow ci.yml --json databaseId,status --jq '.[0].databaseId'
gh run watch <run-id> --exit-status
```

The run may take a few seconds to appear, so retry the list command. If the run
failed, list the failed jobs:

```sh
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | .name'
```

If `leak-marker` is among them (it may have read the PR before the marker
existed), rerun it with `gh run rerun <run-id> --failed`, then watch again.
Report every other failure to the maintainer.

## 6. Checks and merge

```sh
gh pr checks <number> --watch
```

When all checks are green, report the PR link and wait. Merge only when the
maintainer says so:

```sh
gh pr merge <number> --squash --delete-branch
git switch main
git pull --ff-only
```
