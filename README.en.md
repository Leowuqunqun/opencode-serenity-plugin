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

## What is Serenity

Serenity is a **Cognitive Infrastructure** — not a coding assistant, not a project management system, not an AI Agent platform.

It is a workspace where Agents and humans collaborate at the cognitive level.

### The Problem It Solves

The core dilemma of today's AI Coding Agents: Agents are smart, but every conversation starts from scratch. They don't know what decisions you've made, what knowledge you've accumulated, or what constraints you follow. When the context window closes, everything resets.

**Serenity's answer**: Not a bigger context window — but a **container that continuously accumulates knowledge**.

```
ACC (Abstract Cognitive Container)     ← This plugin (blueprint layer)
  │  ─ Tool system (cc-fs, cc-git, session, msm)
  │  ─ Safety constraints (P1/P2/P3 root principles)
  │  ─ Cognitive quality framework (EAP + Neat)
  │  ─ Full session lifecycle tracking
  │
  ├── CCC my-project-serenity/         ← Instance running on a project
  ├── CCC my-ops-serenity/             ← Instance running on ops
  └── CCC my-experiment-serenity/      ← Instance running on experiments
```

One ACC, any number of CCCs. Each CCC is independent, non-interfering, and accumulates its own domain knowledge.

### Why It Changes the Game

In the traditional workflow, an Agent is a **Coding Agent** — you describe requirements, it generates code, but each conversation's cognitive context is locked to the model's context window.

With Serenity, Agent-human collaboration **elevates to the cognitive level**:

| Dimension | Coding Agent | Serenity |
|-----------|-------------|----------|
| Context source | Model context window (one-shot) | **Persistent knowledge in CCC** (session records, skill docs, design docs, MSM registry) |
| Knowledge persistence | Non-persistent — lost when window closes | **Structured external encoding** — decisions in SESSION.md, domain knowledge in SKILL.md |
| Model capability demand | Relies on model's implicit knowledge | **Reduced** — domain knowledge is explicitly encoded, model only executes |
| Output quality | Limited by context window size | **Significantly improved** — Agent always has full domain context |
| Traceability | None | **Full lifecycle traceability** — every decision recorded with rationale and artifacts |
| Collaboration level | Code level (requirement → code) | **Cognitive level** (goal → decision → structure → output) |

**Core fact**: Using an ACC-constrained CCC reduces context consumption through knowledge accumulation, lowering model capability requirements while dramatically improving output quality and efficiency. The essence: Agent-human collaboration elevates from code level to cognitive level.

---

## Quick Reference: Problems & Solutions

| Problem | How Serenity Solves It |
|---------|------------------------|
| Agent accidentally modifies external files | Hard path isolation (P3) — read/write limited to container root |
| Agent runs dangerous commands | `msm_exec` replaces bare bash (D19) — only **registered** operations execute |
| Weeks later, forgot what the Agent did | `session` auto-records every multi-step work — goals, decisions, artifacts |
| Untraceable "why" behind Agent decisions | EAP framework drives structured recording of every decision |
| Vague user requests, Agent guesses wildly | Phase 2 EAP-driven interview — turns vague ideas into explicit abstractions |

---

## Use Cases

Serenity is not bound to any domain. A container's **shape** depends on what MSMs you register and what SKILL.md you write:

| Scenario | The Container Becomes |
|----------|----------------------|
| Software development (requirements → design → code → test) | Controlled development environment |
| Server, network, NAS, smart home management | Operations hub |
| AI experiments (training, results, comparison) | Reproducible experiment chamber |
| Media processing, documentation, translation | Content workbench |

Serenity's **skeleton** is always the same: boundaries + tool system + session recording + cognitive quality framework.

---

## Quick Start

```bash
# 1. Install the plugin
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install

# 2. Start opencode in any directory

# 3. Enter the slash command:
/serenity-init
```

The TUI asks for a container name (e.g., `my-project`) and a one-line description. It then creates the complete container skeleton — ready to use immediately.

```bash
# Or initialize via CLI
opencode-serenity-plugin init /path/to/my-project \
  --prefix my-project \
  --description "Manages my startup's code, docs, and dev workflow"
```

---

## Demo: Creating a CCC Step by Step

Suppose you want to manage the software development of a SaaS startup.

### Step 1 — Install and Launch

```bash
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
cd ~/projects/saas-app
opencode
```

### Step 2 — Tell Serenity Your Name

Enter `/serenity-init`, and the TUI shows a dialog:

```
┌─────────────────────────────────────────────┐
│ CCC Name                                     │
│                                               │
│ kebab-case — lowercase letters, digits, hyphens
│                                               │
│ █ saas-platform                    [Create]  │
└─────────────────────────────────────────────┘
```

