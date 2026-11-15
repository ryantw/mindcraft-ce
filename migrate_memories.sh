cd ~/minecraft/mindcraft-ce

DATA=$(docker inspect ai-village \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')

sudo env REPO="$PWD" DATA="$DATA" python3 - <<'PY'
import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from datetime import datetime

NAMES = {
    "Agent_01": "Finn",
    "Agent_02": "Sawyer",
    "Agent_03": "Milo",
    "Agent_04": "Jasper",
    "Agent_05": "Rowan",
}

repo = Path(os.environ["REPO"])
data = Path(os.environ["DATA"])
world = data / "world"
bots = repo / "bots"
profiles = repo / "profiles"

def offline_uuid(name):
    raw = hashlib.md5(
        f"OfflinePlayer:{name}".encode("utf-8")
    ).digest()
    return str(uuid.UUID(bytes=raw, version=3))

# Replace complete agent names inside JSON data.
pattern = re.compile(
    r"\b(" + "|".join(map(re.escape, NAMES)) + r")\b"
)

def replace_names(value):
    if isinstance(value, str):
        return pattern.sub(
            lambda m: NAMES[m.group(0)], value
        )
    if isinstance(value, list):
        return [replace_names(v) for v in value]
    if isinstance(value, dict):
        return {
            replace_names(k): replace_names(v)
            for k, v in value.items()
        }
    return value

def read_json(path):
    return json.loads(path.read_text())

def write_json(path, obj):
    path.write_text(
        json.dumps(obj, indent=2, ensure_ascii=False)
        + "\n"
    )

# -------------------------------------------------
# 1. PREFLIGHT: verify everything before modifying.
# -------------------------------------------------

if not os.environ["DATA"]:
    raise SystemExit("ERROR: Minecraft data mount not found.")

if not (world / "playerdata").is_dir():
    raise SystemExit(f"ERROR: Missing {world}/playerdata")

profile_files = {}
world_moves = []

for old, new in NAMES.items():
    number = old.split("_")[1]
    profile = profiles / f"agent_{number}.json"

    if not profile.is_file():
        raise SystemExit(f"ERROR: Missing profile {profile}")

    profile_data = read_json(profile)

    if profile_data.get("name") not in (old, new):
        raise SystemExit(
            f"ERROR: Unexpected name in {profile}"
        )

    profile_files[old] = profile

    if not (bots / old / "memory.json").is_file():
        raise SystemExit(f"ERROR: Missing memory for {old}")

    if (bots / new).exists():
        raise SystemExit(
            f"ERROR: {bots / new} already exists. "
            "Stopping to avoid overwriting memories."
        )

    old_id = offline_uuid(old)
    new_id = offline_uuid(new)

    print(f"{old} -> {new}")
    print(f"  Old UUID: {old_id}")
    print(f"  New UUID: {new_id}")

    player_file = world / "playerdata" / f"{old_id}.dat"

    if not player_file.is_file():
        raise SystemExit(
            f"ERROR: Missing player data: {player_file}\n"
            "Cannot verify offline UUID. No changes made."
        )

    for directory, suffix in [
        ("playerdata", ".dat"),
        ("playerdata", ".dat_old"),
        ("stats", ".json"),
        ("advancements", ".json"),
    ]:
        source = world / directory / f"{old_id}{suffix}"
        target = world / directory / f"{new_id}{suffix}"

        if target.exists():
            raise SystemExit(
                f"ERROR: Destination already exists: {target}"
            )

        if source.exists():
            world_moves.append((source, target))

# -------------------------------------------------
# 2. BACKUP
# -------------------------------------------------

timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = repo.parent / f"mindcraft-rename-backup-{timestamp}"

backup.mkdir()

shutil.copytree(bots, backup / "bots")
shutil.copytree(profiles, backup / "profiles")

if (repo / "settings.js").exists():
    shutil.copy2(repo / "settings.js", backup / "settings.js")

for directory in ("playerdata", "stats", "advancements"):
    source = world / directory
    if source.exists():
        shutil.copytree(source, backup / directory)

print(f"\nBackup created: {backup}")

# -------------------------------------------------
# 3. RENAME PROFILES AND MINDCRAFT MEMORIES
# -------------------------------------------------

for old, new in NAMES.items():
    profile = profile_files[old]
    profile_data = replace_names(read_json(profile))
    profile_data["name"] = new

    write_json(profile, profile_data)

    old_dir = bots / old
    new_dir = bots / new

    old_dir.rename(new_dir)

    memory_file = new_dir / "memory.json"
    memory = replace_names(read_json(memory_file))

    # End any stale conversation from the previous session.
    # Conversation history remains intact.
    memory["last_sender"] = None

    # Resume autonomous activity when a saved goal exists.
    if memory.get("self_prompt"):
        memory["self_prompting_state"] = 1

    write_json(memory_file, memory)

    # Update the cached profile, if present.
    last_profile = new_dir / "last_profile.json"
    if last_profile.exists():
        write_json(
            last_profile,
            replace_names(read_json(last_profile))
        )

    print(f"Mindcraft migrated: {old} -> {new}")

# -------------------------------------------------
# 4. MIGRATE MINECRAFT PLAYER DATA
# -------------------------------------------------

for source, target in world_moves:
    source.rename(target)
    print(f"Minecraft migrated: {source.name} -> {target.name}")

print("\nSUCCESS: All five agents migrated.")
print(f"Backup: {backup}")
print("You can now restart Minecraft and Mindcraft.")
PY

