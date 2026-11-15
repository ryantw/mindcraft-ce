/**
 * Start one disposable inhabitant on the smoke world.
 * Refuses Village Alpha and any port other than 25567.
 * A second offline client stays awake and never sleeps.
 *
 * Usage: node scripts/village/smoke-one.js [inhabitant-id]
 */
import mineflayer from 'mineflayer';
import settings from '../../settings.js';
import * as Mindcraft from '../../src/mindcraft/mindcraft.js';
import { loadScenario } from '../../src/village/load.js';
import { prepareScenario } from '../../src/village/launch.js';

const SCENARIO = 'scenarios/village-m3-smoke';
const ONLY = process.argv[2] || 'wynn';

const bundle = loadScenario(SCENARIO, { reservedNames: [], forLaunch: true });
if (bundle.scenario.id !== 'village-m3-smoke') throw new Error('Refusing to start any scenario except village-m3-smoke.');
if (bundle.scenario.connection.port !== 25567) throw new Error('Refusing a smoke launch that is not on 127.0.0.1:25567.');
if (bundle.scenario.connection.host !== '127.0.0.1') throw new Error('Refusing a smoke launch that is not bound to 127.0.0.1.');

const prepared = prepareScenario(bundle, settings);
const agents = prepared.agents.filter(agent => agent.village_inhabitant_id === ONLY);
if (agents.length !== 1) throw new Error(`Expected one launchable inhabitant named ${ONLY}.`);

await Mindcraft.init(false, settings.mindserver_port, false);

const awake = mineflayer.createBot({
    host: '127.0.0.1',
    port: 25567,
    username: 'Visitor',
    auth: 'offline',
    version: '1.21.6',
});
awake.on('spawn', () => console.log('[Visitor] Awake and staying out of bed.'));
awake.on('error', error => console.error(`[Visitor] ${error.message}`));
awake.on('sleep', () => console.error('[Visitor] Unexpected sleep. Leaving the bed.'));
awake.on('end', () => console.log('[Visitor] Disconnected.'));

const result = await Mindcraft.createAgent(agents[0]);
if (!result.success) {
    console.error(`Failed to create ${ONLY}: ${result.error}`);
    process.exit(1);
}
console.log(`[smoke-one] ${ONLY} started on 127.0.0.1:25567. Visitor remains awake.`);
