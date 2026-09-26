---
name: pi-jev-control
description: >-
  When to use the pi-jev-control tools (jev_rank, jev_decide_batch, jev_search_code,
  jev_select_skills, jev_route_agent, jev_memory_search, jev_memory_add, jev_review_check,
  jev_choose_ui_action, jev_decide_batch, jev_assess_task, jev_assess_risk,
  jev_diagnose_failure, jev_request_model_tier, jev_prune_context). Use at the start of a
  session in a repo where pi-jev-control is installed, or whenever a candidate list grows
  past ~20 items, a task looks harder than the current model, an operation looks risky,
  the same failure repeats, or a long session has accumulated stale tool output.
---

# pi-jev-control: when to call which Jev tool

pi-jev-control installs a set of `jev_*` tools. In the current architecture **Jev never
decides for you** — it never switches your model, never prunes your context, never blocks
your tools, and never writes to memory on its own. Every one of these tools returns
information and you do whatever you like with it, including ignoring it.

So the only question is when calling one is worth a round trip.

## The short list

| Situation | Call |
| --- | --- |
| More than ~20 candidates to look through | `jev_rank` |
| Several small, well-bounded yes/no choices | `jev_decide_batch` |
| You want to know where relevant code lives | `jev_search_code` |
| You want to pick between existing skills | `jev_select_skills` |
| You need a prior decision, preference, or failure | `jev_memory_search` |
| The user states a durable preference or rule | `jev_memory_add` |
| An operation feels risky but you are not sure | `jev_assess_risk` |
| The same command has failed twice | `jev_diagnose_failure` |
| The task has grown past the current model | `jev_request_model_tier` |
| You want a complexity opinion before starting | `jev_assess_task` |
| A long session has stale tool output | `jev_prune_context` |

## Candidate lists larger than ~20: rank first

Do not open 40 files to find the 3 that matter. Build the candidate list cheaply (you
already know paths from `ls`, `find`, or a prior step), then:

```
jev_rank(query="how is the enemy AI cooldown implemented",
         candidates=[{id:"src/enemy/ai.ts", text:"enemy ai: cooldown, state machine"}, ...])
```

Only read the shortlist. Scores are advisory — `unavailable` status means the judgment
backend was down and you are looking at lexical order, which is still a ranking.

The same shape works for skills (`jev_select_skills`) and memory (`jev_memory_search`),
which are domain wrappers over this primitive.

## Several small decisions: ask once, not eight times

If you have four or more independent bounded choices — "is each of these files relevant?",
"which of these names fits?" — batch them into one `jev_decide_batch` call instead of
eight separate calls. Cap it at ~8 questions.

## Before a risky operation: ask for a second opinion

`jev_assess_risk` returns two things:

1. A **deterministic** part, computed locally and always present: whether the command
   matches a known dangerous shell pattern, and what risk features it has. This does not
   depend on any model being reachable, so trust it over the judgment part.
2. A **judgment** part: a risk level and a gate verdict, `undefined` when Jev is down.

Put a concise summary in `operation` and the actual command or specifics in `details`.
Both fields are checked independently (up to 2,000 characters each), and the more
conservative shell risk wins. A non-match is not proof of safety: these are bounded
pattern checks, not a complete shell parser.

A `high` risk rating means "check with the user first", not "abort". Your call.

## When the same failure happens twice: diagnose, do not retry

Retrying an unchanged failing command is almost never the fix. Call:

```
jev_diagnose_failure("bash", "Command failed with exit code 1", "npm test", 3)
```

The last argument is how many times this same failure has already occurred. At ≥ 1 it
answers from a local rule — `do_not_retry` — without asking any model, because the count
is already a fact. Only a first-time failure reaches the judgment backend.

## When the task has grown past your current model

Nothing switches your model automatically anymore. If you are mid-task and the current
model is no longer a good fit, ask:

```
jev_request_model_tier(tier="strong", reason="now touching GAS replication and a crash root cause",
                       context="...anything else to scan for risk features...")
```

Risk features can only **raise** your request, never lower it. Asking for `cheap` on a
task that mentions replication becomes `strong`. If the switch fails you get a `reason`.

`jev_assess_task` is the lighter version: it returns a tier plus confidence and changes
nothing. Use it to decide whether `jev_request_model_tier` is worth it.

## Long sessions: prune when you, not the hook, say so

Pruning deletes information from your own view, so it only happens on request. When a
session has accumulated obsolete `grep` output, compiler logs, or search dumps:

```
jev_prune_context(reason="the first 40 read results are stale, the fix is in a different module")
```

The plan is generated and applied on the next context event. You cannot see the messages
being pruned, so you are asking, not doing.

## Memory: write only when it will outlive this session

Call `jev_memory_add` when:

- the user states a durable preference — "remember this", "always use tabs", "never touch X";
- an important architecture or design decision is made that a future session should not
  have to re-derive;
- you just fixed a non-obvious failure, so the mistake is not repeated.

Types are `fact`, `decision`, `failure`, `constraint`. Nothing writes memory on its own,
so a call that is worth making is worth making.

`jev_memory_search` is a plain read and is always safe to call.

## When not to call Jev at all

- **The safety floor.** Deterministic rules decide whether a dangerous command is blocked.
  A model's opinion is not part of that path and you should not ask for one to soften it.
- **Complex reasoning and architecture judgment.** Jev is a fast classification backend.
  It is not better than you at deciding which of two designs is right.
- **When the answer is already in your context.** One extra round trip is only worth it
  when the result changes what you do next.
- **When the result is not actionable.** If you would do the same thing regardless of the
  answer, skip the call.

Every tool returns `status: "ok" | "unavailable" | "disabled" | "skipped"`. On
`unavailable` the judgment part is missing — usually the deterministic part is still
there and is what you should act on.
