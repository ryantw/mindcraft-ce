# Village simulation architecture

Spec-Version: 0.6.0
Status: Accepted design. Milestones 1, 2, and 3 are implemented. Later milestones are not.
Date: 2026-11-15

Revised from 0.1.0. See [VISION.md](VISION.md) for the product changes. This document now separates lifecycle from activity, makes plots the only home assignment, and treats dreaming as a durable queue rather than a life state.

Read [VISION.md](VISION.md) for intent and [SCENARIO_SCHEMA.md](SCENARIO_SCHEMA.md) for files. This document says what Mindcraft already does, what the simulation reuses, and what is still only a proposal.

## Reuse, do not fork

Agreed. The village simulation is a scenario and a set of private stores on top of the current agent. It is not a second bot runtime, a second command language, or a second planning engine.

One inhabitant is still a Mindcraft agent process: `main.js` loads a profile, `createAgent` in `src/mindcraft/mindcraft.js` spawns `AgentProcess`, and `src/process/init_agent.js` constructs `Agent`. The village adds a scenario identity, a lifecycle, and memory files that the existing prompter and planner can read. Gameplay stays in the modules below.

### Implemented baseline to keep

| Concern | Where it lives today | What it already guarantees |
| --- | --- | --- |
| Process per agent | `src/process/agent_process.js`, `src/mindcraft/mindcraft.js` | Each profile is its own Node process. A crash restarts that process and reloads memory. The restart notice is not a goal (`src/agent/startup_goal.js`). |
| Profile merge | `src/models/prompter.js` | `_default.json`, then `profiles/defaults/<base_profile>.json`, then the agent profile. Identity and model are data. |
| Population launch | `main.js`, `settings.profiles` | Any list of profile paths. A new file on that list is a new agent without an `agent.js` edit. There is no scenario boundary yet: every run shares one settings object, one Minecraft host and port, and `bots/<name>/`. |
| Commands | `src/agent/commands/` | Shared action and query lists. `operatorOnly` commands (`!stfu`, `!restart`, `!clearChat`) are stripped from the model-facing docs. `!newAction` refuses to run while `allow_insecure_coding` is false. |
| Self-prompt and goal | `src/agent/self_prompter.js`, `src/agent/startup_goal.js`, `!goal` | The autonomous loop starts only when `start` is given a non-empty prompt. `Agent.start` supplies the saved self-prompt, else the process init message, else `settings.init_message`. An empty prompt is ignored and the loop does not run. The survival `init_message` is that fallback today. A village scenario must not replace it. |
| Persistent plans | `src/agent/plan_manager.js` and `plan_feasibility.js`, `plan_geometry.js`, `plan_resources.js` | The model proposes a short JSON plan. Code accepts only real commands and real parameters, checks construction limits, and tracks materials against live inventory. Evidence types are `verified_action`, `inventory_min`, `inventory_delta`, `block_at`, `block_nearby`, and `position_near`. Stored at `bots/<name>/plan.json`. |
| Structured outcomes | `src/agent/action_outcome.js`, `src/agent/action_manager.js` | Success and failure come from inventory and world diffs, not from the model's claim. Repeat attempts of the same behavior are blocked. Recent placements are remembered in process so the agent does not immediately dig up its own floor. |
| Construction | `src/agent/library/construction.js`, `src/agent/construction_area.js` | `placeHere`, `placeBlockAt`, `buildLine`, `buildPlane` place blocks from inventory only. No commands, no teleports, no generated blocks. Size, distance, and time are capped. Failed terrain in an area blocks further guesses there until the agent leaves. |
| Inventory and recipes | `src/agent/commands/queries.js`, `src/agent/mechanics.js`, `src/utils/crafting.js` | `!inventory` reports real counts, equipment durability, free slots, and at most four code-computed "can craft" lines. Recipes come from `minecraft-data`. |
| Reflection | `src/agent/reasoning.js`, `src/agent/reflection_triggers.js`, `src/agent/lessons.js` | `!think` and automatic reflection are private, serialized (`max_concurrent: 1`), and told not to invent recipes or assign a life goal. Lessons persist only when code derived them (`mechanics` or `observed`). The model cannot write a lesson. Caps today: 12 lessons and 8 accomplishments, in `bots/<name>/verified_lessons.json`. |
| Conversation hygiene | `src/agent/chat_hygiene.js`, `src/agent/conversation.js`, `src/agent/system_events.js` | Action results are stripped from outgoing chat. Peer speech is labeled and is not stored as the listener's own deed. System text is marked as observation so words like "stopped" are not taken as `!stop`. |
| Modes and body | `src/agent/modes.js`, auto-eat in `src/agent/agent.js` | Survival modes (self-preservation, unstuck, self-defense, hunting, item collecting, and others) and auto-eat already keep a body alive without a plan. |
| Bed | `goToBed` in `src/agent/library/skills.js` | Finds a bed within 32 blocks, sleeps, and waits until `bot.isSleeping` is clear. No reflection runs in that wait. Time-of-day events (`sunrise`, `noon`, `sunset`, `midnight`) are emitted in `agent.js` and have no listeners. |
| Places | `src/agent/memory_bank.js` | In-process named coordinates, including `last_death_position`. Not written by `history.save`. Lost on process exit unless the chat summary happens to mention them. |
| Short summary | `src/agent/history.js` | `bots/<name>/memory.json` holds a single summary string, sliced at 500 characters, plus the live turn window (`settings.max_messages`, currently 15). Older turns are appended under `bots/<name>/histories/`. The summary prompt tells the model to drop inventory, positions, commands, and routine outcomes. |
| Observer shell | `src/mindcraft/mindserver.js` | Start, stop, restart, settings, chat, and bot output for the operator. It is not a journal or relationship viewer. |
| Death today | `agent.js` death and `messagestr` handlers | Survival agents still respawn and are told to continue. A village scenario with `permanent_death: true` writes `dead` and exits the process instead. Other inhabitants are not given that record. |

