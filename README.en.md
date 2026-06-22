# Serenity

> **Not a sandbox — a cognitive container.**

中文 | [English](./README.en.md)

---

> ⚠️ **Plugin Safety Note**
>
> This plugin (ACC — Abstract Cognitive Container) **fully activates only** inside directories that contain a `.serenity` marker file (i.e., a CCC — Concrete Cognitive Container).
>
> When you start OpenCode in a normal project directory, the plugin **has zero effect on OpenCode's original functionality**:
>
> - No system prompt injection
> - No path isolation guards installed
> - No bash toggle control
> - No container tools exposed (msm, cc-fs, cc-git, session, etc. — tools are registered but inert without a container context)
> - No modification to any of OpenCode's default behavior
>
> Feel free to install it globally. Serenity only awakens when you **intentionally enter a CCC directory**.

---

## 1. Entity Definitions

### 1.1 Entity Inventory

The system consists of **5 core entities** defined below, from highest abstraction level to lowest.

#### Entity A — ACC (Abstract Cognitive Container)

| Property | Value |
|----------|-------|
| **Definition** | The blueprint layer for a cognitive container. It declares "what tools, constraints, and lifecycle rules a cognitive container should have." |
| **Type** | OpenCode plugin (npm package `@shgroup/opencode-serenity-plugin`) |
| **Existence form** | JavaScript code installed at `~/.config/opencode/plugins/` |
| **Activation condition** | Loaded automatically when OpenCode starts. **Full activation** requires the current working directory to contain `.serenity`. Without `.serenity`, all hooks are silent and all tools are registered but lazy (no-op when called). |
| **Deactivation condition** | Entering a directory without `.serenity`. |
| **Owner** | Maintained by plugin author (`@tellmewhattodo`). User upgrades via `npm update`. |
| **Lifecycle** | Install → upgrade → uninstall. Single global instance. |
| **Dependencies** | Node ≥ 20, OpenCode ≥ 1.16 |

#### Entity B — CCC (Concrete Cognitive Container)

| Property | Value |
|----------|-------|
| **Definition** | A runtime instance of the ACC. A bounded workspace where Agents and humans collaborate on a specific domain (project, operations, experiment). |
| **Type** | Directory tree identified by a `.serenity` marker file |
| **Existence form** | A filesystem directory containing `.serenity`, `.opencode/skills/`, `AGENT_SESSIONS/`, `docs/`, `opencode.json` |
| **Activation condition** | OpenCode's current working directory is the CCC root (contains `.serenity`). |
| **Deactivation condition** | OpenCode switches to a different directory. |
| **Creation method** | `npx opencode-serenity-plugin init <path>` or `/serenity-init` slash command in OpenCode. |
| **Owner** | The user. User creates, names, configures, and deletes CCCs. |
| **Lifecycle** | Phase 1 skeleton creation → Phase 2 Agent-driven interview → continuous use → optional archive. |
| **Dependencies** | ACC must be installed first. ACC : CCC = 1:N. |

**Scope**:

| Scope | Includes |
|-------|----------|
| **In scope** | CCC root directory and all subdirectories. Agent mental model (root skill). Session records in AGENT_SESSIONS/. Skill documents in .opencode/skills/. MSMs in .opencode/scripts/. opencode.json. |
| **Out of scope** | Any file outside the CCC root directory. Host system global configuration (except opencode itself). Files inside other CCC directories. |

#### Entity C — Skill

| Property | Value |
|----------|-------|
| **Definition** | A structured encapsulation of domain knowledge for the Agent. It tells the Agent "what entities, rules, operations, and boundaries exist in this domain." |
| **Type** | Directory at `.opencode/skills/<skill-name>/` |
| **Required components** | `SKILL.md` — describes existence rationale, trigger conditions, and usage. Optional: `references/` (reference data), `scripts/` (MSM executable operations). |
| **Activation condition** | When CCC starts, Agent automatically loads all installed SKILL.md contents from `.opencode/skills/` into system prompt. |
| **Creation method** | User asks Agent to distill from SESSION.md, or manual authoring. Phase 1 pre-installs 3 standard skills (compass, session, sqc). |
| **Owner** | User creates and manages. Agent only operates skill files under user direction. |
| **Dependencies** | Requires CCC to exist. Skill : CCC = N:1. |
| **MSM relationship** | Skill holds MSM. A skill can have 0 to N MSM scripts (in `scripts/` subdirectory). |