Click Create, and seconds later:

```
CCC "saas-platform-serenity" created at ~/projects/saas-app
  prefix: saas-platform
  description: A concrete cognitive container (CCC)
  Pre-installed 3 skill(s): compass, session, sqc

Next steps (two-phase init):
  Phase 1 ✅  — CCC skeleton created.
  Phase 2 ⏳  — Restart OpenCode and open ~/projects/saas-app.
     Type anything — your first message will be intercepted
     and the Agent will guide you through a collaborative interview
     to complete the root skill configuration.
```

### Step 3 — Restart OpenCode, Enter Phase 2

You type: `hi, set up this workspace for me`

The Agent doesn't answer directly — it enters EAP mode and starts a collaborative interview:

```
Agent:
> Hello! We're entering **Phase 2 initialization**. I'll use the EAP
> framework to turn your goals from vague ideas into explicit structures.
> This makes every future operation more accurate and traceable.
>
> **Topic 1 — What is this CCC for? (purpose + team size)**
>
> What does this container manage? Tell me its purpose in one sentence.

You:
> Managing our SaaS platform development — web frontend, backend API,
> deployment scripts, and product docs.

Agent:
> Got it. Is this `solo` (just you) or `team` (multi-person)?

You:
> team — core team of 3 will all use it.

Agent:
> Good. Recording scope: team.
>
> **Topic 2 — Git remote**
>
> Do you want to set up a Git remote or work locally for now?

You:
> Set one up. git@github.com:myco/saas-platform-serenity.git

Agent calls `cc-git` to set the remote.

You:
> I'm not sure about the other topics yet...

Agent:
> No problem. I'll use sensible defaults for the rest — you can always
> adjust by editing SKILL.md later. I'll save the interview record in
> `docs/phase2-interview-record.md`.

The Agent writes the complete `SKILL.md`, commits, and pushes. The CCC is fully ready.
```

**This is how Serenity works** — not a questionnaire you fill out, but an Agent that helps you **turn vague ideas into explicit structures**. You can say "I'm not sure" at any point — the Agent accepts it and keeps moving forward, rather than getting stuck in a loop.

---

## Philosophy: The ACC/CCC Model

If Serenity were an operating system:

- **ACC** is the kernel — it defines "what a cognitive container should have" (tools, hooks, validation rules). It's shared across containers.
- **CCC** is the user-space workspace — it holds a specific project's skills, MSM registry, session records, and project files. Each CCC is independent.

Upgrade the plugin (`npm update` + `install`), and all CCCs automatically gain new tools and guards. Because ACC is a shared blueprint, and CCCs are independent instances.

The theoretical foundation is **EAP** (Explicit Abstraction Principle): *"The functional value of a thought is proportional to its external reconstructability."* Every design decision in Serenity derives from this statement.

You don't need these terms in daily use. "Serenity" is enough.

---

## What is MSM (Mech & Semi-Mech)

An MSM is an **executable operation unit owned by a skill**. It's not a standalone tool — each MSM is held by one skill:

```
skill (domain knowledge encapsulation)
  ├── SKILL.md (document: existence, trigger conditions, usage)
  ├── references/ (supporting references)
  └── scripts/ (MSM scripts: executable operations)
           │
           └── Example: compass-tool validate/judge
                (belongs to compass skill, validates 3-channel signal reports)
```

Two categories:

| Category | Meaning | Example |
|----------|---------|---------|
| **Mech** | Pure TS script, zero LLM inference | `cc-fs`, `cc-git`, `ssh-connect` |
| **Semi-Mech** | TS framework + LLM decision points | `session-tool qa`, `sqc-tool pipeline` |

Core value: **determinism + auditability**. The LLM uses `msm_exec` to call MSMs — all path arguments are automatically validated for escapes, all operations are automatically traceable.

---

## CCC Lifecycle Best Practices

### The Flywheel: Natural Knowledge Accumulation & Selective Distillation

A CCC isn't created once — it grows through continuous use:

```
Concrete work produces decisions, constraints, domain experience
  → Automatically settles in SESSION.md (zero cost)
  → You decide: which know-how is worth distilling into a Skill?
     (Easiest way: ask the Agent after work:
      "Which know-how is worth turning into a skill?")
  → Once distilled into SKILL.md, the Agent loads it next time
  → Fuller context → higher efficiency → more time for new work
  → Flywheel accelerates
```

**Key design**: Knowledge accumulation is user-driven, not auto-pushed.

