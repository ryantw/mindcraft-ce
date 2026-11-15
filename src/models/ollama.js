import { strictFormat } from '../utils/text.js';

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embed';
    }

    // One-shot completion for deliberate reasoning. Does not mutate this.params,
    // does not retry, and never returns the thinking trace.
    async complete(userContent, systemMessage, paramOverride = {}) {
        const params = mergeOllamaParams(this.params, paramOverride);
        const timeoutMs = positiveNumber(paramOverride.timeout_ms, 45000);
        const cap = Math.min(HARD_MAX_PREDICT, positiveNumber(paramOverride.max_predict, HARD_MAX_PREDICT));
        params.options = { ...(params.options || {}) };
        const requested = Number(params.options.num_predict);
        params.options.num_predict = Number.isFinite(requested)
            ? Math.min(Math.max(1, Math.floor(requested)), cap)
            : cap;

        const messages = [
            { role: 'system', content: systemMessage },
            { role: 'user', content: String(userContent ?? '') }
        ];
        const startedAt = Date.now();
        let apiResponse;
        try {
            apiResponse = await this.send(this.chat_endpoint, {
                model: this.model_name,
                messages,
                stream: false,
                ...params
            }, AbortSignal.timeout(timeoutMs));
        } catch (error) {
            logOllamaMetrics({
                model: this.model_name,
                messages,
                startedAt,
                numCtx: params.options?.num_ctx,
                error,
            });
            throw error;
        }
        logOllamaMetrics({
            model: this.model_name,
            messages,
            response: apiResponse,
            startedAt,
            numCtx: params.options?.num_ctx,
        });

        return {
            content: extractFinalAnswer(apiResponse),
            done_reason: apiResponse?.done_reason || null,
            eval_count: apiResponse?.eval_count ?? null,
            prompt_eval_count: apiResponse?.prompt_eval_count ?? null
        };
    }

    async sendRequest(turns, systemMessage, imageBuffer = null, diagnosticState = null) {
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        diagnosticState ||= { clientTruncated: false };
        let messages = strictFormat(turns.map(turn => ({ ...turn })));
        messages.unshift({ role: 'system', content: systemMessage });
        if (imageBuffer) {
            messages.push({ role: 'user', content: systemMessage, images: [imageBuffer.toString('base64')] });
        }
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting ${this.constructor.prefix} response... (model: ${model}, attempt: ${attempt})`);
            let res;
            const startedAt = Date.now();
            let metricsLogged = false;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {})
                });
                logOllamaMetrics({
                    model,
                    messages,
                    response: apiResponse,
                    startedAt,
                    numCtx: this.params?.options?.num_ctx,
                    clientTruncated: diagnosticState.clientTruncated,
                });
                metricsLogged = true;
                if (typeof apiResponse?.message?.content !== 'string') {
                    throw new Error('Ollama returned no chat message.');
                }
                res = apiResponse.message.content;
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    if (!metricsLogged) {
                        logOllamaMetrics({
                            model,
                            messages,
                            startedAt,
                            numCtx: this.params?.options?.num_ctx,
                            truncation: 'context-error',
                            error: err,
                        });
                    }
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage, imageBuffer, { clientTruncated: true });
                }
                if (!metricsLogged) {
                    logOllamaMetrics({
                        model,
                        messages,
                        startedAt,
                        numCtx: this.params?.options?.num_ctx,
                        error: err,
                    });
                }
                console.log(err);
                const retryable = err.status === 429 || (err.status >= 500 && err.status < 600) || !err.status;
                if (retryable && attempt < maxAttempts) {
                    const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
                    console.log(`Ollama request failed (${err.status ?? 'network error'}), retrying in ${delayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                res = 'My brain disconnected, try again.';
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn("Could not get a valid response after max attempts.");
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'embeddinggemma';
        let body = { model: model, input: text };
        let res = await this.send(this.embedding_endpoint, body);
        const embedding = res?.embeddings?.[0];
        if (!Array.isArray(embedding)) throw new Error('Ollama returned no embedding.');
        return embedding;
    }

    async send(endpoint, body, signal) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers({ 'Content-Type': 'application/json' });
        if (this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`);
        const request = new Request(url, { method, headers, body: JSON.stringify(body), signal });
        const res = await fetch(request);
        if (!res.ok) {
            const data = await res.json().catch(() => null);
            const err = new Error(`Ollama status ${res.status}${data?.error ? ': ' + data.error : ''}`);
            err.status = res.status;
            throw err;
        }
        return await res.json();
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        return await this.sendRequest(messages, systemMessage, imageBuffer);
    }
}

const HARD_MAX_PREDICT = 1024;
const CONTROL_KEYS = new Set([
    'timeout_ms',
    'max_concurrent',
    'cooldown_ms',
    'max_consecutive',
    'max_predict'
]);

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

// Copy request params so a reasoning override cannot change the shared adapter.
function mergeOllamaParams(base, override) {
    const merged = { ...(base || {}) };
    if (base?.options) merged.options = { ...base.options };
    if (!override) return merged;
    for (const [key, value] of Object.entries(override)) {
        if (CONTROL_KEYS.has(key)) continue;
        if (key === 'options' && value && typeof value === 'object') {
            merged.options = { ...(merged.options || {}), ...value };
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function extractFinalAnswer(apiResponse) {
    const message = apiResponse?.message || {};
    let content = typeof message.content === 'string' ? message.content : '';
    if (content.includes('</think>')) {
        if (!content.includes('<think>')) content = '<think>' + content;
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
    return content.trim();
}

function metric(value) {
    return value == null ? 'unknown' : value;
}

function durationMs(response, startedAt) {
    const nanoseconds = Number(response?.total_duration);
    if (Number.isFinite(nanoseconds) && nanoseconds >= 0) return Math.round(nanoseconds / 1e6);
    return Math.max(0, Date.now() - startedAt);
}

function reportedTruncation(response, clientTruncated, explicit) {
    if (explicit) return explicit;
    if (clientTruncated) return 'client-history';
    if (typeof response?.truncated === 'boolean') return response.truncated ? 'provider' : 'none';
    if (typeof response?.context_truncated === 'boolean') return response.context_truncated ? 'provider' : 'none';
    return 'unknown';
}

export function formatOllamaMetrics({
    model,
    messages = [],
    response = null,
    startedAt = Date.now(),
    numCtx = null,
    clientTruncated = false,
    truncation = null,
    error = null,
} = {}) {
    const systemChars = messages[0]?.role === 'system'
        ? String(messages[0].content ?? '').length
        : 0;
    const history = messages[0]?.role === 'system' ? messages.slice(1) : messages;
    const historyChars = history.reduce((sum, message) => sum + String(message.content ?? '').length, 0);
    const fields = [
        '[LLM metrics]',
        'provider=ollama',
        `model=${model || 'unknown'}`,
        `prompt_tokens=${metric(response?.prompt_eval_count)}`,
        `generated_tokens=${metric(response?.eval_count)}`,
        `truncation=${reportedTruncation(response, clientTruncated, truncation)}`,
        `num_ctx=${metric(numCtx)}`,
        `system_chars=${systemChars}`,
        `history_chars=${historyChars}`,
        `history_messages=${history.length}`,
        `duration_ms=${durationMs(response, startedAt)}`,
    ];
    if (error) fields.push(`error=${String(error.message || error).replace(/\s+/g, '_').slice(0, 120)}`);
    return fields.join(' ');
}

function logOllamaMetrics(details) {
    console.log(formatOllamaMetrics(details));
}