#### Entity D — MSM (Mech & Semi-Mech)

| Property | Value |
|----------|-------|
| **Definition** | An executable operation unit owned by a skill. It encapsulates deterministic operations within a skill — turning routine operations into auditable, composable interfaces. |
| **Type** | Script file (`.ts`, `.js`, `.py`, `.sh`), registered in `mech-registry.json` |
| **Subtypes** | **Mech** — pure TypeScript script, zero LLM inference. **Semi-Mech** — TypeScript framework + LLM decision points. |
| **Execution method** | Agent calls via `msm_exec <name>`. User cannot execute directly (no bin entry). |
| **Registration method** | `msm_admin register --name <name> --path <path> --description <desc> --category mech|semi-mech` |
| **Activation condition** | MSM is registered in `mech-registry.json`. |
| **Owner** | Skill holder (user). MSM : Skill = N:1. |
| **Safety mechanism** | All path arguments automatically validated against directory escape (path-escape guard). All calls automatically logged to session records. |
| **Examples** | `compass-tool validate/judge` (semi-mech, belongs to compass skill), `cc-fs` (mech), `ssh-connect` (mech) |

#### Entity E — Session (Work Session)

| Property | Value |
|----------|-------|
| **Definition** | A full lifecycle record of a multi-step work task. Contains goals, key decisions, progress, artifacts, and unresolved issues. |
| **Type** | Directory at `AGENT_SESSIONS/<YYYY-MM-DD--<desc>>/`, containing `SESSION.md` |
| **Creation method** | Agent creates automatically via `session create`. Should be created before each multi-step work. |
| **Lifecycle** | active (in progress) → closed (completed) → archived |
| **Identifier** | Auto-assigned S### ID (e.g., S001, S002) |
| **Owner** | Agent records per `session` tool spec. User reads and reviews. |
| **Dependencies** | Requires CCC to exist. Session : CCC = N:1. |

### 1.2 Entity Relationship Map

```
ACC (1) ──declares──> CCC (N)
  │                       │
  │                       ├── contains Skill (N) ──holds──> MSM (N)
  │                       │
  │                       ├── contains Session (N)
  │                       │
  │                       └── constrains Agent (1)
  │
  └── provides tools ──> cc-fs, cc-git, msm_list/exec/admin, session, cc-ck, eap, neat
```

| Relationship | Direction | Cardinality | Dependency |
|-------------|-----------|-------------|------------|
| ACC declares CCC | ACC → CCC | 1:N | CCC requires ACC installed |
| CCC contains Skill | CCC → Skill | 1:N | Skill requires CCC directory first |
| Skill holds MSM | Skill → MSM | 1:N | MSM requires skill directory first |
| CCC contains Session | CCC → Session | 1:N | Session requires CCC first |
| ACC constrains Agent | ACC → Agent | 1:N | Agent constrained only when running inside CCC |

---

## 2. Activation Model

### 2.1 Activation Decision

```
OpenCode starts
  │
  ├── Current directory has .serenity?
  │     ├── Yes → CCC fully activated
  │     │       ├── Hook: Path Isolation (P3) active
  │     │       ├── Hook: Bash Toggle (D19) active
  │     │       ├── Hook: Subagent Inheritance active
  │     │       ├── Hook: System Prompt Injection active
  │     │       ├── All tools become live (operational)
  │     │       └── Skill SKILL.md injected into Agent system prompt
  │     │
  │     └── No → Plugin silent
  │               ├── Hooks: all inactive
  │               ├── Tools: registered but lazy (returns "no CCC context")
  │               └── Zero modification to OpenCode's native behavior
```

