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
opencode plugin @shgroup/opencode-serenity-plugin
```

> This auto-installs the npm package and writes the opencode config. Alternatively:
> ```
> npm install @shgroup/opencode-serenity-plugin
> npx opencode-serenity-plugin install
> ```

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

You get **9 tools** after installation, organized by design purpose into four groups.

### Safe execution channel

Raw bash is unlogged, unaudited, and prone to path escape. The MSM (Mech & Semi-Mech) framework turns common operations into registered, safe executable units.

- **`msm_list`** — Discover registered MSMs in the current CCC and their parameters.
- **`msm_exec`** — Execute MSMs safely. Path escape is auto-blocked. **Preferred over bash.**
- **`msm_admin`** — Register/deregister MSMs. `register` auto git-commits. `guide` shows the dev handbook. `check` runs quality checks.

### Everyday operations within bounds

A CCC has a clear filesystem boundary. Every file and git operation stays inside it.

- **`cc-fs`** — 15 file operations (`root` / `resolve` / `exists` / `list` / `tree` / `relative` / `mkdir` / `rm` / `mv` / `cp` / `touch` / `append` / `reveal` / `info` / `find`), all with auto path-escape blocking.
- **`cc-git`** — High-frequency git operations: `status` / `commit` / `push` / `log` / `pull`. Non-fast-forward pushes output suggestions; conflict resolution goes through bash.
- **`cc-ck`** — No parameters. Three-principle health check: .serenity present? Git-managed? Config complete?

### Cross-conversation working memory

Every new conversation starts from zero. The session system captures decisions, progress, and open questions as traceable records.

- **`session`** — `create` / `use` / `close` / `list` / `show` / `summary` / `archive` / `health` / `qa`. The Agent auto-creates sessions, auto-records decisions, and recovers context after compression or restart.

### Thinking quality frameworks

These two tools don't manipulate files — they improve the quality of Agent thinking itself.

- **`eap`** — Cognitive quality framework. Defines E↑ / R↓ / S↑ standards that guide every output's external reconstructability.
- **`neat`** — Design collaboration protocol. Small-step alignment, explicit decisions, document-driven — every step of a complex design is traceable.

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

## Why Serenity Works

Serenity's engineering foundation rests on two complementary theoretical disciplines:

### EAP (Explicit Abstraction Principle)

> **"The functional value of a thought is proportional to its external reconstructability."**

EAP defines cognitive artifact quality: explicitness (E↑), reconstruction cost (R↓), stability (S↑) of every output. Every concept you've read here — ACC, CCC, Skill, MSM, Session — is EAP concretized at a different level.

Full EAP theory: <https://github.com/tellmewhattodo/theory-eap>

### CCE (Cognitive Continuity Engineering)

> **"Cognitive Continuity Engineering is the engineering discipline of maintaining identity, accessibility, and evolution of a cognitive entity through time under bounded resources and irreversible uncertainty."**

EAP answers "how should a piece of knowledge be structured"; CCE answers "how should structured knowledge evolve over time without losing coherence." Serenity's session system, session tracking, and entropy management (SQC) are all CCE engineering implementations.

CCE core claims:

- **Continuity belongs to the container, not to any participant** — agents come and go, but the CCC's cognitive trajectory persists
- **Organization must at least keep pace with accumulation** — otherwise operational cognitive entropy (H_op) grows unbounded and accessibility is lost
- **Reconstruction over preservation** — an artifact's value is determined by its ability to enable future agents to reconstruct the original reasoning

Full CCE theory (Chinese): <https://github.com/tellmewhattodo/cognitive-continuity-engineering/blob/main/README.zh.md>

Think of Serenity as an operating system:

- **ACC is the kernel** — declares what tools, rules, and validations a cognitive container should have
- **CCC is the user-space workspace** — holds a specific project's skills, MSMs, session records, and files
- **EAP + CCE are the architectural principles** — guiding cognitive system structure and evolution

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

> **Version**: v0.5.41 &nbsp;|&nbsp; **License**: MIT &nbsp;|&nbsp; **Prerequisites**: Node ≥ 20, OpenCode ≥ 1.16
>
> **Platform**: Serenity is tested on OpenCode CLI (terminal), Linux desktop, and macOS. **Windows is untested and not guaranteed.**
>
> **Full EAP theory**: <https://github.com/tellmewhattodo/theory-eap>
