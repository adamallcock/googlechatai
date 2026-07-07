# Security Policy

Do not publish credentials, tokens, service-account keys, OAuth refresh
tokens, live Chat payload captures, or private customer/user content in
issues, commits, packages, or fixtures.

## Supported Versions

googlechatai is in early development (0.0.x). Only the latest published
version on npm and PyPI receives fixes; there are no maintained backport
branches yet.

## Reporting A Vulnerability

Report security issues privately via GitHub's private vulnerability
reporting on this repository
(https://github.com/adamallcock/googlechatai/security/advisories/new).
Do not open public issues for exploitable problems. When a public issue is
appropriate, describe the affected component and reproduction shape without
pasting secrets, private keys, access tokens, personal records, or live
workspace data.

Areas of particular interest: the inbound request verification module
(JWT/JWKS handling, including the stdlib-only Python RS256 path), the plan
executor's safety gates, and anything that could cause a bot to write
outside its intended space.

## Local Checks

Before staging or publishing-adjacent work, run:

```bash
pnpm hygiene:generated
pnpm hygiene:secrets
pnpm release:check
git status --short --branch
```

The secret scanner is a guardrail, not a guarantee. If a token or private
key is ever committed, rotate it immediately and remove it from history
before sharing the repository.
