# Village simulation roadmap

Spec-Version: 0.5.1
Status: Milestones 1, 2, and 3 are implemented. Later milestones are not.
Date: 2026-11-15

Revised from 0.4.0. Milestone 3 adds private identity, episodes, relationships, local speech, and a durable death transition. Dreaming stays later. The milestone was not run against the live Village Alpha server.

Milestones are sequential. A later milestone may be designed against this document, but it is not started until the previous milestone's acceptance criteria are met. The recommended first implementation is milestone 1.

Do not treat this file as a request to implement. Implementation starts only when a task names a milestone.

The survival experiment (current `settings.js`, `profiles/agent_0*.json`, and `bots/Finn|Sawyer|Milo|Jasper|Rowan/`) keeps working at every milestone. Village work uses a new scenario and new inhabitant ids.

## Milestone 1 — Simulation foundation

Status: Implemented.

Configuration-driven scenario, isolated runtime, population registry, admission, and lifecycle boundaries. No dreaming, no world edits, no new gameplay.

Implementation choices locked with this milestone:

- Select a scenario with `node main.js --scenario <id>` or `node main.js --scenario <path-to-scenario-directory>`. That path does not launch `settings.profiles` and does not write `settings.js`.
- `connection.port` must be an integer from 1 to 65535. The survival scanner value `-1` is rejected.
- Admission runs when the scenario process starts. Adding a person is a data change plus a later restart. Hot admission while a process is already up is not implemented.
- Each inhabitant's agent files go under `runtime/scenarios/<scenario_id>/<inhabitant_id>/` through `settings.agent_data_root` on that agent's settings copy. `runtime/` is play data and is gitignored.
- A plot edit that points an admitted life at a different house is recorded as `home_mismatch`. It does not rewrite `identity.json` and it does not refuse startup. Two plots naming the same occupant in one file is a hard error.
- The day model is overlaid as the profile `model` and still merged by `Prompter` with `profiles/defaults/_default.json` and the scenario `base_profile`. The dream model is stored as `settings.dream_model` and no dream client is built. The admission snapshot is not inserted into the day prompt until milestone 3.
- The autonomous loop starts from `VILLAGE_AUTONOMY_PREAMBLE` in `src/agent/startup_goal.js`. `usableGoal` ignores that text, so it is not stored as an ambition. `init_message` on the village settings copy is null.

### Definition of done

- A versioned scenario file names a population, a Minecraft `connection` (`host`, `port`, `minecraft_version`, `auth`), and a distinct runtime directory.
- Starting that scenario does not read or write the survival agents' `bots/<name>/` directories and does not change `settings.js` host, port, version, auth, or `init_message`.
- Adding another inhabitant is a new profile file plus a scenario entry. Assigning a house is setting `occupant` on a vacant plot. No change to command implementations, modes, or `Agent` gameplay.
- Every inhabitant still receives the shared baseline (commands, modes, planning, outcomes, reflection).
- The first start of a life writes `identity.json` once. A later start does not copy backstory, temperament, seed relationships, or supplies over that life. A changed profile checksum is recorded and does not rewrite the snapshot.
- Lifecycle is `admitted`, `alive`, `absent`, or `dead`, separate from activity. `dead` is irreversible. Crash, disconnect, and operator stop become `absent`, not `dead`.
- The launch loop, `AgentProcess` restart, and MindServer start and restart all refuse `dead`. Milestone 1 tests that gate with fixtures only. It does not implement permadeath on a live Minecraft server.
- The self-prompt and startup-goal path is investigated. A village inhabitant with no intention and no ambition still enters the autonomous loop. The survival `init_message` path is unchanged when no scenario is selected.
- `node main.js` with the current settings still launches the survival experiment unchanged.
- Automated tests cover schema rejection, connection isolation, path isolation, snapshot immutability, the death gate, and "restart is not death."

### Acceptance criteria

- A fixture scenario with two profiles loads both, and a third profile is admitted by editing only the fixture. A vacant plot can then name that third id with no code change.
- The fixture's `connection` is what the scenario run would pass to an agent. A test shows the survival settings object is not mutated.
- A unit test fails the run if a village runtime path resolves inside an existing survival `bots/<name>/` directory.
- A second start of a fixture life leaves `identity.json` and `relationships.json` byte-identical even if the profile text changed. The mismatch is recorded.
- Killing the process of an alive test inhabitant records `absent` and does not mark `dead`. The same is true for a simulated disconnect and a simulated operator stop.
- Marking a fixture inhabitant `dead` causes launch, auto-restart, and the operator start and restart entry points to refuse another start. The fixture's files remain. A further test cannot transition that fixture back to `alive`.
- A village fixture with an empty intention and no ambition still has the autonomous loop started. A survival-shaped startup, given the current `init_message` and no scenario, still resolves that message and does not use the village hook.
- Survival profiles are not required to contain backstory, life state, or dream model fields.
- `allow_insecure_coding` remains false. No new operator-equivalent command is exposed to the model.

