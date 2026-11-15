# Village simulation scenario schema

Spec-Version: 0.6.0
Status: Schema version 1 is loaded by the application.
Date: 2026-11-15

Revised from 0.2.0. Milestone 1 loads this schema. Decisions recorded below: explicit scenario ports, restart-based admission, and where agent files are written.

The examples are illustrations of the contract. They are not a live scenario, not profiles to launch, and not instructions to edit `bots/` or the Minecraft world.

## Versioning

- `schema_version` is an integer on every scenario file and every runtime file this spec defines.
- Spec-Version in the markdown header changes when the product meaning changes, even if the JSON gains no field.
- Breaking JSON changes increment `schema_version` and require a migration note in this file. Milestone 1 starts at `schema_version: 1`.
- Unknown fields are rejected in scenario files. Runtime files may be read forward-only: a newer reader accepts an older `schema_version` only after an explicit migration. A failed migration leaves the file in place and refuses to start that inhabitant.
- Backstory facts are content-addressed by `id` inside the profile. After admission, the runtime snapshot is the historical identity. Changing the profile does not change that snapshot. Prefer a new inhabitant id, or a new scenario id, for a genuinely new person.

## Where files live

Proposed.

| Kind | Path | Committed? |
| --- | --- | --- |
| Scenario | `scenarios/<scenario_id>/scenario.json` | Yes |
| Inhabitant identity | `scenarios/<scenario_id>/inhabitants/<inhabitant_id>.json` | Yes |
| Village layout description | `scenarios/<scenario_id>/village.json` | Yes |
| Runtime, per life | `runtime/scenarios/<scenario_id>/<inhabitant_id>/` | No |
| Dream queue | `runtime/scenarios/<scenario_id>/dream_queue.json` | No. Milestone 4. |
| Survival experiment | `profiles/agent_0*.json`, `bots/<Name>/`, current `settings.js` host, port, version, and auth | Unchanged. Not a village scenario. |

`runtime/` is private persistent state. It must be gitignored when the directory is introduced. Coding agents do not delete it to reset an experiment unless the operator explicitly asks.

Name collision rule: an inhabitant id or Minecraft name used by the survival run is rejected by scenario validation. The first village cohort uses new names.

## Scenario file

`scenarios/<scenario_id>/scenario.json`

```json
{
  "schema_version": 1,
  "id": "village-alpha",
  "title": "Established village",
  "connection": {
    "host": "127.0.0.1",
    "port": 25566,
    "minecraft_version": "1.21.6",
    "auth": "offline"
  },
  "models": {
    "day": { "api": "ollama", "model": "qwen3:8b" },
    "dream": { "api": "ollama", "model": "qwen3:14b" }
  },
  "inhabitants": [
    "inhabitants/ada.json",
    "inhabitants/ben.json"
  ],
  "village": "village.json",
  "settings": {
    "base_profile": "survival",
    "allow_insecure_coding": false,
    "load_memory": true,
    "permanent_death": true,
    "hearing_blocks": 32
  }
}
```

Rules:

- `id` matches the directory name. Lowercase, digits, hyphens.
- `connection` is required. `host`, `port`, `minecraft_version`, and `auth` are the fields `initBot` reads from settings today (`src/utils/mcdata.js`). They are not copied from, and must not be written back to, `settings.js`.
- `port` must be an integer from 1 to 65535. The survival scanner value `-1` is rejected so a scenario cannot attach to whichever local world the scanner finds.
- If `initBot` later gains another required connection field, it is added here and the schema version increments. `mindserver_port` is not a connection field. It belongs to the supervisor process.
- `inhabitants` is an ordered list of paths relative to the scenario directory. Length may be any positive number. The first real experiment uses five. Tests may use two. The list may be empty only in a validator fixture, not in a launched scenario.
- `models.day` and `models.dream` are required and may be changed without code edits. They use the same provider records Mindcraft already accepts (`api`, `model`, optional `params`).
- `settings.allow_insecure_coding` must be false. Validation fails closed if it is true or missing.
- `settings.base_profile` selects the shared gameplay defaults (`survival` unless a future village base profile is added). It does not select a personality.
- `settings.permanent_death` is optional. `true` retires a verified death of that body. Omitted or `false` keeps the survival respawn-and-continue behavior. Village Alpha sets `true`.
- `settings.hearing_blocks` is optional, an integer from 8 to 128. Omitted means 32. It is the radius for ordinary speech in a village session.
- `settings.remains_container` is optional. When set, a verified death summons one named armor stand through RCON on that container. The name must not be `ai-village`. Only the Village Alpha scenario may name `village-alpha`. Omitted means the death record is written and no stand is summoned. A failed placement stays on the death record and can be retried up to three times without starting the deceased inhabitant. The client reads the armor stand's custom name. The `village_remains` tag is server-side only.
- No field here assigns a profession, a settlement quest, or a lifelong ambition.

