const WIKI_API = 'https://minecraft.wiki/api.php';
const USER_AGENT = 'mindcraft-ce (local Minecraft agent; wiki lookup)';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_ARTICLES = 3;
const EXTRACT_CHARS = 380;
const MAX_OUTPUT_CHARS = 1500;
const MAX_QUERY_CHARS = 80;
const FAILURES_BEFORE_BLOCK = 2;
const STOPWORDS = new Set([
    'minecraft', 'the', 'and', 'for', 'with', 'how', 'what', 'why', 'from',
    'your', 'setup', 'ideas', 'idea', 'strategy', 'strategies', 'guide',
    'tutorial', 'build', 'building', 'make', 'making', 'best', 'good',
    'ways', 'way', 'tips', 'tip', 'help', 'into', 'using', 'about'
]);

const PAUSED_MESSAGE = 'Wiki search is paused after 2 unsuccessful searches. Take a different action before using !searchWiki again. Changing the search words will not run another search.';

function wikiGuard(agent) {
    if (!agent._wikiSearch) {
        agent._wikiSearch = { consecutiveFailures: 0, blocked: false };
    }
    return agent._wikiSearch;
}

/**
 * A non-wiki command is the different action required after repeated failed searches.
 */
export function releaseWikiSearchBlock(agent) {
    const guard = agent?._wikiSearch;
    if (!guard) return;
    guard.blocked = false;
    guard.consecutiveFailures = 0;
}

function recordSuccess(agent) {
    const guard = wikiGuard(agent);
    guard.consecutiveFailures = 0;
    guard.blocked = false;
}

function recordFailure(agent, query, message) {
    const guard = wikiGuard(agent);
    guard.consecutiveFailures += 1;
    console.warn(`[${agent.name || 'agent'}] Wiki search unsuccessful (${guard.consecutiveFailures}) for "${query}"`);
    if (guard.consecutiveFailures >= FAILURES_BEFORE_BLOCK) {
        guard.blocked = true;
        return trimOutput(`${message}\n\n${PAUSED_MESSAGE}`);
    }
    return trimOutput(message);
}

function trimOutput(text) {
    const clean = String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (clean.length <= MAX_OUTPUT_CHARS) return clean;
    return clean.slice(0, MAX_OUTPUT_CHARS - 1).trimEnd() + '…';
}

function collapse(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function clipExtract(text) {
    const clean = collapse(text);
    if (clean.length <= EXTRACT_CHARS) return clean;
    return clean.slice(0, EXTRACT_CHARS - 1).trimEnd() + '…';
}

function articleUrl(title, fragment) {
    const path = encodeURIComponent(String(title).replace(/ /g, '_')).replace(/%2F/g, '/');
    const url = `https://minecraft.wiki/w/${path}`;
    if (!fragment) return url;
    return `${url}#${encodeURIComponent(fragment).replace(/%20/g, '_')}`;
}

function pageList(query) {
    const pages = query?.pages;
    if (!pages) return [];
    const list = Array.isArray(pages) ? pages : Object.values(pages);
    return list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function isMissing(page) {
    return !page || page.missing === true || page.missing === '' || page.pageid == null;
}

async function wikiGet(params) {
    const url = new URL(WIKI_API);
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
    }
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error('The Minecraft Wiki returned a response that was not JSON.');
    }
    if (data?.error) {
        throw new Error(data.error.info || data.error.code || 'Wiki API error');
    }
    return data;
}

function networkMessage(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return 'The Minecraft Wiki did not respond in time. Try a short topic again later, or take a different action.';
    }
    if (error?.httpStatus) {
        return `The Minecraft Wiki returned HTTP ${error.httpStatus}. Try a short topic again later, or take a different action.`;
    }
    return `The Minecraft Wiki request failed (${error?.message || error}). Try a short topic again later, or take a different action.`;
}

