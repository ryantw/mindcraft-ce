export class ScenarioError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScenarioError';
    }
}