### What the village must not duplicate

Proposed. New village code should call these, not reimplement them:

- Command execution, pathfinding, collecting, crafting, smelting, and construction.
- Plan validation, material ledger, and structured outcomes.
- Lesson records for verified crafts and placements.
- Chat attribution and the private reflection step.
- Profile loading and one-process-per-inhabitant.

The 500-character summary remains the survival experiment's memory. A village session does not regenerate it and does not place that string in the decision, planning, reflection, or conversation prompt. The existing string stays in `memory.json`. Recent turns stay in the conversation window. The morning brief, intention, and episodes are the village continuity. Do not "fix" survival memory by making the village bank the global `History.memory` for every profile.

## Two layers of data

Agreed. Details and fields are in [SCENARIO_SCHEMA.md](SCENARIO_SCHEMA.md).

**Versioned scenario data** is reviewed and committed. It describes one experiment: scenario id, Minecraft connection, model choices, village layout, and each inhabitant's admission profile (stable id, backstory, initial temperament, optional seed relationships). Editing a profile after someone has been admitted does not edit that life. The admission snapshot does.

**Persistent runtime state** is produced by play. It is private per inhabitant per scenario: the identity snapshot, episodes, long-term bank, relationships after experience, journal, morning brief, intentions, craft ledger, life state, plus the existing Mindcraft files (`memory.json`, `plan.json`, `verified_lessons.json`, `histories/`). A scenario-level dream queue sits beside those directories. This tree is not a source of personality in git. Agents and coding sessions do not reset it to tidy a branch.

A restart loads an existing life. It does not run admission again. It must not copy the profile's backstory, temperament, seed relationships, or starting supplies over files or chests that already exist.

### What a scenario isolates

Agreed. One scenario is one population, one Minecraft connection, one runtime tree, and one process supervisor. The survival experiment is the run that does not pass a scenario: `node main.js` with `settings.js`.

| Boundary | Survival experiment | Village scenario |
| --- | --- | --- |
| Minecraft connection | `settings.js` `host`, `port`, `minecraft_version`, `auth`. `initBot` in `src/utils/mcdata.js` reads those fields. | `scenario.connection` with the same fields. The scenario runner passes them into that run's agent settings. It does not write `settings.js`. |
| Runtime files | `bots/<name>/` | `runtime/scenarios/<scenario_id>/<inhabitant_id>/` |
| Dream queue | None | `runtime/scenarios/<scenario_id>/dream_queue.json`, used in milestone 4 |
| Who is started | `settings.profiles` | The scenario's inhabitant list |
| Process supervisor | `AgentProcess` restarts on exit. MindServer `start-agent` and `restart-agent` start whatever was registered. | The same mechanisms, but only after a death gate. A dead life is not started from the exit handler, from MindServer start or restart, or from the scenario's initial launch loop. |