The scenario does not embed `settings.init_message` and must not overwrite it. The survival message stays the default for `node main.js` with no scenario. A village run has no assigned ambition. That does not stop the autonomous loop. Milestone 1 adds the scenario-level hook described in [ARCHITECTURE.md](ARCHITECTURE.md). Current intentions, when they exist, come from runtime after milestone 4. Long-term ambitions are never a scenario field.

## Inhabitant file

`scenarios/<scenario_id>/inhabitants/<inhabitant_id>.json`

This is admission data. It is the locked prior.

```json
{
  "schema_version": 1,
  "id": "ada",
  "name": "Ada",
  "profile_version": 1,
  "backstory": [
    {
      "id": "home",
      "text": "Ada lives in the east house and treats the chest there as private."
    },
    {
      "id": "temper",
      "text": "Ada dislikes being followed and will leave a conversation that will not drop the subject."
    },
    {
      "id": "ben",
      "text": "Ada already finds Ben loud and thinks he talks over people."
    }
  ],
  "temperament": [
    "Speaks briefly.",
    "Prefers her own doorway to the public square.",
    "Notices when objects in her house move."
  ],
  "interests": ["doorway flowers", "quiet mornings"],
  "seed_relationships": [
    {
      "other_id": "ben",
      "stance": "wary",
      "note": "Thinks Ben talks over people. Ben may not know she feels this way."
    }
  ]
}
```

Rules:

- `id` is stable for the life of the scenario. `name` is the Minecraft username and must pass the existing name check in `connection_handler.js`.
- There is no `home` field. Home assignment lives only on `village.json` plots.
- `profile_version` is a positive integer. Authors increment it when they change identity fields on purpose. A new version does not re-admit an existing life and does not rewrite the snapshot. A new person is a new `id`.
- `backstory` is a list of `{id, text}`. About a dozen facts. Text is behavioral and concrete. No profession and no survival quota. A temperament fact is enough; a clinical label alone is not.
- `temperament` is the initial voice and habits. Runtime may add a stance later. It may not delete these strings.
- `interests` are preferences, not jobs and not plan steps.
- `seed_relationships` are optional. They are this person's private starting view. The other file need not mirror them. `other_id` must be another inhabitant in the same scenario. Omitted, or an empty list, means this person starts with no recorded opinion. Strangers, acquaintances, friends, and disagreements are all valid.
- There is no `goal`, `intention`, or `ambition` field.

### Profile checksum

The identity checksum is SHA-256 over the UTF-8 canonical JSON of exactly these fields, with object keys sorted at every level: `id`, `name`, `profile_version`, `backstory`, `temperament`, `interests`, `seed_relationships`. Canonical JSON uses no insignificant whitespace. Arrays keep their file order.

The checksum covers the profile as admitted. It does not cover `village.json`, so a house edit is a separate mismatch, detected by comparing the snapshot's `home_plot_id` with the plot that names this id.

Profiles still need a Mindcraft model block so the existing loader can run them. Proposed: the scenario runner writes or overlays the day model from `scenario.models.day` at start, and the committed inhabitant file does not fork prompts. If an inhabitant file also contains a `model` object, it overrides the scenario day model for that person only. The dream model is never taken from the inhabitant file; dreaming is a scenario-level role so the population shares one dream configuration unless the scenario itself is changed.

Implemented. The scenario runner builds a profile `{name, model, embedding}` from the inhabitant and `scenario.models.day`. `Prompter` still merges `profiles/defaults/_default.json`, then `base_profile`, then that profile. Gameplay prompt text stays shared. The admission snapshot is written to `identity.json` and is what the day prompt reads. The dream model is `settings.dream_model` on the agent settings copy. The dream client is constructed only when that process claims a sleep job. It is not constructed at admission.

## Village file

`scenarios/<scenario_id>/village.json`

A description the operator and the tests can check. It is not a world editor.