### 2.2 Hook Activation Matrix

| Hook | Trigger | Inside CCC (.serenity) | Outside CCC |
|------|---------|------------------------|-------------|
| **Path Isolation (P3)** | Each Agent file tool call | Read/write confined to `.serenity` directory | Inactive |
| **Bash Toggle (D19)** | Each Agent bash call | `msm_exec` preferred. Control via `/serenity-bash-off`/`/serenity-bash-on` | Inactive |
| **Subagent Inheritance** | Each subagent launch | Subagent auto-inherits path/bash/SSH constraints | Inactive |
| **System Prompt Injection** | Each conversation start | Injects "you are in a CCC" context | Inactive |

---

## 3. Tool System

### 3.1 Tool Inventory

**9 tools** in total. Agent gains these immediately after installation, no code to write.

| Tool | Category | Subcommands | Purpose |
|------|----------|-------------|---------|
| `msm_list` | Query | — | Query available MSMs in current CCC (with descriptions and flag schemas) |
| `msm_exec` | Execute | — | Safely execute registered MSMs. Path escape auto-blocked. **Replaces bare bash** |
| `msm_admin` | Manage | `register`, `deregister`, `guide`, `check` | MSM registration/deregistration, dev guide, MSM quality check. Auto git commit |
| `cc-fs` | File | `root`, `resolve`, `exists`, `list`, `tree`, `relative`, `mkdir`, `rm`, `mv`, `cp`, `touch`, `append` | 12 file operations, all confined to CCC root. Path escape auto-blocked |
| `cc-git` | Git | `status`, `commit`, `push`, `log`, `pull` | High-frequency Git operations. Non-fast-forward push outputs actionable suggestions. Conflict resolution via bash |
| `session` | Session | `list`, `show`, `create`, `use`, `close`, `health`, `qa`, `archive`, `summary` | Full session lifecycle management. Auto-assigns S### IDs, stale detection, fact verification |
| `cc-ck` | Health | None | CCC three-principle health check: P1 (.serenity exists), P2 (git-managed), P3 (opencode.json exists). Returns pass/fail report |
| `eap` | Cognitive quality | None | EAP theory framework (progressive disclosure). Defines cognitive quality metrics (E↑ / R↓ / S↑), guides Agent thinking structure |
| `neat` | Collaboration | None | Neat design collaboration protocol. Small-step alignment, explicit decisions, document-driven |

### 3.2 Tool CCC Dependency

All 9 tools follow the same rule:
- **Inside CCC**: Normal execution, full capability available.
- **Outside CCC**: Tools are registered but return "not in CCC context, tool does not function" when called.

---

## 4. Pre-installed Skills

Phase 1 skeleton creation auto-installs 3 standard skills, each with executable MSMs:

| Skill | Directory | Existence Rationale | MSM Tools |
|-------|-----------|---------------------|-----------|
| **compass** | `.opencode/skills/compass/` | Direction assessment — 3-channel fast evaluation of whether a new task is viable. Prevents cognitive resource waste on infeasible tasks. | `compass-tool validate` (validate signal report), `compass-tool judge` (comprehensive judgment) |
| **session** | `.opencode/skills/session/` | Session tracking — extends ACC's built-in `session` tool with container-level operations. Assigns S### IDs to historical sessions. | `session-tool reindex` (assigns S### IDs to sessions lacking them) |
| **sqc** | `.opencode/skills/sqc/` | Quality cycle — scans all skill quality against DC (Design Check) rules. Prevents information entropy (broken references, orphan skills, template compliance). | `sqc-tool check`, `sqc-tool report`, `sqc-tool pipeline`, `msm_admin check` (MSM quality check) |

---

## 5. Two-Phase Initialization (D1)

### 5.1 Phase 1 — Skeleton Creation

**Input**: User provides container name (e.g., `my-project`), optional description.

**Output**: The following directory structure is auto-generated at the specified path.

