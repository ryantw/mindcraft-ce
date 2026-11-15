import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { setSettings } from '../src/agent/settings.js';
import { appendEpisode } from '../src/village/episodes.js';
import { writeLife } from '../src/village/life.js';
import { noteSleepEdge, makeSleepId } from '../src/village/sleep.js';
import {
    enqueueSleep,
    holdLease,
    readQueue,
    claimNext,
    MIN_SLEEP_GAP_MS,
} from '../src/village/dream_queue.js';
import { buildDreamInput } from '../src/village/dream_input.js';
import { validateDreamOutput } from '../src/village/dream_validate.js';
import { commitDream, planConsolidation } from '../src/village/dream_commit.js';
import { tickDreams, dreamCallOptions, applyReadyDreams, intentionFollowUp, requestDream } from '../src/village/dream_scheduler.js';
import { updateIntention, readIntentions } from '../src/village/intentions.js';
import { orientFirstDay } from '../src/village/orientation.js';
import { renderVillageContext } from '../src/village/context.js';
import { adaptVillagePrompt, villagePlanPrompt } from '../src/village/voice.js';
import { situationReport } from '../src/agent/reasoning.js';
import { getCommandDocs, parseCommandMessage } from '../src/agent/commands/index.js';
import { blockingRepeatCount, resourceAttemptKey, updateRepeatCounts } from '../src/agent/action_outcome.js';
import { villageSpokenWords } from '../src/agent/chat_hygiene.js';
import { activityNeedsPlan } from '../src/agent/startup_goal.js';

const NOW = '2026-11-15T18:00:00.000Z';

function tempRoot() {
    return mkdtempSync(path.join(os.tmpdir(), 'village-dreams-'));
}

function inhabitant(root, id, { life = 'alive', checksum = 'checksum-1' } = {}) {
    const dir = path.join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({
        schema_version: 1,
        inhabitant_id: id,
        name: id[0].toUpperCase() + id.slice(1),
        profile_version: 1,
        profile_checksum: checksum,
        backstory: [{ id: 'self', text: `${id} keeps a private chest and likes quiet mornings.` }],
        temperament: ['Speaks briefly.'],
        interests: ['doorway flowers'],
        seed_relationships: [],
        home_plot_id: `plot-${id}`,
    }, null, 2));
    writeLife(dir, {
        schema_version: 1,
        lifecycle: life,
        activity: 'awake',
        admitted_at: NOW,
        updated_at: NOW,
        identity_mismatch: null,
        home_mismatch: null,
        death: null,
    });
    writeFileSync(path.join(dir, 'knowledge.json'), JSON.stringify({
        schema_version: 1,
        home: {
            plot_id: `plot-${id}`,
            home_marker: [1, 64, 1],
            bed: [2, 64, 1],
            chest: [3, 64, 1],
            door: [0, 64, 1],
            crafting_table: [4, 64, 1],
            furnace: [5, 64, 1],
        },
        public_places: [{ id: 'square', marker: [10, 64, 10] }],
        supplies_at_admission: [{ item: 'bread', count: 4 }],
    }, null, 2));
    writeFileSync(path.join(dir, 'verified_lessons.json'), JSON.stringify({
        version: 1,
        lessons: [{ id: 'bread', text: 'Crafted bread from 3 wheat.', basis: 'mechanics' }],
    }, null, 2));
    return dir;
}

function goodDream(episodeId) {
    return {
        journal: 'I sat with the day and felt unsure what the quiet meant. I am not in a hurry.',
        brief: 'The house was quiet.\nI may walk to the square.',
        stance: 'I would rather look than rush.',
        intentions: ['Walk to the square and see who is there.'],
        memories: [{
            op: 'upsert',
            kind: 'interpretation',
            text: 'The day felt quiet.',
            priority: 2,
            source_episode_ids: [episodeId],
        }],
        relationships: [],
    };
}

test('actual sleep opens one session; a failed sleep does not', () => {
    const state = { session: null };
    const bot = { time: { day: 3, timeOfDay: 13000 }, entity: { position: { x: 2.2, y: 64, z: 1.4 } }, isSleeping: false };
    assert.equal(noteSleepEdge(state, false, () => makeSleepId('ada', bot)).edge, 'idle');
    assert.equal(state.session, null);
    bot.isSleeping = true;
    const first = noteSleepEdge(state, true, () => makeSleepId('ada', bot, 1000));
    assert.equal(first.edge, 'asleep');
    const again = noteSleepEdge(state, true, () => makeSleepId('ada', bot, 2000));
    assert.equal(again.edge, 'still');
    assert.equal(again.session.id, first.session.id);
    assert.match(first.session.id, /^sleep-ada-d3-t13000-b2_64_1-1000$/);
});