`mindserver_port` stays with the supervisor process. It is the observer and control channel, not the world. Two scenarios must not share a runtime directory. They may share a MindServer only if each connection and each runtime root stay distinct. Milestone 1 does not require two scenarios running at once. It does require that launching one scenario leaves the survival host, port, and `bots/` tree unchanged.

Name collision rule: an inhabitant id or Minecraft name used by the survival run is rejected. The first village cohort uses new names.

## Homes

Agreed. Houses and people are different records.

- A plot in `village.json` is a house. `occupant` is either an inhabitant id or `null`. `null` is a vacant house.
- That field is the only home assignment. Inhabitant profiles do not contain a home id.
- Admitting someone into a vacant house is setting `occupant` on that plot. No application code change.
- A plot whose occupant already has a life, including a dead life, is not vacant. Reassignment and inheritance are deferred. The loader must not clear `occupant` on death, absence, or removal from the active list.
- The house and whatever is in its containers stay. No automatic delete, refill, transfer, or regeneration.
- An inhabitant may be admitted with no plot. They then have no assigned home until a vacant plot names them, and only if no snapshot has already recorded a different assignment.

The admission snapshot copies the plot id it found at admission, or `null`. If a later `village.json` names a different occupant for that life, the loader reports a mismatch and keeps the snapshot. It does not move the life or restock the house.

## Lifecycle

Agreed. Lifecycle is durable. Activity is temporary. Dreaming is not a lifecycle state.

Exit of a living process still triggers an automatic restart (`AgentProcess` in `src/process/agent_process.js`) unless the exit code is 0 or the signal is SIGINT. MindServer `start-agent` and `restart-agent` call that same start path. Every one of those entry points refuses a dead life. A village death writes `dead` and then exits 0, so the automatic restart does not run. A crash or disconnect of a living inhabitant is still `absent` and can return.

| Lifecycle | Meaning | How it changes |
| --- | --- | --- |
| `admitted` | Snapshot exists. Process has not taken the life into the world. | Created once, when the runtime directory is first made. |
| `alive` | This life may be in the world and may act, sleep, or be mid-dream-job. | Start of a non-dead life. |
| `absent` | Process is down. History unchanged. | Crash, network disconnect, or operator stop from `alive`. |
| `dead` | This life is over. Irreversible. Files stay. | A verified death of this body when the scenario sets `permanent_death`. Tests can set the same state. |

There is no transition out of `dead`. A second death event does not create a second life.

Activity exists only while lifecycle is `alive`. It is not the life record and it is rebuilt when the process starts. Crash must not leave a stale activity that blocks restart.

| Activity | Meaning |
| --- | --- |
| `awake` | In the world and not in a bed. |
| `asleep` | `bot.isSleeping` is true. This is the preferred dream trigger. |
| Dream job | Not an activity. A row on the scenario dream queue. The inhabitant stays `alive` whether the job is queued, running, or already applied, and whether they are still `asleep` or already `awake`. |

"Alive and dreaming" means lifecycle `alive` plus a dream job in progress. It does not replace `alive`.

Disconnection uses the existing restart notice only for `alive` or `absent`. A dead inhabitant is not handed `Agent process restarted.` and is not placed back at spawn.

Open. The Minecraft mechanism that keeps a dead body from returning (kick and suppress restart, spectator that never receives control, or a server ban of that name) is a milestone 3 spike. The gate in the supervisor is milestone 1.

## Autonomy without an assigned goal

Implemented. The village settings copy sets `village_autonomy` and clears `init_message`. `resolveVillageAutonomy` in `src/agent/startup_goal.js` starts the existing self-prompt loop with `VILLAGE_AUTONOMY_PREAMBLE` when there is no saved personal goal. `usableGoal` treats that preamble the same way it treats the recovery notice: it is not a lifelong goal. A saved usable self-prompt still wins. Survival startup never calls this function.

Three different things:

