const settings = {
    "minecraft_version": "1.21.6", // or specific version like "1.21.6"
    "host": "localhost", // or "localhost", "your.ip.address.here"
    "port": 25565, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": false, // opens UI in browser on startup
    
    "base_profile": "survival", // survival, assistant, creative, or god_mode
    "profiles": [
        //"./andy.json",
        "./profiles/agent_01.json",
        "./profiles/agent_02.json",
        "./profiles/agent_03.json",
        "./profiles/agent_04.json",
        "./profiles/agent_05.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.2.json",

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": true, // load memory from previous session
    "init_message": "You are an independent inhabitant of this Minecraft world. Your fundamental purpose is to survive and thrive.\n\nYou and the other inhabitants have arrived in a dangerous, undeveloped world. Your initial shared ambition is to establish a safe, permanent settlement where you can live, store your possessions, obtain food, and protect yourselves from hostile creatures.\n\nYour first priority is to establish a secure place to live. Decide where to build, what resources you need, and how to accomplish this. You may build your own home or cooperate with other inhabitants to create a shared shelter or village.\n\nImprove your tools and equipment when doing so will make your work easier, faster, or safer. Gather resources for specific purposes rather than accumulating them endlessly.\n\nDevelop objectives that can actually be completed. When you have gathered enough materials for an objective, begin using those materials to accomplish it.\n\nLearn from your experiences. When something repeatedly fails, identify the lesson and change your approach. Use !think when you need help solving a problem.\n\nYou are free to choose your own ambitions, relationships, projects, and contributions to the settlement. Seek knowledge from others, share useful discoveries, and cooperate when it benefits you.\n\nOnce you have established safety and basic necessities, pursue whatever ambitions you find meaningful. Continuously improve your life and the world around you.",
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly
    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": true, // show bot's view in browser at localhost:3000, 3001...

    // Persistent, agent-selected plans stored in bots/<name>/plan.json.
    // Adds planning model requests and the !reconsiderPlan command. Part of the
    // shared baseline: every agent plans independently. A profile may still set
    // its own boolean persistent_planning to override this default.
    "persistent_planning": true,

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    // Retrieved conversation demonstrations are appropriate for explicit
    // human requests, but contaminate autonomous/system and peer decisions.
    "allow_retrieved_examples_in_non_human_contexts": false,
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file

    // Separate from routine action requests. Used by !think and by automatic
    // reflection after repeated unsuccessful attempts (auto_*), which is
    // private to the agent and never broadcast. Automatic reflection runs at
    // most once per auto_cooldown_ms per agent and max_concurrent at a time.
    // num_predict is also hard-capped in the Ollama adapter.
    "reasoning": {
        "think": false,
        "keep_alive": -1,
        "timeout_ms": 45000,
        "cooldown_ms": 45000,
        "max_consecutive": 2,
        "max_concurrent": 1,
        "max_predict": 1024,
        "auto_reflection": true,
        "auto_failure_threshold": 2,
        "auto_cooldown_ms": 30000,
        "options": {
            "num_ctx": 8192,
            "num_predict": 1024
        }
    }
};

export default settings;