```
my-project-serenity/
├── .serenity                    ← File type: container marker. Its existence declares "this directory is the CCC boundary."
├── .gitignore
├── opencode.json                ← File type: OpenCode Agent config. Declares a clean primary agent.
├── AGENT_SESSIONS/              ← Directory type: work session storage. Each multi-step work auto-generates SESSION.md.
├── docs/                        ← Directory type: design document storage.
└── .opencode/
    ├── skills/
    │   ├── my-project-serenity/ ← Root skill. Phase 2 Agent completes its SKILL.md via collaborative interview.
    │   ├── compass/             ← Pre-installed skill (see Section 4)
    │   ├── session/             ← Pre-installed skill
    │   └── sqc/                 ← Pre-installed skill
    └── references/
```

**Auto operations**: Git `init → commit → push` (if user provided a remote URL).

### 5.2 Phase 2 — Agent-Driven Interview

**Trigger condition**: After Phase 1 completion, user's first message when starting OpenCode in the CCC directory.

**Flow**: Agent intercepts the first message, does not answer directly. Enters EAP collaborative interview mode, covering these topics sequentially:

| Topic | Question | Agent Output |
|-------|----------|-------------|
| 1 — Purpose | What does this container manage? Purpose in one sentence. Team size (solo/team). | Records purpose and scope into root SKILL.md |
| 2 — Git remote | Set up Git remote? | Calls `cc-git` to set remote if URL provided |
| 3 — Work items | What concrete work items will this CCC track? | Records work item list into knowledge base |
| 4 — Collaboration style | Casual or structured? | Configures Agent response style |
| 5 — External services | What external services or domain-specific skills needed? | Records integration requirements in root skill |

**Completion condition**: Agent writes complete root `SKILL.md`, commits, pushes. CCC is fully ready.

**Failure handling**: User says "I'm not sure" on any topic — Agent uses sensible defaults and records incomplete items in `docs/phase2-interview-record.md`.

---

## 6. CCC Lifecycle & Best Practices

### 6.1 Flywheel Model

```
Concrete work produces decisions, constraints, domain experience
  → Automatically settles in SESSION.md (zero operational cost)
  → User decides: which know-how is worth distilling into a Skill?
     (Hint: ask Agent after work "what's worth distilling into a skill?")
  → Once distilled into SKILL.md, Agent loads it next time automatically
  → Fuller context → higher efficiency → more time for new work
  → Flywheel accelerates
```

### 6.2 Knowledge Layers

| Layer | Name | Writer | Reader | Accumulation Cost |
|-------|------|--------|--------|-------------------|
| **L1 — SESSION** | Default sedimentation | Agent (`session create`) | User, Agent (retrospect) | Zero (automatic) |
| **L2 — SKILL.md** | Selective distillation | Agent (on user request) | Agent (loaded at every startup) | User judgment decision |
| **L3 — MSM** | Operation encapsulation | User registers | Agent (via `msm_exec`) | User registration decision |

### 6.3 Entropy Control

**Problem**: Knowledge accumulation naturally causes information entropy — outdated knowledge, duplicates, constraint conflicts.

**Countermeasure**: SQC (Quality Cycle) scans all skill quality against DC rules at a regular cadence:

- Auto-fixes automatable issues (broken references)
- Flags items requiring human judgment (constraint conflicts, orphan skills)
- Recommended cadence: **`sqc-tool pipeline` weekly**

### 6.4 Skill Distillation Examples

| Skill | Encapsulated Content | Distillation Rationale |
|-------|----------------------|----------------------|
| **deployment** | CI commands, env var configuration, rollback steps, common failure causes and fixes | Repeating questions every deployment → write into skill, available next time |
| **frontend-patterns** | State management library, API call layer organization, error feedback UI standards | Agent generates team-consistent code directly, no per-task corrections |
| **code-review** | DB migration compatibility requirements, component boundary rules, security checklist | Agent self-reviews before submitting, catches low-level issues before commit |

### 6.5 MSM Operation Encapsulation Examples