### Out of scope

Beds, world provisioning, journals, the dream queue worker, dashboard pages, and real permadeath in a live Minecraft session. The death gate is in scope. Killing a live Minecraft body is not.

## Milestone 2 — Provisioned village

Status: Implemented.

An established place in a Minecraft world: homes, beds, food, storage, tools, a public space, and paths an inhabitant can walk. Agents do not build this.

`scenarios/village-alpha` points at Paper 1.21.6 on `127.0.0.1:25566`. The world is the plains village generated by seed `village-alpha` (numeric 577321213), saved outside the git repo at the directory in `services/village-alpha/.env`. `scenarios/village-alpha/site.json` is the measured layout. `node scripts/village/provision.js` furnishes that layout once and writes `village-provision.json` into the world directory. A later server start does not run it. `--reprovision` also requires `--confirm-erase` because that refills chests. `showDeathMessages false` on this server is a broadcast precaution, not permadeath and not information isolation.

### Definition of done

- The scenario describes plots and public places well enough that an operator can build or load the same village again.
- Each inhabitant who has a plot has a home, a bed, a private container, and a starting supply of food and basic tools. Vacant plots are allowed and are not assigned by code.
- At least one public space and a walkable path between homes exist.
- Spawn or first placement puts each body at their own home, not in a shared pile.
- Supplies are finite. Nothing in the agent loop, a restart, a death, or an absence restocks them, clears them, or gives them to someone else.
- A written operator checklist records what was verified in the world. Application tests cover the scenario description (every inhabitant resolves to a plot; required plot fields exist). They do not need to boot a Minecraft server unless a harness already exists.

### Acceptance criteria

- Five new inhabitants, not the survival five, are the population named by the first real scenario.
- An operator can confirm, for each home: bed usable by `goToBed`'s search range from inside the home, food in that home's container, a crafting table and furnace available without a mining trip, and a path to the public space that does not require breaking blocks.
- The survival world and the survival agents' positions are not modified by this provisioning.
- Agents still have no admin commands and no generated-code execution.

### Out of scope

Personality-driven play, death, dreams, refilling chests, asking agents to construct the village.

## Milestone 3 — Identity, memory, local knowledge, death

Status: Implemented. Automated acceptance and a disposable live verification are separate. `node --test tests/*.js` is the automated suite. The live check used container `village-m3-smoke`, port `127.0.0.1:25567`, and scenario `village-m3-smoke` with temporary inhabitants Wynn, Holt, and Nia. It did not start Ione, Cass, Rufus, Nell, or Bram, and it did not write to Village Alpha or the survival world.

Private minds and permanent death, still on the daytime model only. The day prompt reads `identity.json`, `knowledge.json`, `relationships.json`, and a short slice of `episodes.json` from that inhabitant's directory. Ordinary speech is audible within `settings.hearing_blocks` (32 on village-alpha) of a loaded body. A verified death writes `lifecycle: dead` before the 500ms shutdown wait, then the process exits with code 0, so the supervisor does not restart it. Survival agents still respawn and continue. When `settings.remains_container` names the scenario's own server, that shutdown summons one named armor stand. The client sees the custom name, not the server-only `village_remains` tag. `scripts/village/place-remains.js` remains an operator command and was not run against Village Alpha. Automated coverage is `tests/village_minds.test.js`.

### Definition of done

- Each profile carries a locked backstory and initial temperament that the day prompt includes and that no model write path can change.
- Code writes episodic events with stable ids into that scenario's runtime.
- Relationships are private per inhabitant and may disagree.
- An inhabitant prompt cannot open another inhabitant's runtime files.
- Perception used for memory is local: own actions, visible entities, containers they open, and chat that the locality rule accepts.
- Death sets life state to dead, preserves the runtime directory, does not respawn the mind into play, and does not inject a death announcement into anyone else's history.
- A disconnect stays absent and can return. It does not create a death episode for anyone.

### Acceptance criteria

- Given two fixtures who both "see" a chest change and one who was not present, only the present pair receive an episode, and their relationship notes cannot appear in the third prompt.
- An attempt to edit the admission snapshot from a fake dream or summary payload is rejected, and `identity.json` is unchanged.
- A death fixture is not restarted by `AgentProcess`, and a peer fixture's history does not contain a system line naming that death.
- A disconnect fixture is restarted by the existing recovery path, receives the restart notice rather than a death observation, and keeps its goal rules from `startup_goal.js`.
- Public death chat and MindServer fan-out are either disabled for this scenario or ignored by the listener. The open decision in [ARCHITECTURE.md](ARCHITECTURE.md) must be resolved in the implementation notes for this milestone, not left as silent broadcast.
- Verified lessons and live inventory still override any narrative text in the prompt.

