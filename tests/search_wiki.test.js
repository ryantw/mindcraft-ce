import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMinecraftWiki, releaseWikiSearchBlock } from '../src/agent/commands/wiki_search.js';

function exactPage(title, extract, extra = {}) {
    return {
        query: {
            normalized: extra.normalized,
            redirects: extra.redirects,
            pages: [{ pageid: 1, title, extract }]
        }
    };
}

function missingPage() {
    return { query: { pages: [{ title: 'Missing', missing: true }] } };
}

function searchPages(pages) {
    return {
        query: {
            pages: pages.map((page, index) => ({
                pageid: index + 10,
                index: index + 1,
                title: page.title,
                extract: page.extract
            }))
        }
    };
}

function mockFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url) => {
        const href = String(url);
        calls.push(href);
        const body = handler(href, calls.length);
        return {
            ok: true,
            async json() { return body; }
        };
    };
    return calls;
}

test('oak_planks resolves through the wiki title API', async () => {
    const calls = mockFetch(() => exactPage('Planks', 'Planks are common building blocks.', {
        normalized: [{ from: 'oak_planks', to: 'Oak planks' }],
        redirects: [{ from: 'Oak planks', to: 'Planks', tofragment: 'Oak' }]
    }));
    const result = await searchMinecraftWiki({ name: 'Sawyer' }, 'oak_planks');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /action=query/);
    assert.match(calls[0], /titles=oak_planks/);
    assert.match(result, /Planks/);
    assert.match(result, /section Oak/);
    assert.match(result, /minecraft\.wiki\/w\/Planks/);
    assert.match(result, /common building blocks/);
    assert.ok(result.length < 1500);
});

test('wooden_pickaxe returns the pickaxe article instead of a full page', async () => {
    mockFetch(() => exactPage(
        'Wooden Pickaxe',
        'A wooden pickaxe is crafted from planks and mines stone and coal ore. '.repeat(40)
    ));
    const result = await searchMinecraftWiki({ name: 'Sawyer' }, 'wooden_pickaxe');
    assert.match(result, /Wooden Pickaxe/);
    assert.match(result, /crafted from planks/);
    assert.ok(result.length <= 1500);
    assert.equal(result.includes('recipe grid'), false);
});

test('river base uses search results when no exact article exists', async () => {
    const calls = mockFetch((url) => {
        if (url.includes('titles=')) return missingPage();
        if (url.includes('gsrsearch=river')) {
            return searchPages([
                { title: 'River', extract: 'A river is a common aquatic biome.' },
                { title: 'Biome', extract: 'A biome is a region with distinct features.' }
            ]);
        }
        return searchPages([
            { title: 'Lunar Base', extract: 'A lunar base is a constructed shelter.' }
        ]);
    });
    const result = await searchMinecraftWiki({ name: 'Sawyer' }, 'river base');
    assert.equal(calls.length, 3);
    assert.match(calls[1], /generator=search/);
    assert.match(calls[1], /gsrsearch=river/);
    assert.match(result, /No exact Minecraft Wiki article/);
    assert.match(result, /1\. River/);
    assert.match(result, /aquatic biome/);
    assert.match(result, /Lunar Base/);
    assert.equal(result.includes('Biome'), false);
});

test('unrelated wiki hits do not count as a successful search', async () => {
    mockFetch((url) => {
        if (url.includes('titles=')) return missingPage();
        return searchPages([{ title: 'Java Edition 1.21.5', extract: 'A game drop.' }]);
    });
    const agent = { name: 'Sawyer' };
    const result = await searchMinecraftWiki(agent, 'Minecraft river base setup');
    assert.match(result, /No Minecraft Wiki articles matched/);
    assert.equal(agent._wikiSearch.consecutiveFailures, 1);
    assert.equal(agent._wikiSearch.blocked, false);
});

test('a nonexistent topic is an unsuccessful search', async () => {
    mockFetch((url) => url.includes('titles=') ? missingPage() : { query: { pages: [] } });
    const agent = { name: 'Sawyer' };
    const result = await searchMinecraftWiki(agent, 'xyzzyplughnonexistenttopic');
    assert.match(result, /No Minecraft Wiki articles matched/);
    assert.equal(agent._wikiSearch.consecutiveFailures, 1);
    assert.equal(agent._wikiSearch.blocked, false);
});

test('different unsuccessful queries share one per-agent block', async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
        fetches += 1;
        return { ok: true, async json() { return missingPage(); } };
    };
    const sawyer = { name: 'Sawyer' };
    const finn = { name: 'Finn' };

    const first = await searchMinecraftWiki(sawyer, 'Minecraft river base setup');
    const second = await searchMinecraftWiki(sawyer, 'Minecraft river base ideas');
    const third = await searchMinecraftWiki(sawyer, 'Minecraft river base strategy');
    const otherAgent = await searchMinecraftWiki(finn, 'totally missing topic');

    assert.match(first, /No Minecraft Wiki articles matched/);
    assert.match(second, /Wiki search is paused/);
    assert.equal(third, 'Wiki search is paused after 2 unsuccessful searches. Take a different action before using !searchWiki again. Changing the search words will not run another search.');
    assert.equal(fetches, 9);
    assert.match(otherAgent, /No Minecraft Wiki articles matched/);
    assert.equal(finn._wikiSearch.blocked, false);

    releaseWikiSearchBlock(sawyer);
    fetches = 0;
    globalThis.fetch = async () => {
        fetches += 1;
        return {
            ok: true,
            async json() {
                return exactPage('River', 'A river is a common aquatic biome.');
            }
        };
    };
    const resumed = await searchMinecraftWiki(sawyer, 'river');
    assert.equal(fetches, 1);
    assert.match(resumed, /A river is a common aquatic biome/);
    assert.equal(sawyer._wikiSearch.blocked, false);
});

test('timeouts and HTTP errors are reported without throwing', async () => {
    const agent = { name: 'Sawyer' };
    globalThis.fetch = async () => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
    };
    const timedOut = await searchMinecraftWiki(agent, 'river');
    assert.match(timedOut, /did not respond in time/);

    globalThis.fetch = async () => ({ ok: false, status: 503, async json() { return {}; } });
    const httpError = await searchMinecraftWiki(agent, 'another missing phrase');
    assert.match(httpError, /HTTP 503/);
    assert.match(httpError, /Wiki search is paused/);
    assert.equal(agent._wikiSearch.blocked, true);
});