| Term | Required? | What it is |
| --- | --- | --- |
| Autonomous activity | Yes, whenever the life is `alive` and not operator-silenced | The existing self-prompt loop and the survival modes. This is how the inhabitant chooses a next action when nothing else is queued. |
| Current intention | No | A short optional hint, usually from the morning brief. The planner may turn it into a plan. An empty intention does not stop the loop. |
| Long-term ambition | No | A self-selected aim that may last many days. Milestone 7. The scenario never assigns one. An empty ambition does not stop the loop. |

The survival experiment keeps using `settings.init_message` as its broad goal. A village scenario must not pass that string in, and must not write a different `init_message` into `settings.js`.

Known dependency, to be handled inside milestone 1:

- `SelfPrompter.start` returns without starting when both the argument and the stored prompt are empty (`src/agent/self_prompter.js`).
- `Agent.start` only calls that after `resolveStartupGoal` finds a saved self-prompt, a process init message, or `settings.init_message` (`src/agent/agent.js`, `src/agent/startup_goal.js`).
- `handleLoad` throws if the saved state is active and the prompt is empty.

That hook is in place. A village inhabitant with no intention and no ambition still enters the loop. The preamble is not persisted as their ambition. `node main.js` with no `--scenario` still resolves `settings.init_message` and does not use the village hook.

## Cognitive architecture

Implemented. Same agent, two model roles, several stores. The day model is the profile's chat model. The dream model is a separate configurable client used only when a sleep job runs. It is the same person reflecting, not a second inhabitant or a supervisor.

```
Day (qwen3:8b, configurable)
  sees: backstory + stance + morning intention
        + live stats, inventory, verified lessons, craft ledger
        + a handful of pinned or relevant episodic lines
        + the existing plan, command docs, and turn window
  writes: actions and speech through the existing command loop
  code writes: episodic events, ledger rows, verified lessons, plan progress

Dream job (qwen3:14b, configurable), queued by a successful sleep, may finish after waking
  reads: this inhabitant's admission snapshot, long-term bank, today's episodes,
         craft ledger, plan outcomes, current relationships
  may write, after code validation:
         long-term social rows, a journal entry, a stance line,
         one to three intentions for the planner
  may not write: admission snapshot, verified lessons, ledger rows, inventory,
                 another person's files, life state, death facts
                 that were not already in this inhabitant's episodes
```

The dream input cap is about sixty short episodic lines plus the compact bank. Those sixty lines are not copied into the next day's action prompt. The day prompt receives the morning brief (about ten lines), the stance, the current intention when one exists, and the always-on factual blocks. An empty intention still leaves the autonomous loop running.

### Memory stores

| Store | Owner | In the day prompt? | Mutable by the dream model? |
| --- | --- | --- | --- |
| Identity snapshot | Runtime, written once at admission from the profile. Backstory, initial temperament, stable id, checksum, admission time. | Yes. The prompt reads this, not a later edit of the profile. | No. |
| Backstory and initial temperament | Inside the snapshot. | Yes. About a dozen backstory facts. Temperament is the starting voice until a stance exists. | No. |
| Relationships | Runtime. One private record per other person this inhabitant knows. Asymmetric. | Only the few relevant to the morning intention or a person in view. | May append an interpretation. May not invent an event that is not in the episodes. |
| Episodic events | Runtime. Code-written, one row per event, stable id. | Pinned lines and a small relevant slice. | Read-only input. |
| Long-term bank | Runtime. Cap around 40 rows, updated by id. | No. The morning brief is the extract. | May update or mark rows for forgetting. Code drops the lowest-priority stale rows and rejects rows that contradict verified facts. |
| Morning brief and stance | Runtime. Replaced each successful dream. | Yes. | Yes, as the dream's validated output. |
| Craft ledger | Runtime. One row per item, code-updated from verified outcomes. | Yes. About 15–25 lines. | No. |
| Verified lessons | Existing `verified_lessons.json`. | Yes, through the existing known-facts block. | No. |
| Live game state | Queried each turn. | Yes. Authoritative over every memory. | No. |
| Conversation window and 500-character summary | Existing `memory.json` and `histories/`. | The turn window, yes. The summary string is kept on disk and is not inserted into a village prompt. Survival prompts still receive it. | No. |
| Journal | Runtime. Append-only private prose. | No, except a short "yesterday" extract if the brief includes it. | May append one entry per dream. |
| Intentions | Runtime. Hints, not a new lifelong goal. | The active one, yes. | May propose. The existing planner still has to accept a feasible plan. |

