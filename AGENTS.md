# Agent notes for this repository

Mindcraft CE is an experimental Minecraft agent stack (Mineflayer plus a local or remote language model). Node.js `>=22.13.0` is required (`package.json` `engines`). The default entry point is `node main.js`, which loads every profile listed in `settings.js`.

## Village simulation

A separate social-simulation experiment is specified and not yet implemented. Before adding or changing anything that affects inhabitants, scenarios, memory, sleep, death, or the observer view of those lives, read:

- `docs/village-simulation/VISION.md`
- `docs/village-simulation/ARCHITECTURE.md`
- `docs/village-simulation/ROADMAP.md`
- `docs/village-simulation/SCENARIO_SCHEMA.md`

Spec-Version 0.2.0 is documentation only. Do not implement a milestone unless the task names it. Start with milestone 1 when implementation is requested. Do not fold later milestones into that change.

The current survival run is not the village. Leave `settings.js` (`init_message`, `host`, `port`, `minecraft_version`, `auth`), `profiles/agent_0*.json`, and `bots/Finn`, `bots/Sawyer`, `bots/Milo`, `bots/Jasper`, and `bots/Rowan` in place. A village scenario carries its own connection and its own `runtime/scenarios/<id>/` tree. Do not reset those memories, edit them to match the spec, restart those agents, or change either Minecraft world as part of documentation or unrelated work.

When implementing milestone 1, keep these rules: plots own home assignment; admission writes `identity.json` once and never recopies it, seed relationships, or supplies on restart; `dead` is terminal for every start path, including supervisor restart and operator start; crash and disconnect are `absent`; a village inhabitant with no intention and no ambition still runs the autonomous loop; the survival startup goal path stays as it is when no scenario is selected. Dream scheduling is milestone 4. Do not block the dream design on the body staying asleep, and do not treat sleep deprivation as license to corrupt stored memory.

Reuse the existing agent, planner, action outcomes, lessons, construction, conversation hygiene, and MindServer. The architecture document lists the modules. Do not create a parallel bot runtime or a second command language.

## Safety and process boundaries

- `allow_insecure_coding` stays false unless the operator explicitly enables it for a task that is not the village simulation. Village scenarios must reject `true`.
- Do not give inhabitants operator or server-admin commands. `operatorOnly` commands stay human-only.
- Do not run generated model code as part of village work.
- Runtime play data (`bots/<name>/` today, `runtime/scenarios/` when milestone 1 adds it) is persistent life history. Do not delete or rewrite it to clean a branch unless the operator asks.

## Tests and edits

Behavior changes ship with `node --test` coverage beside the existing files in `tests/`. There is no npm test script; run the test file directly.

Keep edits limited to the task. The gameplay stack (planning, structured outcomes, reflection, construction, inventory, recovery, conversation attribution) is shared with the survival experiment, so a village change must say how that experiment still starts.