- SESSION is the **default sedimentation layer** — every multi-step work's goals, decisions, and artifacts are automatically recorded here, zero operational cost
- Skill is the **selective distillation layer** — only structured knowledge you confirm as valuable gets turned into a skill
- The Agent only suggests, never decides: ask "what's worth distilling from today's work?" anytime — the Agent extracts candidates from SESSIONs, you decide

### Skill Examples: How a Full-Stack Engineer Distills

Suppose you're a React + Java full-stack developer. Your project has been running for a while, and you've had dozens of collaborations with the Agent. Here are skills you might distill:

| Skill | What It Encapsulates | Why You'd Distill It |
|-------|---------------------|---------------------|
| **deployment** | Complete deployment knowledge: CI commands, env vars, rollback steps, common failures and fixes | Asking the Agent the same questions every deployment — put it in a skill, use it next time directly |
| **frontend-patterns** | Your team's React conventions: state management library, API layer organization, error feedback UI standards | Agent generates team-consistent code for new features without corrections |
| **backend-api** | Java backend API design: URL naming, unified response format, exception handling hierarchy, pagination conventions | Agent-generated API code follows team conventions — review pass rate increases dramatically |
| **code-review** | Your team's specific review points: DB migration compatibility, frontend component boundary rules, security checklist | Agent self-reviews before submitting code, catching low-level issues before commit |

Each Skill = a **SKILL.md** (a document for the Agent describing domain knowledge, rules, and scenarios) + optional **MSM** scripts (executable operations). Distillation is simple:

```
Knowledge accumulated in sessions (SESSION.md)
  → You ask the Agent: "What's worth distilling?"
  → Agent extracts candidates from SESSIONs
  → You judge: this is important → write it as SKILL.md
  → Next time, the Agent loads it automatically — like onboarding a new team member
```

### MSM Examples: Turning Routine Operations into Auditable Automation

Skills encapsulate knowledge; MSMs encapsulate operations. For the same full-stack engineer's project, operations that can be MSM-ized:

| Operation | Why MSM-ize | Effect |
|-----------|-------------|--------|
| **Deploy** (`deploy`) | Steps are fixed (build → test → tag → push → rollout), but manual execution is error-prone | Agent completes safe deployment with one command, errors automatically blocked |
| **API test** (`api-test`) | Smoke tests, contract tests, regression tests repeat often | Agent runs them anytime, results returned structurally — a validation layer beyond CI |
| **Commit** (`commit`) | Project has special commit conventions (scope format, co-author, issue links) | Agent commits following conventions — no more "fix bug" messages |
| **Migration check** (`migrate-check`) | Must check backward compatibility before release | Agent analyzes migration scripts, flags breaking changes |

These are all Mech (pure scripts, zero LLM inference) — once registered, the Agent calls them via `msm_exec deploy`, with automatic path escape validation and full traceability.

**Taking it further**: When all your project's routine operations (deploy, test, commit, lint, publish) are MSM-ized, their combination forms a **natural Harness** — an orchestratable, observable, constraint-enforced operations layer. The Agent no longer guesses "how to deploy" — it works inside the Harness, executing only authorized operations.

This is D19 (bash/msm risk grading) in practice: unsafe manual operations are progressively replaced by safe MSMs — not through禁令, but by offering better alternatives.

### Taming Entropy with SQC

Knowledge accumulation naturally brings information entropy — outdated knowledge, duplicates, constraint conflicts. SQC (Serenity Quality Circle) regularly scans all skill quality (broken references, orphan skills, template compliance), auto-fixes automatable issues, and flags items needing human judgment. Recommended cadence: **`sqc-tool pipeline` weekly**.

---

## Two-Phase Initialization (D1)

### Phase 1 — Skeleton Creation

You give a name, Serenity creates:

```
my-project-serenity/
├── .serenity                    ← Container marker: "this is the boundary"
├── .gitignore
├── opencode.json                ← Agent configuration (clean primary agent)
├── AGENT_SESSIONS/              ← Every multi-step work auto-generates SESSION.md
├── docs/                        ← Design documents
└── .opencode/
    ├── skills/
    │   ├── my-project-serenity/     ← Root skill (completed by Agent in Phase 2)
    │   ├── compass/                 ← Direction assessment skill
    │   ├── session/                 ← Session tracking skill
    │   └── sqc/                     ← Quality cycle skill
    └── references/
```

Git auto `init → commit → push` (if you provided a remote URL).

### Phase 2 — Agent-Driven Interview

You type your first message, the Agent starts an EAP collaborative interview covering:

- **Topic 1** — What is this CCC for? (purpose + team size)
- **Topic 2** — Git remote configured?
- **Topic 3** — What concrete work items will this CCC track?
- **Topic 4** — Collaboration style (casual or structured?)
- **Topic 5** — Any external services or domain-specific skills needed?

