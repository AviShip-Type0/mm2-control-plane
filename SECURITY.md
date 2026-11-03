# Security policy

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository (a private advisory). Do not open a public issue.

Include what you found, where, how to reproduce it and the likely impact.

## Secrets

- No secrets in git, ever: tokens, keys, passwords or `.env` files. Commit only `*.example` files.
- Secrets live in the platform that uses them (Cloudflare secrets, GitHub Actions secrets).
- If a secret is committed, revoke it first, then remove it from history. Treat it as compromised.

## Data

This repository must never hold client, investor or staff personal information, or non-public financial information.