```json
{
  "schema_version": 1,
  "id": "village-alpha-places",
  "spawn_dimension": "overworld",
  "plots": [
    {
      "id": "plot-east",
      "occupant": "ada",
      "home_marker": [0, 64, 0],
      "bed": [2, 64, 1],
      "chest": [1, 64, 2],
      "door": [0, 64, -1],
      "crafting_table": [3, 64, 1],
      "furnace": [3, 64, 2]
    },
    {
      "id": "plot-west",
      "occupant": null,
      "home_marker": [-20, 64, 0],
      "bed": [-18, 64, 1],
      "chest": [-19, 64, 2],
      "door": [-20, 64, -1],
      "crafting_table": [-17, 64, 1],
      "furnace": [-17, 64, 2]
    }
  ],
  "public": [
    { "id": "square", "marker": [20, 64, 0], "notes": "Open meeting ground on the paths." }
  ],
  "provisions": {
    "per_home": {
      "food": [{ "item": "bread", "count": 16 }],
      "tools": ["stone_pickaxe", "stone_axe"],
      "also": ["crafting_table", "furnace", "white_bed"]
    },
    "refill": "never"
  },
  "paths": [
    { "from": "plot-east", "to": "square", "walkable_without_breaking": true }
  ]
}
```

Rules:

- `occupant` is the only home assignment. It is an inhabitant id or `null`. `null` is vacant. An inhabitant profile must not repeat it.
- An inhabitant id appears as `occupant` on at most one plot. A launched inhabitant may appear on none.
- Setting `occupant` from `null` to a new inhabitant id is how admission assigns a vacant house. No application change.
- An occupant who is `dead`, `absent`, or removed from the active list stays the occupant. Schema version 1 has no transfer. A single file cannot list the same inhabitant on two plots. A new inhabitant may be placed on a plot whose `occupant` is `null`.
- Editing a plot so that an already admitted life points at a different house does not rewrite `identity.json`. Admission records `home_mismatch` and the snapshot remains the assignment. Startup is not refused for that mismatch.
- Coordinates are the operator's contract with the world save. For village-alpha they were read from the generated plains village and are applied by `scripts/village/provision.js` from `site.json`. That is an operator action. Provisioning a vacant plot is allowed and does not require an inhabitant.
- `refill` must be `"never"` in schema version 1. Restart and death must not restock containers.
- Possessions already in a house are left alone when the occupant dies, disconnects, or is no longer listed. The scenario runner must not delete or regenerate them.
- `crafting_table` and `furnace` are required coordinates. They are blocks in the house. The supply manifest does not have to duplicate them as chest items.
- Public storage, if any, is listed explicitly. An unlisted chest is not a shared official store.

## Runtime directory

`runtime/scenarios/<scenario_id>/<inhabitant_id>/`

Created on admission. Never copied from another inhabitant.

| File | `schema_version` 1 contents | Writer |
| --- | --- | --- |
| `identity.json` | Admission snapshot. See below. Written once. | Admission only. Never rewritten by restart, profile edits, or dreams. |
| `life.json` | `lifecycle` (`admitted`, `alive`, `absent`, `dead`), `activity` (`awake`, `asleep`, or `null`), timestamps, optional death record `{at, position, evidence}`, optional `identity_mismatch`. | Supervisor and the death path. Activity is rebuilt on process start. Not the dream model. |
| `knowledge.json` | Own home fixtures, public place markers, and `supplies_at_admission`. Written once. The supply list is the manifest at admission, not a live chest. | Admission. Not rewritten on restart. |
| `places.json` | Named coordinates for `!goToPlace`. Starts from `knowledge.json` and keeps later `rememberPlace` calls. | The memory bank, when a village session is bound to this directory. |
| `episodes.json` | Append-only list of `{id, at, kind, source, text, refs, pinned}`. Kinds are `action`, `conversation`, `observed`, `told`. Sources are `verified`, `observed`, `told`, `interpretation`. The dream input is the most recent ~60 unpinned episodes plus any pinned. Rows are not deleted to meet that cap. | Code, from verified outcomes and accepted local perceptions. `!stance` may add an `interpretation` row. |
| `long_term.json` | Up to ~40 `{id, text, priority, source_episode_ids}`. | Dream output after validation. Code may drop low-priority stale rows. |
| `relationships.json` | Map of other ids to `{stance, note, updated_at, source_episode_ids, other_kind, opinion_episode_id}`. `other_kind` is `inhabitant` or `human` when a stance is recorded during play. Seeds omit it. | Seed copied once at admission. Later stance updates require an episode in this directory that names the person. A profile edit does not copy the seed again. |
| `journal.json` | Append-only `{id, at, text, sleep_id, episode_ids}` entries. | Dream commit, one entry per successful sleep id. A retry of the same sleep does not append another. |
| `morning.json` | `{brief, stance, intentions[], sleep_id, at}`. Brief at most ten lines and 800 characters. Intentions are one sentence each, maximum three, and may be empty. | Dream commit. Replaces the previous brief only on success. |
| `intentions.json` | Active personal intention, `waking_decision_at`, and a short history. | `!intention` while awake, or a dream commit when the inhabitant has not already chosen something newer. |
| `craft_ledger.json` | One row per item: `{item, made, recipe, last_outcome}`. | Code from structured craft outcomes. |
| Existing Mindcraft files | `memory.json`, `histories/`, `plan.json`, `verified_lessons.json`, `last_profile.json`. | Existing agents. Stored here, not in `bots/<name>/`, when the scenario supervisor launches them. |