Episodic rows are the material the dream organizes. Code writes them when something durable happens: a verified craft, a conversation turn with a named person, a gift or theft the actor observed, a construction failure tied to a place, a death this inhabitant witnessed, arriving home. Code does not write a row for every pathing step.

FIFO over one mixed sentence list is rejected. Craft rows update in place. Backstory rows never expire. Episodes roll off only after they have been considered by a dream or have aged out of the recent buffer; the histories archive still holds the raw transcript. Relationship rows are not deleted because a newer stranger spoke.

### Factual versus subjective

Agreed. This split is why the current summary made agents unreliable, and why the dream model is not allowed to "fix" recipes.

- Factual, code-owned: item counts, recipe ingredients from `minecraft-data`, structured action outcomes, placed blocks the outcome verified, free inventory slots, lifecycle state, and the plot assignment recorded on the admission snapshot.
- Subjective, model-owned after validation: what a conversation meant, whether someone is a friend, the journal, the morning intention, the stance line.

If they disagree, the factual store is what the day prompt labels as current reality. The journal can say "I think the chest was stolen" only when an episode supports that the inhabitant found the chest changed. The journal cannot say the stone pickaxe recipe is different from the ledger.

### Working memory

Proposed. The day model's extra village block stays small because `qwen3:8b` is configured with `num_ctx` 8192 and the existing system prompt already carries command docs, a plan, inventory, and up to 15 turns. Budget for the village addition is a few hundred tokens: backstory, stance, one intention, morning brief, ledger, and a handful of episodes. Retrieval of older episodes is a dream-time and `!think` concern, not an every-action paste.

Open. Whether that retrieval should reuse the existing embedding example selector (`ollama/embeddinggemma` on the current profiles) or stay keyword-and-pin only until measured. Milestone 4 can ship with pins and the morning brief and leave semantic retrieval as a later refinement.

### Sleep and the dream queue

Implemented. Successful sleep is the only default trigger. `goToBed` waits on Mineflayer's `sleep` event, which sets `bot.isSleeping`. The 1.21 player NBT field `Sleeping` stays 0 during real sleep; the queue does not read it, and a model claiming it slept does not enqueue a dream. Sunrise, a missed night, or lying down without the server accepting the bed does not enqueue one.

The model call does not keep the body asleep. Waking is normal. The job still completes, and the result is applied at the next decision boundary when that inhabitant is not inside an action. A late result does not replace an intention the inhabitant already changed while awake.

`runtime/scenarios/<scenario_id>/dream_queue.json` is the durable queue. `dream_lease.json` is the turn token. Each inhabitant is a separate Node process, so an in-process lock is not the scheduler.

- One row per accepted sleep: inhabitant id, sleep id, status (`queued`, `running`, `applied`, `rejected`), profile checksum, and enqueue time.
- The same sleep id is ignored. A second sleep while a job is `queued` or `running` does not add another row. A new sleep within 90 seconds of that inhabitant's previous enqueue is also refused, so a rapid sleep/wake loop cannot grow the queue without bound.
- Jobs are FIFO. Any living process may hold the lease and call the dream model for the head job, including another inhabitant's. Only the owner applies the result, and only while alive and while the checksum still matches. A dead life is not enqueued, and a pending job is rejected instead of applied. A failed validation or a failed model call leaves the previous journal, bank, brief, and intention.
- The lease lasts long enough for one dream. A dead holder pid does not keep the lease until that timer ends. Commit is keyed by sleep id, so a retry or a crash during the write does not append a second journal entry.
- Day-model calls are never queued behind a dream. A dream waits up to 45 seconds for 3 seconds without a day call, then starts anyway. After a dream, the next one waits 20 seconds so the day model can return to memory. The dream model's `keep_alive` is short (`45s` on the current scenarios) so it unloads. The day model stays loaded (`keep_alive` -1). This does not stop the two models from sharing the GPU during a dream; it stops them from evicting each other on every turn and from blocking survival on the queue.
- Timeout is 180 seconds. Output budget defaults to 1536 tokens and is capped at 2048. One retry. If `qwen3:14b` is missing, the error starts with `Dream model unavailable.` Thinking is on for a qwen3 dream model unless the scenario sets `think` false. The day model stays `think` false.
- Dream output is one JSON object: `journal`, `memories`, `relationships`, `stance`, `intentions` (zero to three), and `brief` (at most ten lines). Facts must paraphrase cited episodes. Feelings are interpretations. Extra keys are ignored. The dream cannot rewrite identity, life, lessons, the craft ledger, inventory, or another inhabitant's files.