test('repeated polling and a rapid second sleep do not duplicate a dream', () => {
    const root = tempRoot();
    try {
        inhabitant(root, 'ada');
        const first = enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-ada-1', profileChecksum: 'checksum-1', life: 'alive', now: 1_000, minGapMs: MIN_SLEEP_GAP_MS,
        });
        assert.equal(first.enqueued, true);
        for (let i = 0; i < 5; i++) {
            const again = enqueueSleep(root, {
                inhabitantId: 'ada', sleepId: 'sleep-ada-1', profileChecksum: 'checksum-1', life: 'alive', now: 1_000 + i, minGapMs: MIN_SLEEP_GAP_MS,
            });
            assert.equal(again.reason, 'duplicate-session');
        }
        const queued = enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-ada-3', profileChecksum: 'checksum-1', life: 'alive', now: 1_000 + MIN_SLEEP_GAP_MS + 5, minGapMs: MIN_SLEEP_GAP_MS,
        });
        assert.equal(queued.reason, 'in-progress');
        const queue = readQueue(root);
        queue.jobs[0].status = 'applied';
        writeFileSync(path.join(root, 'dream_queue.json'), JSON.stringify(queue));
        const rapid = enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-ada-2', profileChecksum: 'checksum-1', life: 'alive', now: 2_000, minGapMs: MIN_SLEEP_GAP_MS,
        });
        assert.equal(rapid.reason, 'rapid-cycle');
        assert.equal(readQueue(root).jobs.length, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a pending dream survives a reread after the writer is gone', () => {
    const root = tempRoot();
    try {
        inhabitant(root, 'ada');
        enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-ada-keep', profileChecksum: 'checksum-1', life: 'alive', now: 5_000, minGapMs: 0,
        });
        const reloaded = readQueue(root);
        assert.equal(reloaded.jobs.length, 1);
        assert.equal(reloaded.jobs[0].status, 'queued');
        assert.equal(reloaded.jobs[0].sleep_id, 'sleep-ada-keep');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a dead holder does not keep the dream lease', () => {
    const root = tempRoot();
    try {
        inhabitant(root, 'ada');
        enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-ada-crash', profileChecksum: 'checksum-1', life: 'alive', now: 5_000, minGapMs: 0,
        });
        const queue = readQueue(root);
        queue.jobs[0].status = 'running';
        writeFileSync(path.join(root, 'dream_queue.json'), JSON.stringify(queue));
        writeFileSync(path.join(root, 'dream_lease.json'), JSON.stringify({
            holder: 'ada',
            inhabitant_id: 'ada',
            sleep_id: 'sleep-ada-crash',
            pid: 2_147_483_647,
            expires_at: '2099-01-01T00:00:00.000Z',
        }));
        const claim = claimNext(root, 'ada', { now: Date.now(), isDead: () => false });
        assert.equal(claim.claimed, true);
        assert.equal(claim.job.sleep_id, 'sleep-ada-crash');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('dream calls from separate processes do not overlap', async () => {
    const root = tempRoot();
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/village/dream_queue.js')).href;
    const code = `
      import { holdLease } from ${JSON.stringify(moduleUrl)};
      const result = await holdLease(${JSON.stringify(root)}, process.env.HOLDER, 200);
      console.log(JSON.stringify(result));
    `;
    const run = (holder) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
            env: { ...process.env, HOLDER: holder },
        });
        let out = '';
        let err = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { err += chunk; });
        child.on('exit', (status) => {
            if (status !== 0) reject(new Error(err || out));
            else resolve(JSON.parse(out.trim().split('\n').pop()));
        });
    });
    try {
        const [a, b] = await Promise.all([run('ada'), run('ben')]);
        const overlap = a.start < b.end && b.start < a.end;
        assert.equal(overlap, false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('waking before the dream returns does not change memory or block the caller', async () => {
    const root = tempRoot();
    try {
        const dir = inhabitant(root, 'ada');
        const episode = appendEpisode(dir, { kind: 'observed', source: 'observed', text: 'I found a marker reading Nia.', refs: ['Nia'] });
        writeFileSync(path.join(dir, 'morning.json'), JSON.stringify({
            schema_version: 1, brief: 'Yesterday I was content.', stance: 'steady', intentions: [], sleep_id: 'old', at: NOW,
        }));
        enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-ada-late', profileChecksum: 'checksum-1', life: 'alive', now: 10_000, minGapMs: 0,
        });
        let release;
        const pending = tickDreams({
            scenarioRoot: root,
            actorId: 'ada',
            allowApply: true,
            gapMs: 0,
            client: () => new Promise(resolve => { release = resolve; }),
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        const mid = readFileSync(path.join(dir, 'morning.json'), 'utf8');
        assert.match(mid, /Yesterday I was content/);
        assert.equal(existsSync(path.join(dir, 'journal.json')), false);
        release({
            ok: true,
            validated: goodDream(episode.episode.id),
            episodeIds: [episode.episode.id],
            input_chars: 40,
            prompt_tokens: 3,
            generated_tokens: 4,
            duration_ms: 5,
        });
        const done = await pending;
        assert.equal(done.action, 'applied');
        const journal = JSON.parse(readFileSync(path.join(dir, 'journal.json'), 'utf8'));
        assert.equal(journal.entries.length, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('dream input is only that inhabitant, with a cutoff', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const ben = inhabitant(root, 'ben');
        writeFileSync(path.join(ben, 'journal.json'), JSON.stringify({ entries: [{ text: 'SECRET-BEN-JOURNAL' }] }));
        writeFileSync(path.join(root, 'deaths.json'), JSON.stringify({ cause: 'SECRET-SKELETON-KILL' }));
        const life = JSON.parse(readFileSync(path.join(ben, 'life.json'), 'utf8'));
        life.death = { cause: 'death.attack.skeleton', server_message: 'SECRET-SKELETON-KILL' };
        writeFileSync(path.join(ben, 'life.json'), JSON.stringify(life));
        const first = appendEpisode(ada, { kind: 'observed', source: 'observed', text: 'I found a marker reading Nia.', refs: ['Nia'] });
        const second = appendEpisode(ada, { kind: 'conversation', source: 'observed', text: 'Holt said the square was empty.', refs: ['Holt'] });
        const input = buildDreamInput(ada, { cutoffIndex: 1, sleepId: 'sleep-ada-1' });
        assert.equal(input.episodeIds.includes(first.episode.id), true);
        assert.equal(input.episodeIds.includes(second.episode.id), false);
        assert.equal(input.text.includes('SECRET-BEN-JOURNAL'), false);
        assert.equal(input.text.includes('SECRET-SKELETON-KILL'), false);
        assert.equal(input.text.includes('death.attack.skeleton'), false);
        assert.match(input.text, /marker reading Nia/);
        assert.equal(input.text.includes('Holt said'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('invalid output cannot rewrite identity, life, lessons, or another mind', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const ben = inhabitant(root, 'ben');
        const episode = appendEpisode(ada, { kind: 'observed', source: 'observed', text: 'Jasper gave me bread.', refs: ['jasper'] });
        const beforeIdentity = readFileSync(path.join(ada, 'identity.json'));
        const beforeLife = readFileSync(path.join(ada, 'life.json'));
        const beforeLessons = readFileSync(path.join(ada, 'verified_lessons.json'));
        const beforeBen = readFileSync(path.join(ben, 'identity.json'));
        const raw = {
            journal: 'The bread recipe is 3 dirt and a skeleton killed Nia.',
            brief: 'I should remember the recipe.',
            identity: { backstory: [{ id: 'self', text: 'replaced' }] },
            life: { lifecycle: 'dead' },
            inventory: { bread: 99 },
            memories: [],
            intentions: [],
        };
        const validated = validateDreamOutput(raw, {
            episodes: [episode.episode],
            verifiedFacts: ['Crafted bread from 3 wheat.'],
            identityName: 'Ada',
        });
        assert.equal(validated.ok, false);
        assert.equal(existsSync(path.join(ada, 'journal.json')), false);
        assert.deepEqual(readFileSync(path.join(ada, 'identity.json')), beforeIdentity);
        assert.deepEqual(readFileSync(path.join(ada, 'life.json')), beforeLife);
        assert.deepEqual(readFileSync(path.join(ada, 'verified_lessons.json')), beforeLessons);
        assert.deepEqual(readFileSync(path.join(ben, 'identity.json')), beforeBen);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a subjective motive does not become an authoritative fact', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const episode = appendEpisode(ada, { kind: 'observed', source: 'observed', text: 'Jasper gave me bread.', refs: ['jasper'] });
        const validated = validateDreamOutput({
            journal: 'I felt appreciated when Jasper gave me bread. I do not know why.',
            brief: 'Jasper gave me bread.\nI felt appreciated.',
            stance: 'A little warmer toward the day.',
            intentions: [],
            memories: [{
                op: 'upsert',
                kind: 'fact',
                text: 'Jasper knew I was upset and gave me bread to comfort me.',
                priority: 4,
                source_episode_ids: [episode.episode.id],
            }],
        }, { episodes: [episode.episode], identityName: 'Ada' });
        assert.equal(validated.ok, true);
        assert.equal(validated.value.memories.length, 0);
        const commit = commitDream(ada, {
            sleepId: 'sleep-ada-feel',
            profileChecksum: 'checksum-1',
            validated: validated.value,
            episodeIds: [episode.episode.id],
            now: NOW,
        });
        assert.equal(commit.applied, true);
        const bank = JSON.parse(readFileSync(path.join(ada, 'long_term.json'), 'utf8'));
        assert.equal(JSON.stringify(bank).includes('knew I was upset'), false);
        const journal = JSON.parse(readFileSync(path.join(ada, 'journal.json'), 'utf8'));
        assert.match(journal.entries[0].text, /felt appreciated/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a successful dream writes one journal entry and a retry does not write another', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const episode = appendEpisode(ada, { kind: 'action', source: 'verified', text: 'I walked home.', refs: ['home'] });
        appendEpisode(ada, { kind: 'observed', source: 'observed', text: 'After I was already dreaming, a bird passed.', refs: ['bird'] });
        const validated = goodDream(episode.episode.id);
        const input = {
            sleepId: 'sleep-ada-once',
            profileChecksum: 'checksum-1',
            validated,
            episodeIds: [episode.episode.id],
            enqueuedAt: '2026-11-15T17:00:00.000Z',
            now: NOW,
        };
        const prepared = planConsolidation(ada, input);
        mkdirSync(path.join(ada, 'dream_commits'), { recursive: true });
        writeFileSync(path.join(ada, 'dream_commits', 'sleep-ada-once.json'), JSON.stringify({ ...prepared, phase: 'prepared' }, null, 2));
        const first = commitDream(ada, input);
        const second = commitDream(ada, input);
        assert.equal(first.applied, true);
        assert.equal(second.duplicate, true);
        const journal = JSON.parse(readFileSync(path.join(ada, 'journal.json'), 'utf8'));
        assert.equal(journal.entries.length, 1);
        assert.equal(journal.entries[0].sleep_id, 'sleep-ada-once');
        const episodes = JSON.parse(readFileSync(path.join(ada, 'episodes.json'), 'utf8'));
        const walked = episodes.episodes.find(item => item.id === episode.episode.id);
        const bird = episodes.episodes.find(item => item.text.includes('bird'));
        assert.equal(walked.consolidated_by, 'sleep-ada-once');
        assert.equal(bird.consolidated_by, undefined);
        const morning = JSON.parse(readFileSync(path.join(ada, 'morning.json'), 'utf8'));
        assert.ok(morning.brief.split('\n').length <= 10);
        assert.equal(morning.intentions.length, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a dead inhabitant is not given a dream and a failed model keeps the old brief', async () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        writeFileSync(path.join(ada, 'morning.json'), JSON.stringify({
            schema_version: 1, brief: 'Keep this brief.', stance: 'steady', intentions: ['Sit by the door.'], sleep_id: 'old', at: NOW,
        }));
        const dead = enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-dead', profileChecksum: 'checksum-1', life: 'dead', now: 1,
        });
        assert.equal(dead.reason, 'dead');
        enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-fail', profileChecksum: 'checksum-1', life: 'alive', now: 2, minGapMs: 0,
        });
        const failed = await tickDreams({
            scenarioRoot: root,
            actorId: 'ada',
            allowApply: true,
            gapMs: 0,
            client: async () => { throw new Error('Dream model unavailable. model missing'); },
        });
        assert.equal(failed.action, 'rejected');
        assert.match(readFileSync(path.join(ada, 'morning.json'), 'utf8'), /Keep this brief/);
        assert.equal(existsSync(path.join(ada, 'journal.json')), false);
        const life = JSON.parse(readFileSync(path.join(ada, 'life.json'), 'utf8'));
        life.lifecycle = 'dead';
        writeFileSync(path.join(ada, 'life.json'), JSON.stringify(life));
        enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-after-death', profileChecksum: 'checksum-1', life: 'alive', now: 50_000, minGapMs: 0,
        });
        const refused = commitDream(ada, {
            sleepId: 'sleep-after-death',
            profileChecksum: 'checksum-1',
            validated: goodDream('ep-0001'),
            episodeIds: [],
            now: NOW,
        });
        assert.equal(refused.reason, 'dead');
        const queued = readQueue(root).jobs.filter(job => job.status === 'queued' || job.status === 'running');
        if (queued.length) {
            await tickDreams({ scenarioRoot: root, actorId: 'ada', allowApply: true, gapMs: 0, client: async () => ({ ok: true, validated: goodDream('ep-0001'), episodeIds: [] }) });
        }
        assert.equal(existsSync(path.join(ada, 'journal.json')), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('morning context is bounded and is not the episode archive', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        for (let i = 0; i < 80; i++) {
            appendEpisode(ada, { kind: 'observed', source: 'observed', text: `ARCHIVE-LINE-${i} something ordinary happened.`, refs: [] });
        }
        writeFileSync(path.join(ada, 'morning.json'), JSON.stringify({
            schema_version: 1,
            brief: 'The square was quiet.\nI might visit later.',
            stance: 'Unhurried.',
            intentions: ['Look at the square.'],
            sleep_id: 'sleep-1',
            at: NOW,
        }));
        updateIntention(ada, { action: 'revise', text: 'Look at the square.', source: 'dream', now: () => NOW });
        const dream = buildDreamInput(ada, {});
        const waking = renderVillageContext(ada);
        assert.ok(dream.episodeIds.length <= 60);
        assert.ok(dream.episodeIds.length > 5);
        const shown = waking.text.match(/ARCHIVE-LINE-\d+/g) || [];
        assert.ok(shown.length <= 5);
        assert.match(waking.text, /The square was quiet/);
        assert.match(waking.text, /Look at the square/);
        assert.equal(waking.text.includes('ARCHIVE-LINE-1 '), false);
        assert.ok(waking.chars < 4500);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an intention can be pursued, revised, abandoned, or completed without a plan', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        assert.equal(updateIntention(ada, { action: 'revise', text: 'Visit the square.', now: () => NOW }).ok, true);
        assert.equal(updateIntention(ada, { action: 'pursue', text: 'I started toward the square.', now: () => NOW }).ok, true);
        assert.equal(readIntentions(ada).active.status, 'pursuing');
        assert.equal(updateIntention(ada, { action: 'revise', text: 'Stay home and mend the flowers.', now: () => NOW }).ok, true);
        assert.match(readIntentions(ada).active.text, /flowers/);
        assert.equal(updateIntention(ada, { action: 'abandon', text: 'I changed my mind.', now: () => NOW }).ok, true);
        assert.equal(readIntentions(ada).active, null);
        updateIntention(ada, { action: 'revise', text: 'Walk once around the house.', now: () => NOW });
        assert.equal(updateIntention(ada, { action: 'complete', text: 'I did walk around.', now: () => NOW }).ok, true);
        assert.equal(readIntentions(ada).active, null);
        assert.equal(existsSync(path.join(ada, 'plan.json')), false);
        assert.equal(activityNeedsPlan('visit'), false);
        assert.equal(activityNeedsPlan('rest'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a late dream does not replace a newer waking intention', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const episode = appendEpisode(ada, { kind: 'action', source: 'verified', text: 'I walked home.', refs: ['home'] });
        updateIntention(ada, { action: 'revise', text: 'Stay with the flowers.', now: () => '2026-11-15T18:30:00.000Z' });
        const commit = commitDream(ada, {
            sleepId: 'sleep-late',
            profileChecksum: 'checksum-1',
            validated: goodDream(episode.episode.id),
            episodeIds: [episode.episode.id],
            enqueuedAt: '2026-11-15T18:00:00.000Z',
            now: '2026-11-15T18:40:00.000Z',
        });
        assert.equal(commit.applied, true);
        assert.match(readIntentions(ada).active.text, /flowers/);
        const morning = JSON.parse(readFileSync(path.join(ada, 'morning.json'), 'utf8'));
        assert.match(morning.brief, /square/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('fifteen inhabitants share one queue and one dream at a time', async () => {
    const root = tempRoot();
    try {
        const ids = Array.from({ length: 15 }, (_, index) => `person${index}`);
        for (const id of ids) {
            const dir = inhabitant(root, id);
            appendEpisode(dir, { kind: 'observed', source: 'observed', text: `${id} saw the square.`, refs: ['square'] });
        }
        let running = 0;
        let maxRunning = 0;
        const served = [];
        const client = async (job) => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            served.push(job.inhabitant_id);
            await new Promise(resolve => setTimeout(resolve, 15));
            running -= 1;
            const episodeId = JSON.parse(readFileSync(path.join(root, job.inhabitant_id, 'episodes.json'), 'utf8')).episodes[0].id;
            return { ok: true, validated: goodDream(episodeId), episodeIds: [episodeId], input_chars: 20, duration_ms: 15 };
        };
        let guard = 0;
        while (readQueue(root).jobs.filter(job => job.status === 'applied').length < 15 && guard < 40) {
            guard += 1;
            for (const id of ids) {
                if (!readQueue(root).jobs.some(job => job.inhabitant_id === id)) {
                    enqueueSleep(root, {
                        inhabitantId: id, sleepId: `sleep-${id}`, profileChecksum: 'checksum-1', life: 'alive', now: guard, minGapMs: 0,
                    });
                }
            }
            await Promise.all(ids.map(id => tickDreams({
                scenarioRoot: root, actorId: id, allowApply: true, gapMs: 0, client,
            })));
        }
        assert.equal(readQueue(root).jobs.filter(job => job.status === 'applied').length, 15);
        assert.equal(maxRunning, 1);
        assert.equal(new Set(served).size, 15);
        for (const id of ids) {
            const journal = JSON.parse(readFileSync(path.join(root, id, 'journal.json'), 'utf8'));
            assert.equal(journal.entries.length, 1);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('first-day orientation can choose an intention and does not invent a journal', async () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const ben = inhabitant(root, 'ben');
        const adaResult = await orientFirstDay(ada, {
            complete: async () => '{"intention":"Put flowers by my own door."}',
            now: () => NOW,
        });
        const benResult = await orientFirstDay(ben, {
            complete: async () => '{"intention":null}',
            now: () => NOW,
        });
        assert.equal(adaResult.intention, 'Put flowers by my own door.');
        assert.equal(adaResult.journal, false);
        assert.equal(existsSync(path.join(ada, 'journal.json')), false);
        assert.match(readIntentions(ada).active.text, /flowers/);
        assert.equal(benResult.intention, null);
        assert.equal(readIntentions(ben).active, null);
        const second = await orientFirstDay(ada, { complete: async () => '{"intention":"A different task."}' });
        assert.equal(second.skipped, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a morning brief keeps its lines and refuses an eleventh', () => {
    const episode = { id: 'ep-0001', text: 'I walked home.', refs: ['home'] };
    const kept = validateDreamOutput({
        journal: 'I walked home.\nThe house was quiet.',
        brief: 'The house was quiet.\nI may walk back.',
        stance: 'Unhurried.',
        intentions: [],
        memories: [],
    }, { episodes: [episode], identityName: 'Ada' });
    assert.equal(kept.ok, true);
    assert.match(kept.value.journal, /house was quiet/);
    assert.equal(kept.value.brief.split('\n').length, 2);
    const tooMany = validateDreamOutput({
        journal: 'I sat with it.',
        brief: Array.from({ length: 11 }, (_, index) => `Remember line ${index}.`).join('\n'),
        stance: '',
        intentions: [],
        memories: [],
    }, { episodes: [episode], identityName: 'Ada' });
    assert.equal(tooMany.ok, false);
});

test('the survival experiment does not inherit village speech or dream prompting', () => {
    const original = 'You are an AI Minecraft bot named $NAME that can converse with players, see, move, mine, build, and interact with the world by using commands.';
    assert.equal(adaptVillagePrompt(original, { enabled: false }), original);
    assert.match(adaptVillagePrompt(original, { enabled: true }), /person who lives in this village/);
    assert.equal(activityNeedsPlan('visit'), false);
    setSettings({ village_autonomy: false });
    try {
        const docs = getCommandDocs({ blocked_actions: [], plan_manager: { enabled: false } });
        assert.equal(docs.includes('!talkTo'), false);
        assert.match(parseCommandMessage('!talkTo("Wynn")'), /is not a command/);
        assert.doesNotMatch(parseCommandMessage('!talkTo("Wynn")'), /ordinary words/);
    } finally {
        setSettings({});
    }
    const counts = new Map();
    for (const range of [32, 48, 64]) {
        updateRepeatCounts(counts, `!searchForBlock("dirt", ${range})`, {
            failed: true,
            isSearch: true,
            behaviorKey: resourceAttemptKey('searchForBlock', { type: 'dirt' }),
        });
    }
    assert.equal(blockingRepeatCount(counts, {
        commandKey: '!searchForBlock("dirt", 80)',
        commandName: '!searchForBlock',
        action: 'searchForBlock',
        params: { type: 'dirt', search_range: 80 },
        parsedOk: true,
    }), 3);
    assert.equal(villageSpokenWords('Hello there. !talkTo("Wynn") !searchForBlock("dirt", 32)', '!searchForBlock'), 'Hello there.');
    const dream = dreamCallOptions({ api: 'ollama', model: 'qwen3:14b', params: { think: true, keep_alive: '45s', timeout_ms: 180000, max_predict: 1536 } });
    assert.equal(dream.think, true);
    assert.equal(dream.timeoutMs, 180000);
    const day = dreamCallOptions({ api: 'ollama', model: 'qwen3:8b', params: { think: false } });
    assert.equal(day.think, false);
});

test('a ready dream applies after a restart without a second model call', () => {
    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const episode = appendEpisode(ada, { kind: 'action', source: 'verified', text: 'I walked home.', refs: ['home'] });
        enqueueSleep(root, {
            inhabitantId: 'ada', sleepId: 'sleep-restart', profileChecksum: 'checksum-1', life: 'alive', now: 9, minGapMs: 0,
        });
        const queue = readQueue(root);
        queue.jobs[0].status = 'running';
        queue.jobs[0].ready = true;
        writeFileSync(path.join(root, 'dream_queue.json'), JSON.stringify(queue, null, 2));
        mkdirSync(path.join(ada, 'dream_results'), { recursive: true });
        writeFileSync(path.join(ada, 'dream_results', 'sleep-restart.json'), JSON.stringify({
            sleep_id: 'sleep-restart',
            validated: goodDream(episode.episode.id),
            episode_ids: [episode.episode.id],
            metrics: { duration_ms: 12 },
        }));
        let calls = 0;
        const applied = applyReadyDreams(root, 'ada');
        assert.equal(applied.applied, true);
        assert.equal(calls, 0);
        assert.equal(JSON.parse(readFileSync(path.join(ada, 'journal.json'), 'utf8')).entries.length, 1);
        assert.equal(readQueue(root).jobs[0].status, 'applied');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a village prompt drops the rolling summary and survival keeps it', async () => {
    const summary = 'I will continue building the path with the dirt blocks I have gathered.';
    const quoted = `HISTORICAL MEMORY\nSummarized memory:'$MEMORY'\n`;
    const adapted = adaptVillagePrompt(`You are $NAME.\n${quoted}`, { enabled: true });
    assert.doesNotMatch(adapted, /HISTORICAL MEMORY|\$MEMORY|building the path/);
    assert.match(adapted, /not an objective/);
    assert.match(adaptVillagePrompt(quoted, { enabled: false }), /HISTORICAL MEMORY/);

    const root = tempRoot();
    const dir = path.join(root, 'ada');
    mkdirSync(dir, { recursive: true });
    try {
        setSettings({ village_autonomy: false, agent_data_root: dir });
        let calls = 0;
        const { History } = await import('../src/agent/history.js');
        const survival = new History({
            name: 'Ada',
            prompter: { async promptMemSaving() { calls += 1; return 'Keep the shelter plan.'; } },
        });
        await survival.summarizeMemories([{ role: 'assistant', content: 'build' }]);
        assert.equal(calls, 1);
        assert.match(survival.memory, /shelter/);

        setSettings({ village_autonomy: true, agent_data_root: dir });
        const village = new History({
            name: 'Ada',
            prompter: { async promptMemSaving() { throw new Error('village must not summarize'); } },
        });
        village.memory = summary;
        await village.summarizeMemories([{ role: 'assistant', content: 'more dirt' }]);
        assert.equal(village.memory, summary);

        const report = situationReport({
            name: 'Wynn',
            self_prompter: { prompt: 'gather dirt' },
            history: { memory: summary, turns: [] },
            bot: null,
        }, 'What now?');
        assert.doesNotMatch(report.text, /building the path/);
        assert.match(report.text, /not an objective/);
        setSettings({ village_autonomy: false, agent_data_root: dir });
        const survivalReport = situationReport({
            name: 'Finn',
            self_prompter: { prompt: 'Survive' },
            history: { memory: summary, turns: [] },
            bot: null,
        }, 'What now?');
        assert.match(survivalReport.text, /building the path/);
    } finally {
        setSettings({});
        rmSync(root, { recursive: true, force: true });
    }
});

test('a desire in the journal becomes an intention, and a quiet dream does not', async () => {
    assert.match(intentionFollowUp({ journal: "Maybe tomorrow I'll help Wynn with the path.", intentions: [] }), /intentions/);
    assert.equal(intentionFollowUp({ journal: 'The house was quiet and I was content to leave it.', intentions: [] }), null);
    assert.equal(intentionFollowUp({ journal: "Maybe tomorrow I'll help.", intentions: ['Help Wynn if he is still at the path.'] }), null);

    const calls = [];
    const result = await requestDream(null, { text: 'notes', episodes: [{ id: 'ep-0001', text: 'Wynn asked me to walk the path with him.', refs: [] }] }, {
        retries: 1,
        complete: async (user) => {
            calls.push(user);
            if (calls.length === 1) {
                return { content: JSON.stringify({
                    journal: "Maybe tomorrow I'll help Wynn with the path.",
                    memories: [],
                    relationships: [],
                    stance: 'Willing, if he is still there.',
                    intentions: [],
                    brief: 'Wynn and the path.',
                }) };
            }
            return { content: JSON.stringify({
                journal: "Wynn wants company on the path. I might go.",
                memories: [],
                relationships: [],
                stance: 'Willing, if he is still there.',
                intentions: ['Walk with Wynn along the path if he is still working on it.'],
                brief: 'See Wynn at the path.',
            }) };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.match(calls[1], /intentions/);
    assert.equal(result.validated.intentions.length, 1);

    const root = tempRoot();
    try {
        const ada = inhabitant(root, 'ada');
        const episode = appendEpisode(ada, { kind: 'conversation', source: 'observed', text: 'Wynn asked me to walk the path with him.', refs: ['wynn'] });
        const committed = commitDream(ada, {
            sleepId: 'sleep-wish',
            profileChecksum: 'checksum-1',
            validated: { ...result.validated, memories: [], relationships: [] },
            episodeIds: [episode.episode.id],
            now: NOW,
        });
        assert.equal(committed.applied, true);
        const context = renderVillageContext(ada);
        assert.match(context.text, /Walk with Wynn/);
        assert.match(context.text, /See Wynn at the path/);
        assert.doesNotMatch(context.text, /building the path with the dirt/);
        const pursued = updateIntention(ada, { action: 'pursue', text: 'Walk with Wynn along the path if he is still working on it.' });
        assert.equal(pursued.ok, true);
        const revised = updateIntention(ada, { action: 'revise', text: 'Stop by the path and then go home.' });
        assert.equal(revised.ok, true);
        const abandoned = updateIntention(ada, { action: 'abandon', text: 'I would rather stay home.' });
        assert.equal(abandoned.ok, true);
        assert.equal(readIntentions(ada).active, null);
        const quiet = renderVillageContext(ada);
        assert.doesNotMatch(quiet.text, /Current intention:/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an unfinished plan stays optional beside a personal intention', () => {
    const shown = villagePlanPrompt({
        getCurrentPlan: () => ({ status: 'active', objective: 'Lay a dirt path' }),
        formatForPrompt: () => 'PERSISTENT PLAN\nObjective chosen by you: Lay a dirt path',
    });
    assert.match(shown, /optional/i);
    assert.match(shown, /Lay a dirt path/);
    assert.doesNotMatch(shown, /PERSISTENT PLAN/);
    assert.equal(villagePlanPrompt({ getCurrentPlan: () => null }), '');
});