function formatExact(query, data) {
    const page = pageList(data.query)[0];
    if (isMissing(page)) return null;
    const redirect = data.query?.redirects?.[0];
    const normalized = data.query?.normalized?.[0];
    const fragment = redirect?.tofragment;
    const lines = [`Minecraft Wiki: ${page.title}`];
    if (redirect || (normalized && normalized.from.toLowerCase() !== page.title.toLowerCase())) {
        const from = redirect?.from || normalized?.from || query;
        lines.push(fragment
            ? `Resolved "${from}" to ${page.title}, section ${fragment}.`
            : `Resolved "${from}" to ${page.title}.`);
    }
    lines.push(articleUrl(page.title, fragment));
    const extract = clipExtract(page.extract);
    if (extract) lines.push(extract);
    return lines.join('\n');
}

function significantTokens(query) {
    const tokens = query.toLowerCase().replace(/_/g, ' ')
        .split(/[^a-z0-9]+/)
        .filter(token => token.length >= 3 && !STOPWORDS.has(token));
    return [...new Set(tokens)]
        .sort((a, b) => b.length - a.length || query.toLowerCase().indexOf(a) - query.toLowerCase().indexOf(b))
        .slice(0, 2);
}

function titleMentions(title, token) {
    return title.toLowerCase().includes(token);
}

function formatSearch(query, pages, tokens) {
    if (pages.length === 0) return null;
    const topic = tokens.length ? tokens.join(' and ') : `"${query}"`;
    const lines = [`No exact Minecraft Wiki article for "${query}". Closest articles for ${topic}:`];
    pages.forEach((page, index) => {
        lines.push('');
        lines.push(`${index + 1}. ${page.title}`);
        lines.push(articleUrl(page.title));
        const extract = clipExtract(page.extract);
        if (extract) lines.push(extract);
    });
    lines.push('');
    lines.push('Short topics such as an item, block, or mob name match better than a long question.');
    return lines.join('\n');
}

async function searchRelevantArticles(tokens) {
    const found = [];
    const seen = new Set();
    for (const token of tokens) {
        const data = await wikiGet({
            action: 'query',
            generator: 'search',
            gsrsearch: token,
            gsrlimit: '5',
            gsrnamespace: '0',
            prop: 'extracts',
            exintro: '1',
            explaintext: '1',
            exchars: String(EXTRACT_CHARS)
        });
        for (const page of pageList(data.query)) {
            if (isMissing(page) || seen.has(page.title)) continue;
            if (!titleMentions(page.title, token)) continue;
            seen.add(page.title);
            found.push(page);
            if (found.length >= MAX_ARTICLES) return found;
        }
    }
    return found;
}

export async function searchMinecraftWiki(agent, query) {
    const guard = wikiGuard(agent);
    if (guard.blocked) {
        console.warn(`[${agent.name || 'agent'}] Wiki search blocked until another command: "${query}"`);
        return PAUSED_MESSAGE;
    }

    const cleaned = collapse(query).slice(0, MAX_QUERY_CHARS);
    if (!cleaned) {
        return recordFailure(agent, query, 'Give !searchWiki a short Minecraft topic, such as "oak planks", "wooden pickaxe", or "river".');
    }

    try {
        const exact = await wikiGet({
            action: 'query',
            redirects: '1',
            titles: cleaned,
            prop: 'extracts',
            exintro: '1',
            explaintext: '1',
            exchars: String(EXTRACT_CHARS)
        });
        const exactText = formatExact(cleaned, exact);
        if (exactText) {
            recordSuccess(agent);
            return trimOutput(exactText);
        }

        const tokens = significantTokens(cleaned);
        const pages = await searchRelevantArticles(tokens.length ? tokens : [cleaned.replace(/_/g, ' ')]);
        const searchText = formatSearch(cleaned, pages, tokens);
        if (!searchText) {
            return recordFailure(
                agent,
                cleaned,
                `No Minecraft Wiki articles matched "${cleaned}". Use a short, specific topic such as "oak planks", "wooden pickaxe", or "river".`
            );
        }
        recordSuccess(agent);
        return trimOutput(searchText);
    } catch (error) {
        console.warn(`[${agent.name || 'agent'}] Wiki request error:`, error?.message || error);
        return recordFailure(agent, cleaned, networkMessage(error));
    }
}
