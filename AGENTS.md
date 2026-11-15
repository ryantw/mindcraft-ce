# Agent notes for this repository

Mindcraft CE is an experimental Minecraft agent stack (Mineflayer plus a local or remote language model). Node.js `>=22.13.0` is required (`package.json` `engines`). The default entry point is `node main.js`, which loads every profile listed in `settings.js`.

## Village simulation

A separate social-simulation experiment is specified in Spec-Version 0.6.0. Milestones 1, 2, 3, and 4 are implemented. Milestones 5–7 are not. Milestone 2's world is a separate Paper 1.21.6 server, not the survival server. Before adding or changing anything that affects inhabitants, scenarios, memory, sleep, death, or the observer view of those lives, read:

- `docs/village-simulation/VISION.md`
- `docs/village-simulation/ARCHITECTURE.md`
- `docs/village-simulation/ROADMAP.md`
- `docs/village-simulation/SCENARIO_SCHEMA.md`

Do not implement a later milestone unless the task names it. Do not start `node main.js --scenario` unless the task asks for a live run. Do not run that process at the same time as `node main.js`: both use MindServer port 8080 and viewer ports from 3000.

The village server is `services/village-alpha/compose.yaml`. Start and stop it with `docker compose --env-file services/village-alpha/.env -f services/village-alpha/compose.yaml up -d` and the same file with `stop`. It listens on `127.0.0.1:25566` (game) and `127.0.0.1:25576` (RCON). The world directory and RCON password stay in the gitignored `.env` and must not be committed. Join as any offline name except the inhabitant names; the first join of an inhabitant name is moved to that person's home once and then tagged so a restart does not move them again. `node scripts/village/provision.js` refuses to run when a receipt already exists.

Select a scenario with `node main.js --scenario village-alpha` or `node main.js --scenario scenarios/village-alpha`. That does not launch `settings.profiles`. To add an inhabitant, add `scenarios/<id>/inhabitants/<inhabitant_id>.json`, list that relative path in `scenario.json`, and optionally set a vacant plot's `occupant` from `null` to that id. Admission happens the next time that scenario process starts. Removing a person from `scenario.json` must not delete `runtime/scenarios/<id>/<inhabitant_id>/` and must not mark them dead.

The current survival run is not the village. Leave `settings.js` (`init_message`, `host`, `port`, `minecraft_version`, `auth`), `profiles/agent_0*.json`, and `bots/Finn`, `bots/Sawyer`, `bots/Milo`, `bots/Jasper`, and `bots/Rowan` in place. A village scenario carries its own connection and its own `runtime/scenarios/<id>/` tree. Do not reset those memories, edit them to match the spec, restart those agents, or change either Minecraft world as part of documentation or unrelated work.

When implementing milestone 1, keep these rules: plots own home assignment; admission writes `identity.json` once and never recopies it, seed relationships, or supplies on restart; `dead` is terminal for every start path, including supervisor restart and operator start; crash and disconnect are `absent`; a village inhabitant with no intention and no ambition still runs the autonomous loop; the survival startup goal path stays as it is when no scenario is selected. A dream is queued only after Mineflayer reports real sleep (`bot.isSleeping`). Do not keep the body in bed until inference finishes, and do not treat sleep deprivation as license to corrupt stored memory.

Milestone 3 reads the admission snapshot into the day prompt and writes `knowledge.json`, `episodes.json`, and stance updates under that inhabitant's runtime directory. Ordinary village speech is limited to `hearing_blocks` (32 on village-alpha). `permanent_death: true` on a scenario writes `dead` on a verified death and exits the process. Survival agents still respawn. Milestone 4 queues a dream only after a real sleep and writes `journal.json`, `morning.json`, `long_term.json`, and `intentions.json` in that same private directory. A village session does not regenerate the 500-character rolling summary and does not put that string in the decision prompt. Survival sessions still summarize and still receive it. The existing `memory.json` string is left in place. The five Village Alpha inhabitants have not been started. Do not run `scripts/village/place-remains.js` against Village Alpha or the survival world unless the operator names that target. Offline usernames are not credentials: the supervisor will not relaunch a dead life, but another client can still connect with the same name. The disposable live check is scenario `village-m3-smoke` on container `village-m3-smoke`, `127.0.0.1:25567`. Do not point it at `127.0.0.1:25566` or port 25565.

Reuse the existing agent, planner, action outcomes, lessons, construction, conversation hygiene, and MindServer. The architecture document lists the modules. Do not create a parallel bot runtime or a second command language.

## Safety and process boundaries

- `allow_insecure_coding` stays false unless the operator explicitly enables it for a task that is not the village simulation. Village scenarios must reject `true`.
- Do not give inhabitants operator or server-admin commands. `operatorOnly` commands stay human-only.
- Do not run generated model code as part of village work.
- Runtime play data (`bots/<name>/` today, `runtime/scenarios/` when milestone 1 adds it) is persistent life history. Do not delete or rewrite it to clean a branch unless the operator asks.

## Tests and edits

Behavior changes ship with `node --test` coverage beside the existing files in `tests/`. There is no npm test script; run the test file directly.

Keep edits limited to the task. The gameplay stack (planning, structured outcomes, reflection, construction, inventory, recovery, conversation attribution) is shared with the survival experiment, so a village change must say how that experiment still starts.
