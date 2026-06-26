# WIP: Write Interceptor Protocol (v1)

> Source of truth for the Write Interceptor Protocol design.
> Status: **Draft** — implementation in progress.

## Problem

CCCs need the ability to intercept and potentially block `write` and `edit` operations on their own workspace. Use cases:

- **Content validation**: reject writes that produce malformed YAML/frontmatter (e.g., in member profiles)
- **Cross-file consistency checks**: verify that a write doesn't break invariants across multiple files
- **CI-style pre-commit validation**: lightweight checks at write time, before git commit
- **Custom auditing/logging**: track file modifications with custom metadata
- **Structural enforcement**: prevent writes to specific paths not covered by RR5

Existing tools don't solve this:
- RR5 only checks path boundaries (inside/outside cwdRoot) — not content or semantics
- SEP hooks are post-processing only and cannot block operations
- `tool.execute.before` is owned by ACC; CCCs have no way to inject logic into it

## Solution

**Write Interceptor Protocol (WIP)** — a CCC-registered MSM that the ACC calls during `tool.execute.before` for `write` and `edit` operations, **after** RR5 path validation passes.

### Pattern

WIP follows the same extension pattern as SEP (Session Extension Protocol):

```
ACC (plugin)                         CCC (home-serenity, etc.)
┌────────────────┐                   ┌─────────────────────┐
│ tool.execute   │                   │ mech-registry.json  │
│ .before        │                   │  └─ write-interceptor│
│  │             │                   └─────────┬───────────┘
│  ├─ RR5 check  │                             │
│  └─ WIP call ──│──── callMsmExec ────────────▶│
│       │        │                             │
│       │  exit 0│◀──── ALLOW ─────────────────│
│       │  exit 1│◀──── BLOCK ────────────────│ (stderr as msg)
│       │  throw │◀──── FAIL-SAFE ────────────│ (allow + log warn)
│       ▼        │                             │
│  write/edit    │                             │
│  proceeds or   │                             │
│  blocked       │                             │
└────────────────┘                             └─────────────────────┘
```

### Protocol

The ACC calls the MSM with:

```
msm_exec write-interceptor --tool=<write|edit> --paths=<abs-path1,abs-path2,...>
```

| Flag | Type | Required | Description |
|------|------|----------|-------------|
| `--tool` | `string` | Yes | `write` or `edit` |
| `--paths` | `string` | Yes | Comma-separated absolute paths being written |

### Exit Code Contract

| Code | Meaning | ACC behavior |
|------|---------|-------------|
| `0` | ALLOW | Write proceeds normally |
| `1` | BLOCK | Write is blocked; stderr content used as error message |
| other | ERROR | Fail-safe: write proceeds, warning logged |
| throw | CRASH | Fail-safe: write proceeds, warning logged |

### Fail-Safe Principle

The CCC's interceptor **cannot break** the write workflow:

| Scenario | Behavior |
|----------|----------|
| `write-interceptor` not registered | Allow (backward compatible — no behavior change) |
| MSM throws or exits with non-0/1 | Allow + log warning |
| MSM exits 1 | Block with stderr message |
| MSM exits 0 | Allow (no-op) |

### Implementation

**ACC side** — `src/hooks/permission-guards.ts`:

1. After RR5 path validation passes for `write`/`edit`, load CCC's mech-registry
2. Check if `write-interceptor` MSM is registered
3. If yes, call `callMsmExec` with `--tool` and `--paths`
4. Interpret exit code per contract above
5. Fail-safe: wrap entire call in try-catch

**CCC side** — Template MSM:

```typescript
// write-interceptor.ts template
// Agents: implement your interception logic in checkWrite()
//   exit(0) = ALLOW, exit(1) = BLOCK (stderr = reason)
function checkWrite(tool: string, paths: string[]): void {
  // Example: block writes to profile YAML files if they lack required fields
  for (const p of paths) {
    if (p.endsWith('.md') && p.includes('/profiles/')) {
      // Validate content — return early to allow
      // Or: console.error("missing required field"); process.exit(1);
    }
  }
  process.exit(0);
}
```

### File Changes

| File | Change | Layer |
|------|--------|-------|
| `docs/write-interceptor-protocol-design.md` | **New** — this document | Design |
| `src/hooks/permission-guards.ts` | Add `callWriteInterceptor()` after RR5 check | ACC |
| `src/templates/write-interceptor/scripts/write-interceptor.ts` | **New** — CCC template MSM | Template |
| `src/templates/write-interceptor/SKILL.md` | **New** — template skill doc | Template |

### Backward Compatibility

- CCCs without `write-interceptor` registered → identical behavior (no interceptor call)
- Existing `tool.execute.before` behavior unchanged (RR5 still runs first, still hard-blocks on path violation)
- No new config options needed

### Relationship to SEP

| Aspect | SEP | WIP |
|--------|-----|-----|
| Timing | Post-processing (after ACC action) | Pre-processing (before tool execution) |
| Can block? | No | Yes (exit 1) |
| Trigger | `session create` etc. | `write` / `edit` tools |
| Hook discovery | `discoverCccHooks()` via flag description | MSM name check in registry |
| Fail-safe | Catch → append warning to message | Catch → allow write silently |