`dream_queue.json` lives on the scenario runtime root, not inside one life. Schema version 1 rows are `{inhabitant_id, sleep_id, status, profile_checksum, enqueued_at}` plus `started_at`, `finished_at`, `error`, and `ready`. `status` is `queued`, `running`, `applied`, or `rejected`. `dream_lease.json` is the cross-process turn. A prepared commit for one sleep lives under that inhabitant's `dream_commits/`, and the model result under `dream_results/`. Milestone 4 runs this queue. A dead life is not given a new dream, and a pending dream is rejected instead of applied.

`life.json` is what every process-start entry point reads before scheduling a start or restart: the scenario launch loop, `AgentProcess`'s exit restart, and MindServer `start-agent` and `restart-agent`. `lifecycle: dead` refuses the start. Missing `life.json` or `identity.json` on a directory that already has episodes is a hard error, not an implicit re-admission.

`activity` is not a lifecycle. `null` means the process is down or the life is not `alive`. A crash clears nothing durable: the next supervisor observation sets `absent` if the life was `alive`, and sets `activity` to `null`. It must not set `dead`.

### Identity snapshot

`identity.json`:

```json
{
  "schema_version": 1,
  "inhabitant_id": "ada",
  "name": "Ada",
  "profile_version": 1,
  "profile_checksum": "<sha256>",
  "admitted_at": "2026-11-15T00:00:00.000Z",
  "scenario_id": "village-alpha",
  "backstory": [],
  "temperament": [],
  "interests": [],
  "seed_relationships": [],
  "home_plot_id": "plot-east"
}
```

`home_plot_id` is the plot whose `occupant` was this id at admission, or `null` if none. It is a copy of that fact, not a second assignment. Later prompts and mismatch checks use this file for identity. They use `village.json` only to detect that the world description still agrees.

### Loader mismatches

On every start of an existing life:

1. Recompute the profile checksum. If it differs from `identity.json`, set `life.identity_mismatch` to `{detected_at, snapshot_checksum, file_checksum, snapshot_profile_version, file_profile_version}` and log it. Do not replace the snapshot. Do not refuse to start solely because of the mismatch. The life continues as the person who was admitted.
2. If the plot that names this id is not `home_plot_id`, or `home_plot_id` is non-null and that plot's `occupant` is no longer this id, record the same kind of mismatch under `life.home_mismatch` and keep the snapshot. Do not move, refill, or clear a house.
3. Do not copy `seed_relationships` again. Do not reprovision supplies.

A bumped `profile_version` is still a mismatch. It is not a migration. Re-admission is a new inhabitant id.

Death record fields are factual: `at`, `position`, `dimension`, `cause`, `server_message`, and `evidence`. `cause` is the server translation key, or `null` when the server did not distinguish one. `evidence.status` is `planned`, `placed`, or `unplaced`, with `reason` when nothing was placed. A journal line about the death is subjective and exists only for inhabitants who received an `observed` or `told` episode.

### Episode rules