### Out of scope

The 14B dream, journals written by the dream model, the observer dashboard, sleep deprivation.

## Milestone 4 — Sleep and dreaming

One stronger-model consolidation pass during real sleep.

### Definition of done

- Scenario config selects the dream model. Default `qwen3:14b`. The day model stays the profile chat model. Default `qwen3:8b`.
- A successful sleep enqueues at most one dream on the scenario queue. A second sleep while that row is `queued` or `running` does not add another. Dreams run one at a time across the population.
- The job still runs and can be applied if the inhabitant is already awake. It is not applied if the life is `dead` or the snapshot checksum no longer matches. Staying in bed is not required for inference to finish.
- The dream reads only that mind's admission snapshot, bank, episodes (capped, on the order of sixty), ledger, plan outcome, and relationships.
- Validated output may append a journal entry, update long-term social rows, set the stance, and propose one to three short intentions.
- Code drops output that rewrites the admission snapshot, lessons, ledger, inventory, lifecycle, or unwitnessed deaths.
- The day prompt after a successful apply contains the new brief and stance, plus the intention when one was accepted, and not the sixty input lines. An empty intention does not stop autonomy.
- Intentions are hints to the existing planner and are rejected when infeasible. They do not overwrite a survival-scenario goal, because this runs only for a village scenario.
- If the dream model errors, or the bot never successfully sleeps, yesterday's brief remains and the inhabitant still acts. No sunrise fallback.

### Acceptance criteria

- A fixture dream payload that changes an admission-snapshot fact or a recipe is stored only as a rejected attempt, or not stored, and `identity.json` is byte-identical.
- Two inhabitants sleeping in a test double produce two calls in series, not in parallel.
- A successful fixture dream yields one journal entry, a morning brief no larger than the documented cap, and an intention the planner can refuse. The autonomous loop still runs if that intention is discarded.
- A no-bed day produces zero dream calls.
- A fixture that wakes before the fake model returns still applies one valid result, and a second sleep during `running` does not enqueue a duplicate.
- The action context assembled for the next turn includes the brief and excludes the raw sixty-line input.

### Out of scope

Dashboard, population beyond the scenario file, sleep-deprivation effects, semantic search of the whole past.

## Milestone 5 — Observer dashboard

A read-only life view for the human watching the simulation.

### Definition of done

- The operator can open, per inhabitant: journal, relationships, recent episodes, current intention, plan summary, and life state (alive, absent, dead).
- The view reads runtime files. It does not grant the inhabitant a tool or prompt section that reads other files or this dashboard.
- Dead lives stay visible. Start is refused for them.
- The existing MindServer chat and process controls still work for the survival experiment.

### Acceptance criteria

- With fixture runtime files and no Minecraft connection, the view renders one living and one dead inhabitant and does not offer start for the dead one.
- A test or review pass confirms the day-model prompt builder has no dashboard endpoint and no path argument that selects another inhabitant's directory.
- Survival agents, if running, do not appear as village journals unless their scenario says so. The default survival run has no journal page.

### Out of scope

Editing memories from the dashboard, generating backstories, sleep deprivation.

## Milestone 6 — Population and emergent social play

Grow the village by data, and let ordinary play accumulate.

### Definition of done

- A written procedure adds an inhabitant: profile, optional assignment of a vacant plot, scenario entry, runtime directory created on admit. No application code diff is required for that person. Seeded disagreement is not required.
- The day and dream loops treat the new person like the others.
- Ordinary play (talk, give, take, avoid, decorate) needs no new quest system. A seeded disagreement is one optional way to start, not a requirement.
- Notes from play record whether intentions stayed small and whether accounts of the same day diverged. Those notes are observations, not a pass/fail score.

### Acceptance criteria

- A sixth fixture inhabitant is admitted using only scenario and profile files, then appears in the registry and the dashboard.
- Their prompt contains their backstory and not another person's journal.
- No new command is added solely for that sixth person.

### Out of scope

The advanced systems in milestone 7.

## Milestone 7 — Advanced inner life

Future. Not designed in detail.

- Sleep deprivation may reduce how much of the bank and episode buffer is retrieved, and may shorten or dull the brief. It must not delete identity, episodes, lessons, or the ledger.
- Preferences may change from repeated experience and become part of the runtime personality, still without editing the locked backstory.
- Long-term ambitions may be proposed by dreams and kept, revised, or dropped. They remain self-selected. The scenario never assigns one.

### Acceptance criteria

These will be written when the milestone is specified. Any design that "simulates fatigue" by corrupting JSON stores fails the vision even if behavior looks drowsy.

## Recommended next step

Milestones 1 and 2 are in place. The next milestone is 3. Do not start it until a task names it.