The dream reads only that mind's snapshot, bank, episodes (capped at about sixty, cut off when inference starts), ledger, plan outcome, and relationships. Events after the cutoff stay unconsolidated. It is prompted in the first person. Intentions are optional. They are not a new `self_prompt` essay and they are not required for the autonomous loop. A first day with no episodes can choose an intention from the day model once. That orientation does not invent a journal. Actual dreaming still requires actual sleep.

If the dream model errors, yesterday's brief remains and the inhabitant keeps acting. Sleep deprivation, if it is ever built, may shrink retrieval. It must not rewrite the snapshot, episodes, lessons, ledger, or queue history into garbage. It is milestone 7, not part of the queue.

### Personality

Agreed. Personality is continuity of preference under new events.

- The admission snapshot is the prior. Backstory facts are concrete and behavioral ("keeps a private chest", "dislikes being followed"), not a paragraph of traits the 8B model is asked to perform.
- The evolving part is the relationship bank plus one stance line. The day model acts that line. It does not author a new personality.
- Seed relationships are optional scenario content. A person may start as a stranger, an acquaintance, a friend, or someone with a differing opinion. Differing opinions are not required for a valid population.
- The shared survival prompt is what made the current agents converge. The village scenario does not use that prompt. Distinct voices come from the snapshot when the author wrote them, and from later experience either way.
- No profession field. An interest may appear in the backstory as a preference. It is not a job the planner is required to pursue.

The survival planning prompt and `settings.init_message` stay in force for the survival scenario. A village scenario has no assigned ambition. Identity text comes from the snapshot. The autonomous-loop hook is the milestone 1 investigation above. Survival `settings.js` stays the default when no scenario is selected.

## Knowledge, death, and evidence

**Local knowledge.** An inhabitant learns by:

- their own verified actions and the blocks and containers they personally open,
- players and entities currently loaded on their client,
- chat that actually reached them,
- reading their own memory.

They do not learn from another inhabitant's runtime files, and they do not learn from the observer UI. The day prompt reads only `identity.json`, `knowledge.json`, `relationships.json`, and `episodes.json` in its own directory.

Ordinary speech, including Minecraft chat, whispers, and agent-to-agent MindServer messages, is accepted only when the speaker's body is loaded and within `hearing_blocks` (default 32, measured in Euclidean blocks). A speaker who is not loaded is not heard. That silence is not described as a death or an absence. Survival sessions do not use this filter: when other agents exist they still ignore public chat and accept MindServer messages at any distance. Operator messages sent through MindServer `send-message` stay on that administrative channel and are not distance-filtered. Village Alpha already sets `showDeathMessages false`. The dying agent's death message is not copied into anyone else's history.

**Death.** Survival agents still respawn and continue. A scenario with `permanent_death: true` does not.

- The life record stores time, position, dimension, the server death-translation key when it is more specific than `death.attack.generic`, and the server message. A missing or generic key is stored as `cause: null`, which means unknown. The code does not invent a cause.
- `dead` is written when the death event arrives, before the 500ms wait that allows a later message to fill an unknown cause and before the process exits. The exit code is 0. A missing cause does not undo `dead`. Launch, `AgentProcess` auto-restart, and MindServer start and `forceRestart` all go through `beginProcess`, which refuses `dead`.
- The Mineflayer session is ended. The mind is not told to continue the objective.
- No system observation is injected into other agents saying that this person died.
- Another inhabitant records a death only through `recordDeathKnowledge`: `witness` and `discovery` are `observed`, and `told` names the speaker. Those writes touch only the listener's directory.
- A crash, kick, network drop, server shutdown, or operator stop of a living inhabitant stays `absent`.
- Offline mode identifies a Minecraft user by username. The supervisor will not start a dead life, and the placement datapack will not treat a new login as a new admission of that mind. Another client can still connect with the same offline username. That is not cryptographic identity. Human players join under their own names.

