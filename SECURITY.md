# Repository tooling security

## September 2026 remote-code injection

Remote commit `e0618624142cdc689da544fc767b0fab2e94c995` appended an obfuscated
JavaScript downloader/executor to `apps/api/eslint.config.mjs`. It automatically
launched from the config, fetched a payload using blockchain-based address
discovery, and used `eval` and detached Node child processes. Its diff also hid
unexpected auto-push artifacts via `.gitignore`. Neither change belongs to the API.

The repair reconciles that commit as history while keeping the verified clean
local tree. It does not execute the payload or force-push history. The original
commit remains available for investigation: do not check it out in an editor
that loads ESLint, run its tooling, or rerun its GitHub Actions jobs.

At investigation time, the affected commit was also the head of four other
remote branches: `feature/discovery-conversations`, `feature/message-replies`,
`feature/messaging-realtime`, and `fix/ci-postman-socket-docs`. Updating `main`
alone does not clean those branch heads, old clones, historical commits, or
previously generated build artifacts. They need separate reviewed remediation.

The [affected CI run](https://github.com/chinonsogreat7/chateo/actions/runs/34558869917)
reported success; this is not evidence the checkout was safe. A loader can catch
its own errors or run silently. The GitHub events inspected were attributed to
the account `chinonsogreat7`; this does not identify the person, device, app, or
credential that performed the pushes. The downloaded next-stage payload was not
retrieved, so its full behavior and any data access/exfiltration remain unknown.

## Integrity gate

Before installing dependencies or loading tooling, run:

```bash
node scripts/verify-tooling.mjs
node --test scripts/verify-tooling.test.mjs
```

The checker uses only Node built-ins. It reads five protected executable configs
as bytes and compares their SHA-256 digests against `scripts/tooling-integrity.json`;
it never imports or evaluates those configs. Missing/changed files, symlinks and
invalid manifest entries fail closed. The separate required-file list prevents
removing a manifest entry from silently opting a config out of verification.
The protected paths use LF line endings through `.gitattributes` so fresh
Windows checkouts verify the same bytes as CI.

CI runs the gate before `npm ci`; both root and API `npm run lint` run it before
ESLint. CI checkout no longer persists its Git credential. Run the gate explicitly
before direct `npx eslint`, editor lint integrations, or other tooling: those
entry points can bypass npm lifecycle scripts. It does not scan dependencies,
all source files, newly added tooling files, or other machines.

An intentional tooling change requires reviewing the **entire file/diff**, then
updating the corresponding digest. Do not automatically regenerate the manifest
to make a failing check pass. Use a trusted checkout/device for that review.

This is a regression tripwire, not malware removal software or a trust boundary
against a writer who can change the checker, manifest, and workflow together.
Protect those files through review requirements and branch rules. The gate cannot
prevent execution from an older affected commit or undo prior credential theft.

## Preventing recurrence: account and device response

Code cleanup alone does not establish that account/device access is safe. From a
known-clean device:

1. Review the [GitHub security log](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/reviewing-your-security-log)
   around the unauthorized changes and unfamiliar authentication/app events.
   Preserve evidence before removing access; commit author fields are not proof
   of who actually pushed a commit.
2. Audit personal access tokens, SSH/deploy keys, authorized OAuth/GitHub Apps,
   active sessions and repository collaborators. Revoke unfamiliar or potentially
   exposed access and enable strong account authentication. See GitHub's
   [SSH key and access review guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/reviewing-your-ssh-keys).
3. If an affected checkout's tooling ran, treat that machine/runner and its
   accessible credentials as potentially compromised. Stop using it for secrets;
   investigate/clean or rebuild it before provisioning replacement credentials.
   Review CI access, deployment artifacts and any secrets available there too.
   A passing CI run does not rule out compromise.
4. Rotate credentials that could actually have been exposed, from a clean device,
   with coordinated deployment updates to avoid outages. Do not paste secret
   values into issues, logs, or chat. No tokens/keys are revoked by this code fix.
5. Configure [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches):
   prevent force pushes, require reviewed pull requests and passing CI, and review
   bypass permissions. At investigation time `main` was unprotected. Changing
   account access, credentials or repository rules requires explicit approval;
   this repair does not change those settings.

GitHub documents the checkout credential option in
[actions/checkout](https://github.com/actions/checkout/blob/main/README.md).