After the interview, the Agent writes the complete root `SKILL.md`, and the CCC is fully ready.

---

## 9 Built-in Tools

Once installed, the Agent gains these capabilities without writing a single line of code:

### Core Triad

| Tool | Purpose |
|------|---------|
| `msm_list` | Query what executable operations are available in the current container (with descriptions and flag schemas) |
| `msm_exec` | Safely execute registered operations. **Replaces bare bash**. Path escape automatically blocked |
| `msm_admin` | Register/deregister operations, development guide, MSM quality check (`check`). Auto git commit |

The Agent can register custom MSMs directly inside a CCC:

```
msm_admin register --name my-deploy --path .opencode/scripts/my-deploy.ts \
  --description "Deploy to production" \
  --category mech
```

After registration, `my-deploy` enters `mech-registry.json`, and the Agent can call it with `msm_exec my-deploy`.

### Files & Containers

| Tool | Subcommands | Purpose |
|------|-------------|---------|
| `cc-fs` | `root` `resolve` `exists` `list` `tree` `relative` `mkdir` `rm` `mv` `cp` `touch` `append` | 12 file operations, all confined to the container root. Path escape automatically blocked |

### Git (No Bash Dependency)

| Tool | Subcommands | Purpose |
|------|-------------|---------|
| `cc-git` | `status` `commit` `push` `log` | High-frequency Git operations. Non-fast-forward push rejection outputs actionable suggestions. Conflict resolution via bash |

### Sessions & Health

| Tool | Subcommands | Purpose |
|------|-------------|---------|
| `session` | `list` `show` `create` `health` `qa` `archive` `summary` | Full session lifecycle. Auto-assigns S### IDs, snooze detection, fact verification |
| `cc-ck` | (none) | CCC three-principle health check. P1 (.serenity exists), P2 (git-managed), P3 (opencode.json exists) |

### Cognitive Quality

| Tool | Purpose |
|------|---------|
| `eap` | Complete EAP theory framework (progressive disclosure). The Explicit Abstraction Principle — tells you **how to think** so the Agent executes accurately |
| `neat` | Neat design collaboration protocol. A structured methodology — tells you **how to align** so design proposals stay on track |

---

## 4 Safety Hooks (Silent Operation)

These hooks are completely transparent to the user, but work every second:

| Hook | What It Does | Trigger |
|------|-------------|---------|
| Path Isolation (P3) | Read/edit/write/grep all confined to `.serenity` directory | Every file tool invocation |
| Bash Toggle (D19) | `msm_exec` preferred — controlled via `/serenity-bash-off` and `/serenity-bash-on`, `/serenity-bash-status` for status. **Toggle based on usage**: daily dev via MSM, temporarily enable bash when flexibility needed | Every attempt to call bash |
| Subagent Inheritance | Sub-agents automatically inherit all constraints (path, bash, SSH) | Every subagent launch |
| System Prompt Injection | Automatically injects "you are in a CCC" context | Every conversation start |

---

## 3 Pre-installed Skills

Phase 1 auto-installs 3 standard skills (with executable MSM scripts):

| Skill | What It Does | MSM Tools |
|-------|-------------|-----------|
| `compass` | Direction assessment — 3-channel fast evaluation of whether a new task is viable | `compass-tool validate` / `judge` |
| `session` | Session tracking — extends ACC's built-in `session` tool with container-level operations | `session-tool reindex` (assigns S### IDs to historical sessions) |
| `sqc` | Quality cycle — scans all skill quality against DC (design check) rules | `sqc-tool check` / `report` / `pipeline`; MSM quality via `msm_admin check` |

You can register more MSMs and install more skill templates later via `msm_admin`.

---

## Multi-Container Management

One plugin manages all containers:

```
~/projects/
├── saas-app/          ← SaaS development container
├── ops-tools/         ← Operations tools container
└── ai-lab/            ← AI experiment container
```

Each container's Agent sees only files within its own `.serenity` boundary. Non-interfering, each accumulates independently.

---

## Development

```bash
git clone git@github.com:tellmewhattodo/opencode-serenity-plugin.git
cd opencode-serenity-plugin
pnpm install

# Development loop
pnpm typecheck    # TypeScript type checking
pnpm test         # 413+ tests (vitest)
pnpm build        # Compile + copy templates
pnpm install      # Install to local ~/.config/opencode/
```

---

> **Version**: v0.4.5 &nbsp;|&nbsp; **License**: MIT &nbsp;|&nbsp; **Prerequisites**: Node ≥ 20, OpenCode ≥ 1.16
>
> **Platform**: Serenity is tested on OpenCode CLI (terminal), Linux desktop, and macOS. **Windows is untested and not guaranteed.**
