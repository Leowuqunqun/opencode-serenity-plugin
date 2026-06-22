# Serenity

> **Not a sandbox — a cognitive container.**

中文 | [English](./README.en.md)

---

> ⚠️ **Safety Notice**
>
> This plugin fully activates only inside directories that contain a `.serenity` marker file. When you start OpenCode in a normal project directory, the plugin has **zero effect on OpenCode's native behavior**:
>
> - No system prompt injection
> - No path isolation guards
> - No bash control
> - No tools activated
>
> Feel free to install it globally. Serenity only awakens when you **intentionally enter a CCC directory**.

---

## The Problem

You use AI coding agents. Each conversation goes great — but the next one starts from scratch. Nothing is remembered. You repeat yourself:

- "This project uses React + Vite..."
- "Our naming convention is camelCase..."
- "Deployment steps: build, then scp to the server..."

Decisions lost. Conventions forgotten. Every time, back to zero.

**Because you don't have a system for persistent Agent memory.**

---

## Quick Start

You need two things: Node ≥ 20 and OpenCode ≥ 1.16.

```bash
npm install @shgroup/opencode-serenity-plugin
npx opencode-serenity-plugin install
```

Then open OpenCode, navigate to the directory you want to work in long-term, and type:

```
/serenity-init
```

A TUI will ask for a container name and description. Answer a few questions, done.

Or use CLI:

```bash
opencode-serenity-plugin init /path/to/my-project \
  --prefix my-project \
  --description "Manages my SaaS project code, docs, and dev workflow"
```

**From install to done: under a minute.**

---

## What Just Happened

You just told OpenCode: "This directory is my workspace. Remember it."

The plugin created a `.serenity` marker file in this directory, along with a supporting structure:

```
my-project-serenity/
├── .serenity              ← Marker: this directory is a CCC boundary
├── opencode.json          ← OpenCode Agent config
├── AGENT_SESSIONS/        ← Work sessions auto-stored here
├── docs/                  ← Design documents go here
└── .opencode/
    ├── skills/            ← Domain knowledge (3 pre-installed skills)
    └── references/
```

This directory with the `.serenity` marker is called a **CCC** (Concrete Cognitive Container).

In plain English: **a bounded workspace with memory.**

- The Agent can only read and write files inside this directory
- Every conversation's decisions, conventions, and constraints are automatically recorded
- You can distill domain knowledge into Skills — the Agent loads them automatically on next startup

Restart OpenCode, type any message. The Agent enters a short interview (Phase 2) to understand your project purpose, Git remote, and work items. After the interview, the CCC is fully ready.

---

## Where Do These Tools Come From

`/serenity-init` works because you installed a plugin.

That plugin is the **ACC** (Abstract Cognitive Container).

| Term | One-liner |
|------|-----------|
| **ACC** | The npm package you installed. It defines "what tools and rules a cognitive container should have." One global instance. |
| **CCC** | The directory you created with `.serenity`. It's an ACC runtime instance. You can have many. |

Think of it this way:

- **ACC** is the phone's operating system — defines "a phone can make calls and install apps"
- **CCC** is your phone — the specific apps, wallpaper, contacts

Upgrade the plugin (`npm update`), all CCCs automatically gain new tools and features. Because ACC is the shared blueprint, CCCs are independent instances.

---

## Your Tools

After installation, you get **9 tools**. Every time you start OpenCode inside a CCC directory, the Agent can use them immediately — no code to write.

### msm_list — Discover available operations

What MSMs are registered in the current CCC? What are their parameters? `msm_list` outputs the full list with descriptions and flag schemas.

### msm_exec — Execute operations safely

Replaces bare bash. Registered MSMs execute through this tool with automatic path-escape blocking and call logging. **Preferred over raw bash.**

### msm_admin — Register and manage operations

| Subcommand | What it does |
|------------|--------------|
| `register` | Register a new MSM (name + path + description + category) |
| `deregister` | Remove an MSM |
| `guide` | View the MSM development handbook |
| `check` | Run quality checks on MSMs (DC-M1~M4) |

Registration changes are auto git-committed.

### cc-fs — Safe file operations

12 file operations confined to the CCC root: `root`, `resolve`, `exists`, `list`, `tree`, `relative`, `mkdir`, `rm`, `mv`, `cp`, `touch`, `append`. Path escape is auto-blocked.

### cc-git — High-frequency Git operations

5 subcommands: `status`, `commit`, `push`, `log`, `pull`. Rejected pushes output actionable suggestions. Conflict resolution goes through bash.

### session — Full session lifecycle

9 subcommands:

