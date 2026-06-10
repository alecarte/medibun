<!-- What does this change and why? Link the sprint goal / roadmap item it traces to. -->

## Definition of done (CLAUDE.md)

- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm test` pass
- [ ] New behavior has tests (failing test written first)
- [ ] No secrets or PHI in the diff, logs, or fixtures (synthetic test data only)
- [ ] Small diff — every changed line traces to the request
- [ ] AccessPolicy reviewed, if this adds/changes a PHI-touching endpoint
- [ ] `security-reviewer` subagent ran, if this touches PHI, auth, or AccessPolicy

## Approval gates (delete if not applicable)

- [ ] This change touches auth/authz/AccessPolicy, a schema/FHIR migration, a new
      PHI-touching dependency, or weakens a security control — **explicit human approval
      obtained before merge**
