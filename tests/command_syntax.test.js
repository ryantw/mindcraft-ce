import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAttempt, getCommandDocs, normalizeCommandMessage, parseCommandMessage, truncCommandMessage } from '../src/agent/commands/index.js';
import { blockingRepeatCount, makeValidationOutcome, updateRepeatCounts } from '../src/agent/action_outcome.js';
import { initializeMinecraftData } from '../src/utils/mcdata.js';

initializeMinecraftData('1.21.6');

test('unquoted and spaced arguments are the same command as the quoted form', () => {
    const quoted = parseCommandMessage('!placeHere("cobblestone")');
    for (const message of ['!placeHere(cobblestone)', '!placeHere "cobblestone"', '!placeHere cobblestone']) {
        const parsed = parseCommandMessage(message);
        assert.equal(typeof parsed, 'object', message);
        assert.deepEqual(parsed.args, quoted.args, message);
    }
    assert.deepEqual(parseCommandMessage('!digDown 4').args, [4]);
    assert.deepEqual(parseCommandMessage('!goToPlayer(Finn, 10)').args, ['Finn', 10]);
    assert.deepEqual(parseCommandMessage('!placeBlockAt(acacia_planks, 1201, 65, 625)').args, ['acacia_planks', 1201, 65, 625]);
    assert.equal(truncCommandMessage('I will !digDown 4 now'), 'I will !digDown(4)');
    assert.equal(normalizeCommandMessage('!placeHere(cobblestone)'), '!placeHere("cobblestone")');
});

test('a command name with no arguments is still rejected and tells the model the form', () => {
    const parsed = parseCommandMessage('!placeBlockAt');
    assert.match(parsed, /was given 0 args/);
    assert.match(parsed, /!placeBlockAt\(type:string, x:number, y:number, z:number\)/);
    const attempt = describeAttempt('!buildPlane');
    assert.equal(attempt.parsedOk, false);
    assert.equal(attempt.missingArguments, true);
    const docs = getCommandDocs({ blocked_actions: [], plan_manager: { enabled: false } });
    assert.match(docs, /invalid without them/);
    assert.doesNotMatch(docs, /syntax: !commandName or !commandName/);
});

test('bare placeBlockAt, buildPlane, and buildLine count as one missing-argument mistake', () => {
    const counts = new Map();
    for (const name of ['!placeBlockAt', '!buildPlane', '!buildLine']) {
        const outcome = makeValidationOutcome({
            agent: { bot: null },
            commandName: name,
            message: `Command ${name} was given 0 args, but requires 4 args.`,
            signature: `${name}(...)`,
        });
        updateRepeatCounts(counts, name, { structuredOutcome: outcome, failed: true, behaviorKey: outcome.behaviorKey });
    }
    assert.equal(counts.get('validation:missing_arguments'), 3);
    assert.equal(blockingRepeatCount(counts, {
        commandKey: '!placeHere',
        commandName: '!placeHere',
        action: 'placeHere',
        params: {},
        parsedOk: false,
        missingArguments: true,
    }), 3);
    updateRepeatCounts(counts, '!nearbyBlocks', {
        structuredOutcome: { relevantProgress: true, behaviorKey: null, details: {} },
        failed: false,
    });
    assert.equal(counts.get('validation:missing_arguments'), undefined);
});