| Subcommand | What it does |
|------------|--------------|
| `list` | List all sessions with status summaries |
| `show` | View session details |
| `create` | Create a new session (auto-generates SESSION.md) |
| `use` | Activate a session as current context |
| `close` | Close a session |
| `health` | Check for stale/stalled/drift/ghost sessions |
| `qa` | Fact-check — verifies SESSION.md claims against reality |
| `archive` | Archive completed old sessions |
| `summary` | Dashboard: counts + recent activity + warnings |

Before each multi-step work task, the Agent auto-creates a session. Decisions are recorded automatically — no reliance on your memory.

### cc-ck — CCC health check

No parameters. Validates three principles: P1 (does `.serenity` exist?), P2 (Git-managed?), P3 (opencode.json present?). Returns a pass/fail report.

### eap — Cognitive quality framework

No parameters. Progressive disclosure of EAP theory — defines cognitive quality metrics (E↑ / R↓ / S↑), guides the Agent's thinking structure and output quality.

### neat — Design collaboration protocol

No parameters. Small-step alignment, explicit decisions, document-driven collaboration methodology.

---

## How Knowledge Grows

The key insight: **You don't manage knowledge manually. It grows naturally as you work.**

```
You work → produces decisions, constraints, domain experience
  → automatically settles in SESSION.md (zero cost)
  → you decide what's worth distilling into a Skill
  → once in SKILL.md, Agent loads it every startup
  → fuller context → higher efficiency → more time for new work
  → flywheel accelerates
```

Three knowledge layers:

| Layer | Name | Who Writes | Who Reads | Accumulation Cost |
|-------|------|-----------|-----------|-------------------|
| **L1 — Session** | Default sedimentation | Agent (automatic) | You + Agent (retrospect) | Zero |
| **L2 — Skill** | Selective distillation | Agent (on your request) | Agent (loaded every startup) | Your judgment |
| **L3 — MSM** | Operation encapsulation | You register | Agent (via msm_exec) | Your registration |

After finishing work, ask the Agent: "What's worth distilling into a skill?" — that's it.

---

## Safety

These safety mechanisms activate automatically. You don't need to think about them.

**Path Isolation (P3):** Every Agent file read/write is confined to the CCC root. It cannot touch system files outside.

**Bash Control (D19):** `msm_exec` is preferred over raw bash (with path-escape checking). Toggle with `/serenity-bash-off` and `/serenity-bash-on`.

**Subagent Inheritance:** Any subagent spawned by the Agent inherits all constraints. No bypass possible.

---

## Quality

Over time, accumulated knowledge naturally suffers entropy — outdated info, duplicates, conflicting constraints.

**SQC (Quality Cycle)** regularly scans all Skills:

- Auto-fixes machine-fixable issues (broken references)
- Flags items needing human judgment (conflicts, orphan skills)
- Recommended cadence: `sqc-tool pipeline` weekly

---

## Why "Serenity"

There's a ship in the movie *Serenity*. Not big, not new, but reliable. It flies through the universe — it can't know every planet, but it has its own cabins and its own course. The crew doesn't know what's in every cargo hold, but when they need something, they can always get it.

That's how CCC works: not omniscience, but accessibility.

---

## Philosophy

The theoretical foundation is **EAP** (Explicit Abstraction Principle):

> **"The functional value of a thought is proportional to its external reconstructability."**

Every design decision in Serenity derives from this statement. Every concept you've read here — ACC, CCC, Skill, MSM, Session — is this principle concretized at a different level.

Think of Serenity as an operating system:

- **ACC is the kernel** — declares what tools, rules, and validations a cognitive container should have
- **CCC is the user-space workspace** — holds a specific project's skills, MSMs, session records, and files

Upgrade the kernel, all user-space workspaces benefit automatically.

Full EAP theory: <https://github.com/tellmewhattodo/theory-eap>

---

## Multiple Containers

One plugin manages all containers. Each CCC lives in its own directory:

```
~/projects/
├── saas-app/          ← CCC: SaaS development
├── ops-tools/         ← CCC: Operations tools
└── ai-lab/            ← CCC: AI experiments
```

Within a single OpenCode session, the Agent only accesses files in the CCC of the current working directory.

---

## Development

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

> **Version**: v0.4.13 &nbsp;|&nbsp; **License**: MIT &nbsp;|&nbsp; **Prerequisites**: Node ≥ 20, OpenCode ≥ 1.16
>
> **Platform**: Serenity is tested on OpenCode CLI (terminal), Linux desktop, and macOS. **Windows is untested and not guaranteed.**
>
> **Full EAP theory**: <https://github.com/tellmewhattodo/theory-eap>