**Remains.** Dropped items can despawn, and the inhabitant is not an operator, so the agent does not type a command. When `settings.remains_container` is set, the death shutdown calls `placeConfiguredRemains` through RCON on that container only. The container name `ai-village` or `village-alpha` is refused. The stand is an armor stand whose visible custom name is the Minecraft username. It also carries the server-only tag `village_remains`. Mineflayer does not receive scoreboard tags; discovery reads the custom name from entity metadata. Cause, time, and coordinates are not written on the stand. Air, water, and grass are acceptable sites. The feet block is used, then one block up, then the four neighboring columns. Lava, the void (`y < -64`), a chest, a barrel, a bed, a crafting table, and a furnace are not replaced. `data get block` does not name a normal block, so the site check is `execute if block`. The chunk is forceloaded only for the summon and then released. An unloaded chunk stays `unplaced` with reason `unloaded`. A later call does not summon a second stand once `evidence.status` is `placed`. `scripts/village/place-remains.js` is the manual operator command. It refuses the survival world, and it refuses Village Alpha unless `--allow-village-alpha` is passed.

**Resources.** Homes, beds, food, tools, and paths are placed before any inhabitant is started, by `node scripts/village/provision.js` against the isolated village server. The village-alpha world is the plains village from seed `village-alpha`, with chests and missing fixtures added once from `site.json` and the supply manifest. Agents are not asked to bootstrap that village with `buildPlane`. After a house has been provisioned once, chests are ordinary containers. Food can be eaten. Tools can break. Restart, death, and absence do not refill them. Vacant plots are not stocked. The plot list remains the home assignment.

## Observer

Proposed. Extend the existing MindServer rather than standing up a second control plane, unless a spike shows the UI cannot host a read-only life view. The observer may list inhabitants and open, per person: journal, relationships, recent episodes, current intention, plan status, lifecycle, and activity. Controls that already exist (stop, start, restart) remain operator actions and must use the same death gate as the supervisor. Start or restart on a dead life is refused.

The inhabitant prompt path has no tool that reads this view.

## Safety boundaries

Agreed, and already true of the gameplay stack:

- No inhabitant command runs server admin actions.
- Generated JavaScript stays disabled.
- Construction cannot place command blocks, barriers, or other forbidden blocks (see `FORBIDDEN` in `construction.js`).
- Dream output is data filed by code, never code executed by the agent.
- Operator commands stay `operatorOnly`.

## Open technical decisions

Collected here so implementation does not pretend they are settled.

Decided, and no longer open: runtime root `runtime/scenarios/<scenario_id>/` via `agent_data_root`; CLI `--scenario`; explicit TCP ports; survival names are rejected; plots own home assignment; a later house edit is `home_mismatch` rather than a refused start; admission snapshot plus checksum; restart-based admission; dead is terminal across every start path; crash, disconnect, and operator stop are `absent`; no sleep means no dream; the dream client is built when a sleep job runs, not at admission; dream output is the JSON object in the sleep section, with a 180 second timeout and the error prefix `Dream model unavailable.`; a failed dream keeps yesterday's brief; the day-model overlay reuses the prompter merge; the admission snapshot is the day-prompt identity; no assigned ambition still runs the autonomous loop through `VILLAGE_AUTONOMY_PREAMBLE`, with a 15 second pause when the inhabitant chooses not to act; ordinary speech uses a 32-block default radius; a verified death exits the process after `life.json` is durable; physical evidence is an operator-placed named armor stand, not an emptied house; milestone 2 places blocks by furnishing the seed village once through `scripts/village/provision.js`.

Still open.

1. Semantic retrieval of old episodes. Milestone 3 selects pinned episodes and a small recent or name-matched slice. Milestone 4's dream reads the newest sixty plus pinned rows. It does not embed or search the archive.
2. Whether temperament later gains a small code-owned preference record. Milestone 7. Until then, prose facts and a stance line.
3. Whether any container is designated public. Private chests are ordinary containers the owner can open; taking from one needs no special theft system if the game already allows the open. Which containers are private is the plot's chest, decided. Extra shared chests are optional scenario content.
4. Dashboard inside MindServer versus a read-only addition. Preference: extend MindServer. Milestone 5.
