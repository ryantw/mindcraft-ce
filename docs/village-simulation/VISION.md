# Village simulation vision

Spec-Version: 0.6.0
Status: Accepted design. Milestones 1 through 4 are implemented. Later milestones are not.
Date: 2026-11-15

Revised from 0.5.0. The product intent is unchanged. Milestones 1 through 4 are implemented, including private minds, verified death, and sleep-triggered dreams. The observer dashboard and sleep deprivation remain later. The live checks did not use Village Alpha.

This document is the product intent for an autonomous Minecraft social simulation built on Mindcraft CE. It does not authorize implementation by itself. Architecture, milestones, and file schemas are in the sibling documents.

Status labels used throughout `docs/village-simulation/`:

| Label | Meaning |
| --- | --- |
| Implemented | Present in this repository today. |
| Agreed | A principle or decision accepted for this simulation. Whether code exists yet is the milestone status in ROADMAP.md. |
| Proposed | A structure that follows from the agreed principles and should guide implementation. |
| Future | Explicitly deferred. Not part of the first experiment. |
| Open | Requires investigation before an implementation choice is locked. |

## What we are building

Agreed. Independent inhabitants live in an established Minecraft village. Their basic necessities are met at the start: a home, a bed, food, storage, and ordinary tools. They have private backstories, temperaments, memories, relationships, preferences, and ambitions they choose for themselves.

The experiment is to watch lives, not to score a settlement. Success is that personalities and relationships change because of things that actually happened: a conversation, a gift, a refusal, a moved chest, an absence, a discovered death. The observer can read the private record. The inhabitants cannot read each other, and they cannot read the observer's view.

The tone is a life-simulation in the spirit of The Sims: ordinary motives, private points of view, and consequences that stick. It is not a task benchmark, a scripted roleplay, or a survival speedrun.

## First population

Agreed. The first experiment is five new inhabitants. The architecture must admit any later number by adding scenario and profile data. Adding a person must not require a change to application code.

These five are not the existing survival-experiment agents (Finn, Sawyer, Milo, Jasper, Rowan). That run, its `settings.js` startup message, and its `bots/<name>/` files stay intact. The village is a separate scenario.

## What an inhabitant is

Agreed.

- A configuration record (stable id, backstory, initial temperament, optional seeded relationships) plus a private runtime record. Admission copies identity into an immutable snapshot. Later edits to the versioned profile do not rewrite that life.
- A possible home, assigned only by the village plot list. Houses also exist vacant. A house and its contents stay in the world when the occupant dies or leaves. Nothing automatically refills, transfers, or regenerates them.
- The same gameplay body and the same cognitive machinery as every other inhabitant. Personality is data the machinery reads. It is not a subclass, a profession module, or a special prompt buried in code.
- A point of view. What they know is what they saw, did, remember, or were told. Another inhabitant's memory is not theirs, even when both describe the same hour.

## What we are not building

Agreed non-goals for this simulation:

- A mandatory settlement, a shared profession ladder, or one lifelong ambition assigned at birth.
- Administrative commands, server operators, creative mode, or model-written code execution. `allow_insecure_coding` stays off. `!newAction` stays unavailable. `operatorOnly` commands stay human-only.
- Omniscient agents. The observer dashboard is not a sense the inhabitants possess.
- Automatic death announcements, respawn-as-the-same-life, or treating a crash, disconnect, or operator stop as a death.
- Automatic inheritance, eviction, or restocking of a house.
- A replacement for the current survival experiment, MineCollab tasks, or the general Mindcraft command set.
- Infinite resources. The village starts provisioned. Stores can run down, be moved, or be withheld.

## Principles

Agreed. Implementations that contradict these are out of spec even if they satisfy a milestone checklist.

1. Inhabitants are data. No hardcoded personality, job, or story in application code.
2. One baseline. Every inhabitant gets the same commands, modes, planning, outcome checks, and reflection machinery. Profiles select models and identity; they do not fork the rules.
3. Identity is stable. Admission freezes the backstory, initial temperament, and stable id. Sleep, reflection, summarization, and later profile edits may add experience. They may not rewrite who the person was at admission.
4. Experience is individual. Relationships are private and asymmetric. A can remember a slight that B never logged.
5. Knowledge is local. Hearing, seeing, opening a chest, and being told are the channels. Simulation-wide state is for the observer.
6. Death is an irreversible end of that life. The record remains. Other inhabitants learn about it only by seeing evidence, seeing the body or the dropped belongings, or being told by someone who knows. The house is not cleared because they died.
7. Absence is not death. A process crash, network disconnect, operator stop, or night spent elsewhere is not a death event and must not be narrated as one.
8. The village is a place, not a quest. No required build objective, profession, or settlement quota. A long-term personal ambition is part of ordinary life: the inhabitant may pursue it, revise it, or set it aside. The engine does not assign the day's exploration, gathering, construction, or social activity. At night, returning home and attempting to sleep is a shared survival behavior, not a personality preference. Immediate danger still comes first.
9. Facts and stories stay apart. Inventory, recipes, verified action results, and life-or-death state are code-owned. Journals and relationship interpretations are subjective and may be wrong.
10. Sleep can impair recall later. It must never delete or corrupt identity or the factual record.
11. The survival experiment remains runnable on its current settings and profiles.

## A day in the life

Agreed shape, proposed timing. This is the experience the architecture is for. It is not a script the agents must follow.

During the day the small local model acts, talks, and notices. It sees a compact working set: locked backstory, current stance, this morning's intention, live game state, and a few relevant memories. It does not reread its whole life on every action.

Successful sleep is what queues a dream. The larger local model then reflects in the first person on that inhabitant's own long-term bank and the day's episodes. It writes a private journal, updates how they feel about people, and proposes a small intention for tomorrow. The model call does not have to finish while they are still in bed. Code files the result when the call returns, including if they are already awake. Code rejects anything that rewrites the admission snapshot, invents a recipe, or claims a death nobody witnessed. No sleep means no dream.

The next morning the planner, which already exists, may turn that intention into a short practical plan. The plan still has to be possible with the commands and materials that exist. A dream that asks for a cathedral does not become the new meaning of their life.

## Models

Agreed defaults, both configurable per scenario:

| Role | Default | Used for |
| --- | --- | --- |
| Day | Local Ollama `qwen3:8b` | Conversation, action choice, ordinary experience. |
| Dream | Local Ollama `qwen3:14b` | Sleep-time consolidation, journal, relationship interpretation, next intentions. |

The daytime model is the body. The dreaming model is not a second inhabitant and does not act in the world. If the dream model is unavailable, the inhabitant still wakes; they simply do not get a new journal or a new intention that night.

## How we will know the experiment is working

Agreed observational signs, not a score:

- Two inhabitants give different accounts of the same day, and both accounts are grounded in what each one actually perceived.
- When a scenario does seed a disagreement, it is still visible days later, or it has changed because of a specific later event. Starting as strangers, acquaintances, or friends is equally valid.
- An intention is small enough that the day model sometimes completes it, and the journal mentions the outcome rather than a new grand plan.
- A death, when it happens, removes that person from play, keeps their files, and leaves the others unknowing until someone has a reason to know.
- A sixth person can be added with a profile and a scenario entry alone.

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — what exists, what is reused, what is proposed.
- [ROADMAP.md](ROADMAP.md) — milestones, definition of done, acceptance criteria.
- [SCENARIO_SCHEMA.md](SCENARIO_SCHEMA.md) — versioned data versus runtime state.
