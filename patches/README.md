# Minecraft movement patches

Movement dependencies are pinned in `package-lock.json`. `npm ci` applies these
patches automatically and fails if a patch no longer applies. After upgrading a
patched package, compare its upstream source before rebasing or removing the patch.

## Pathfinder 2.4.5

This is the latest published npm release checked on September 30, 2026. The patch
backports the following changes from PrismarineJS master:

- [Unreachable and partial path results, and idle stop handling](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/375)
  (`84c3bd29a7fb`). An empty failed search must reject; a partial search must keep
  waiting. Calling stop while idle must not cancel the next action.
- [Door and gate waypoint processing](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/372)
  (`e37bff8992dd`). Interaction nodes use the floor center, and opening a door
  does not prevent later waypoints from being processed.
- [Correct placement exclusion block](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/351)
  (`874949196ac1`).
- [Pass the node to GoalBreakBlock.isEnd](https://github.com/PrismarineJS/mineflayer-pathfinder/commit/d69a02904bc8).

Local changes clear a rejected goal, enable wooden doors and fence gates, finish
door interaction state, release jump after placement, and allow escape from lava
while restoring lava avoidance after leaving it. Vine climbing is restricted to
the normal vines supported by the installed physics engine.

`pathfinder.stop()` still does nothing when no goal, path, dig, or placement is
active, so an idle stop cannot cancel the next movement. When something is
active, the stop flag is consumed immediately. Leaving it until the next path
node meant a stuck, digging, placing, or dead bot never emitted `path_stop`,
and the `goto()` promise never settled.

A search that hits its time budget with a usable prefix is walked, then the
search continues from there. Previously that result rejected `goto()`, so the
bot stood still, discarded the route, and retried the same target. An empty
timeout or a confirmed `noPath` still rejects.

The old fake block-state write before placement, tightened waypoint tolerance,
and two-block climbing shortcuts have been removed. Paths use confirmed world
state and upstream movement constraints.

## Collectblock 1.6.0

The plugin must preserve the supplied movement safety settings. It previously
disabled liquid and falling-block checks each time collection started.

For ore completely surrounded by stone, `GoalLookAtBlock` cannot find a visible
face in the current world. If its search returns `NoPath`, collection first
approaches an adjacent position with `GoalGetToBlock`, letting pathfinder tunnel
to the ore. It then checks visibility and reach again before harvesting.

Cancellation subscribes to `collectBlock_finished` once, clears the target list,
and stops pathfinder immediately. Repeated `cancelTask()` calls share that wait
instead of adding another listener. Item pickup no longer waits forever for
`entityGone` after the bot has already arrived, and the post-dig drop wait gives
up if physics ticks stop or cancellation is requested.

## Mineflayer 4.39.0

The former 4.37.1 placement-timeout patch has been removed. The current upstream
implementation detects rejected placement and waits for server responses. A
500 ms timeout and speculative block state would undermine that confirmation.

`bot.dig()` installs `stopDigging()` only after `lookAt()` resolves. `look()`
waits for a movement packet, so a stationary or dead bot never finished looking
and could not abort the dig. `stopDigging()` during that look now marks the dig
aborted; the caller still has to force-finish `look()` so the abort is observed.

The 4.39.0 crafting patch confirms modern crafting clicks with authoritative
window snapshots instead of waiting for a result-slot change that the server
may not send. Inventory-grid crafts also confirm the final put-away click,
just as crafting-table crafts do. Original errors retain their stack traces.

Fishing exposes a cancellation method that retracts the rod and settles the
pending fishing promise. Call `bot.stopFishing()` before another action takes
ownership of the bot.

## PVP 1.3.2

Combat follows the current `physicsTick` event. Its stop handler registers before
requesting a path stop, keeps other plugins' listeners, and only clears the goal
belonging to that attack. A delayed stop timeout cannot cancel a newer movement
command. Stopping or force-stopping also invalidates pending attack requests so
they cannot restart combat after interruption.

## Prismarine-item 1.18.0

Modern enchantment components contain registry IDs and levels inside an
`enchantments` field. The getter normalizes them to the name/level array expected
by Mineflayer and prismarine-block, including stored book enchantments. This
prevents enchanted mining tools from throwing during dig-time calculation and
allows callers to distinguish Silk Touch from Fortune.
