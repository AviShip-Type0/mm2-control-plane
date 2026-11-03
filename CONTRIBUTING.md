# Contributing

These rules apply to people and to automated agents.

## Branching

Branch from the default branch: `feat/<short-name>`, `fix/…`, `docs/…`, `chore/…`. Keep branches short-lived. Changes land through pull requests.

## Commits

Use Conventional Commits: `<type>(<scope>): <summary>`, imperative, at most 72 characters. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

## Pull requests

1. Open a pull request using the template, and link the issue if there is one.
2. Checks must pass where the repo has them.
3. Squash-merge. The PR title becomes the commit, so use the Conventional Commit format. Delete the branch on merge.

## Secrets and data

No secrets, personal data or confidential material in git. See [SECURITY.md](SECURITY.md).