- `id` is unique per inhabitant.
- `source` distinguishes a verified action, a direct observation, something someone said, and this inhabitant's interpretation. An interpretation is not a verified fact.
- `refs` may point at a command outcome, a position, a place tag, or another person who was present or speaking. A `told` episode names the speaker and does not by itself count as the listener witnessing the event.
- Another inhabitant's episode id is not a legal `refs` value. A stance may cite this inhabitant's own episode id.
- Command syntax is not stored in `text`. The structured outcome already lives in the action system and the ledger.
- An identical kind, source, text, and refs set is stored once. Movement, queries, and repeated unnamed failures are not episodes.

### Validation the dream cannot bypass

- Reject any patch to `identity.json`, `verified_lessons.json`, `craft_ledger.json`, or `life.lifecycle`.
- Reject a long-term or relationship row whose `source_episode_ids` are missing or unknown.
- A fact that does not overlap the cited episodes, or that invents a motive ("knew I was upset", "to comfort me"), is dropped. The journal may still say how the inhabitant felt.
- Reject inventory counts, command strings, and recipe lines in the journal or brief that disagree with the ledger or the cited episodes.
- Reject a death claim about a third person with no local episode that already contains that cause. Finding a marker with a name is not the same as knowing how that person died.
- If validation fails, keep the previous `morning.json` and append nothing to the journal.

## What stays out of both trees

- Observer-only aggregates (population counts, "who knows about the death") computed at read time from runtime files. They are not written back into any inhabitant file.
- Model prompts. Shared prompt text stays in `profiles/defaults/`. The village inserts identity from `identity.json` at prompt-build time, not from a profile that has drifted since admission.
- The 500-character summary algorithm. Survival sessions still generate it and put it in the decision prompt. A village session leaves the existing string in `memory.json`, does not spend a model call to refresh it, and does not insert it into decision, planning, reflection, or conversation prompts. Recent turns remain the conversational window. It is not `long_term.json`.

## Launch

Implemented. Admission is restart-based. There is no hot add while a scenario process is already running.

```text
node main.js --scenario village-alpha
node main.js --scenario scenarios/village-alpha
```

With `--scenario`, `settings.profiles` are not started and `settings.js` is not modified. Without `--scenario`, `node main.js` is the survival experiment.

To add an inhabitant, add `inhabitants/<id>.json`, list it in `scenario.json`, and optionally set a vacant plot's `occupant` to that id. Start the scenario again. The new directory is created. Existing lives are not recopied. Removing a path from `scenario.json` does not delete `runtime/scenarios/<scenario_id>/<id>/` and does not set `dead`.

Agent files for a village life (memory, histories, plan, verified lessons, last profile, logs, screenshots, action code) are written under `runtime/scenarios/<scenario_id>/<inhabitant_id>/` via `settings.agent_data_root`. The dream model is stored as `settings.dream_model`. The dream client is built only for a claimed sleep job. The day model is the profile `model` passed through the existing prompter merge. Decision prompts append a compact block from the admission snapshot, this inhabitant's home knowledge, the morning brief and stance, the active intention when one exists, a few relationships, and a few episodes. The dream's sixty-episode window is not copied into that block. The 500-character summary stays in `memory.json` and is left out of those prompts.

The autonomous loop is started with a fixed preamble that `usableGoal` does not treat as an ambition. It is not the survival `init_message`.

## Admission

Implemented for files and the one-time copy. Milestone 2 is the world placement.

1. Add `inhabitants/<id>.json` with a unique `id`, Minecraft `name`, and `profile_version`.
2. Optionally set `occupant` on a vacant plot (`null`) to that id. Skip this step to admit someone with no house.
3. List the file in `scenario.json`.
4. On start, if `identity.json` is missing, create the runtime directory, write the snapshot from the profile and the current plot assignment, set `lifecycle` to `admitted`, and copy `seed_relationships` into `relationships.json` once.
5. If `identity.json` exists, skip step 4 entirely. Then load, run the mismatch checks, and do not copy identity, relationships, or supplies.
6. Do not create the directory under `bots/`.
7. Do not read any other inhabitant's runtime directory while building this one's prompt.
8. Connect the process with `scenario.connection`, not with the survival host and port.

Removing a person from `scenario.json` does not delete their runtime directory, does not clear their plot, and does not declare them dead. Death is only `lifecycle` set to `dead` by a verified death of that body, or by a test helper. Deleting or editing the profile does not create a new life for a dead id.

Offline usernames are the Minecraft login. The supervisor will not start a dead life under that name. A different client can still join the offline server with the same name. Do not treat that username or its offline UUID as a credential. Human players continue to join as themselves.