| Operation | MSM Name | Rationale | Effect |
|-----------|----------|-----------|--------|
| Deploy | `deploy` | Steps are fixed (build → test → tag → push → rollout), manual execution is error-prone | Agent completes safe deployment with one command, errors auto-blocked |
| API test | `api-test` | Smoke tests, contract tests repeat often | Agent runs anytime, structured result output |
| Commit | `commit` | Special commit conventions (scope format, co-author, issue links) | Agent conforms automatically |
| Migration check | `migrate-check` | Must verify backward compatibility before release | Agent auto-analyzes migration scripts, flags breaking changes |

---

## 7. Why Serenity

There's a ship in the movie *Serenity*. Not big, not new, but reliable. It flies through the universe — it can't know every planet, but it has its own cabins and its own course. The crew doesn't know what's in every cargo hold, but when they need something, they can always get it.

That's how CCC works: not omniscience, but accessibility. Information piles up, keeps changing, no one can master it all — but a ship doesn't need to master the whole universe. Flying well on its own course is enough.

---

## 8. Philosophy: The ACC/CCC Model

If Serenity were an operating system:

- **ACC is the kernel** — it declares "what a cognitive container should have" (tools, hooks, validation rules). It's shared across containers.
- **CCC is the user-space workspace** — it holds a specific project's skills, MSM registry, session records, and project files. Each CCC is independent.

Upgrade the plugin (`npm update` + `install`), and all CCCs automatically gain new tools and guards — because ACC is a shared blueprint, and CCCs are independent instances.

The theoretical foundation is **EAP** (Explicit Abstraction Principle): *"The functional value of a thought is proportional to its external reconstructability."* Every design decision in Serenity derives from this statement.

Full EAP theory: <https://github.com/tellmewhattodo/theory-eap>

---

## 9. Quick Start

### 9.1 Installation

```bash
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
```

### 9.2 Create a CCC

Start OpenCode in any directory, enter `/serenity-init`. The TUI prompts for container name and description, then auto-creates the complete container skeleton.

Or use CLI:

```bash
opencode-serenity-plugin init /path/to/my-project \
  --prefix my-project \
  --description "Manages my startup's code, docs, and dev workflow"
```

### 9.3 Complete Initialization

Restart OpenCode, type any message. The Agent automatically enters Phase 2 interview. CCC is fully ready after the interview completes.

---

## 10. Multi-Container Management

One plugin manages all containers. Each CCC lives in its own directory, non-interfering:

```
~/projects/
├── saas-app/          ← CCC: SaaS development
├── ops-tools/         ← CCC: Operations tools
└── ai-lab/            ← CCC: AI experiments
```

Within a single OpenCode session, the Agent can only access files in the CCC of the current working directory.

---

## 11. Development

```bash
git clone git@github.com:tellmewhattodo/opencode-serenity-plugin.git
cd opencode-serenity-plugin
pnpm install

pnpm typecheck    # TypeScript type checking
pnpm test         # 413+ tests (vitest)
pnpm build        # Compile + copy templates
pnpm install      # Install to local ~/.config/opencode/
```

---

## 12. Use Cases

Serenity is not bound to any domain. A container's **shape** depends on what MSMs you register and what SKILL.md you write:

| Scenario | The Container Becomes | Typical MSMs |
|----------|----------------------|--------------|
| Software development (requirements → design → code → test) | Controlled development environment | `deploy`, `api-test`, `commit`, `migrate-check` |
| Server, network, NAS, smart home management | Operations hub | `ssh-connect`, `health-check`, `backup` |
| AI experiments (training, results, comparison) | Reproducible experiment chamber | `train`, `evaluate`, `compare` |
| Media processing, documentation, translation | Content workbench | `transcribe`, `translate`, `publish` |

---

> **Version**: v0.4.13 &nbsp;|&nbsp; **License**: MIT &nbsp;|&nbsp; **Prerequisites**: Node ≥ 20, OpenCode ≥ 1.16
>
> **Platform**: Serenity is tested on OpenCode CLI (terminal), Linux desktop, and macOS. **Windows is untested and not guaranteed.**
>
> **Full EAP theory**: <https://github.com/tellmewhattodo/theory-eap>
