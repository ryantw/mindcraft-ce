import path from 'path';
import { loadScenario, resolveScenarioDirectory } from '../../src/village/load.js';
import { inhabitantRuntimeDir } from '../../src/village/admit.js';
import { readLife } from '../../src/village/life.js';
import { inspectRemainsSite, placeConfiguredRemains } from '../../src/village/remains.js';

/**
 * Retry remains for a deceased inhabitant. Does not change lifecycle, cause,
 * time, or position. Prints the plan unless --execute is present.
 *
 *   node scripts/village/recover-remains.js --scenario village-alpha --inhabitant rufus
 *   node scripts/village/recover-remains.js --scenario village-alpha --inhabitant rufus --execute
 *   node scripts/village/recover-remains.js --scenario village-alpha --inhabitant rufus --inspect
 */
function arg(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

const scenarioId = arg('--scenario');
const inhabitantId = arg('--inhabitant');
if (!scenarioId || !inhabitantId) {
    console.error('Usage: node scripts/village/recover-remains.js --scenario <id> --inhabitant <id> [--execute]');
    process.exit(1);
}

const bundle = loadScenario(resolveScenarioDirectory(scenarioId), { forLaunch: false, reservedNames: [] });
const directory = inhabitantRuntimeDir(path.join('runtime', 'scenarios'), bundle.scenario.id, inhabitantId);
const life = readLife(directory);
if (!life || life.lifecycle !== 'dead' || !life.death?.position) {
    console.error(`No durable death at ${directory}`);
    process.exit(2);
}
const profile = bundle.inhabitants.find(person => person.id === inhabitantId);
const name = profile?.name;
if (!name) {
    console.error(`Scenario ${bundle.scenario.id} has no inhabitant '${inhabitantId}'.`);
    process.exit(2);
}
const position = life.death.position;
console.log(JSON.stringify({
    inhabitant: inhabitantId,
    name,
    lifecycle: life.lifecycle,
    at: life.death.at,
    cause: life.death.cause,
    position,
    evidence: life.death.evidence,
    container: bundle.scenario.settings.remains_container || null,
}, null, 2));
if (process.argv.includes('--inspect')) {
    const choice = inspectRemainsSite({
        village_remains_container: bundle.scenario.settings.remains_container || null,
        village_scenario_id: bundle.scenario.id,
        position,
    });
    console.log(JSON.stringify({ inspect: choice }, null, 2));
    console.log('Inspected only. No marker was summoned and life.json was not written.');
    process.exit(choice?.place ? 0 : 3);
}
if (!process.argv.includes('--execute')) {
    console.log('Not executed. Pass --inspect to read the column, or --execute to retry placement. The inhabitant stays dead.');
    process.exit(0);
}

const evidence = placeConfiguredRemains({
    village_remains_container: bundle.scenario.settings.remains_container || null,
    village_scenario_id: bundle.scenario.id,
    agent_data_root: directory,
    profile: { name },
});
console.log(JSON.stringify(evidence, null, 2));
if (evidence?.status !== 'placed') process.exit(3);
