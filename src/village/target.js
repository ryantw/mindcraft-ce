import path from 'path';
import { ScenarioError } from './errors.js';

function fail(message) {
    throw new ScenarioError(message);
}

/**
 * Refuse any provisioning target that is the survival server, publishes the
 * game or RCON port on a non-loopback address, or writes the survival world.
 */
export function assertProvisionTarget({
    scenarioPort,
    survivalPort,
    dataDir,
    survivalDataDir,
    containerName,
    publishedPorts,
}) {
    if (scenarioPort === survivalPort) {
        fail(`Refusing to provision port ${scenarioPort}. That is the survival server port.`);
    }
    if (containerName === 'ai-village') fail('Refusing to provision container ai-village. That is the survival server.');
    const data = path.resolve(dataDir);
    const survival = path.resolve(survivalDataDir);
    if (data === survival || data.startsWith(survival + path.sep)) {
        fail(`Refusing to provision ${data}. That is the survival world directory.`);
    }
    if (!Array.isArray(publishedPorts) || publishedPorts.length < 1) {
        fail('Refusing to provision a server whose published ports could not be read.');
    }
    for (const binding of publishedPorts) {
        if (binding.hostPort === survivalPort) {
            fail(`Refusing to provision a server published on survival port ${survivalPort}.`);
        }
        if (binding.hostIp !== '127.0.0.1') {
            fail(`Refusing to provision ${binding.hostIp}:${binding.hostPort}. Game and RCON ports must stay on 127.0.0.1.`);
        }
    }
    const game = publishedPorts.find(binding => binding.containerPort === 25565);
    const rcon = publishedPorts.find(binding => binding.containerPort === 25575);
    if (!game || game.hostPort !== scenarioPort) {
        fail(`Village game port must be published as 127.0.0.1:${scenarioPort}.`);
    }
    if (!rcon) fail('Village RCON must be published on 127.0.0.1 and must not be left unexposed-by-accident on every interface.');
    return { dataDir: data, gamePort: game.hostPort, rconPort: rcon.hostPort };
}
