import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeBaseUrl } from './config.js';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const FAST_FAIL_CODES = new Set(['no_providers_configured', 'model_not_found']);
const NO_FALLBACK_STATUS = new Set([400, 401, 403]);
const RETRY_DELAYS = [2000, 5000, 10000];
const REQUEST_TIMEOUT_MS = 180000;
const MAX_RETRIES = 3;

function cleanBody(body) {
  return String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function formatHttpError(status, body) {
  const detail = cleanBody(body) || '(cuerpo vacío)';
  const hint = status === 401 || status === 403 ? ' (revisá tu API key con /connect)' : '';
  return `Error: FreeLLMAPI respondió ${status}: ${detail}${hint}`;
}

function httpError(status, body) {
  const error = new Error(formatHttpError(status, body));
  error.status = status;
  try {
    const parsed = JSON.parse(body);
    const code = parsed && parsed.error && parsed.error.code;
    if (typeof code === 'string' && code) error.code = code;
  } catch {
    // El cuerpo no era JSON; el status alcanza para decidir.
  }
  return error;
}

function candidateModels(model, models) {
  const list = [];
  for (const value of [model, ...(Array.isArray(models) ? models : [])]) {
    const name = String(value || '').trim();
    if (name && !list.includes(name)) list.push(name);
  }
  return list;
}

function canFallback(error) {
  if (!error || error.name === 'AbortError') return false;
  if (error.code && FAST_FAIL_CODES.has(error.code)) return true;
  const status = Number(error.status);
  if (Number.isInteger(status) && status > 0) {
    if (NO_FALLBACK_STATUS.has(status)) return false;
    if (status === 404 || RETRYABLE.has(status)) return true;
    return false;
  }
  const message = String(error.message || '');
  return /timeout de \d+ s|no pude conectar con FreeLLMAPI/i.test(message);
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function linkedSignal(external, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    },
  };
}

function mapRequestError(error, link, external, timeoutMs) {
  if (link.timedOut()) {
    return new Error(`Error: timeout de ${Math.round(timeoutMs / 1000)} s esperando la respuesta.`);
  }
  if ((external && external.aborted) || error.name === 'AbortError') return abortError();
  if (String(error.message || '').startsWith('Error:')) return error;
  return new Error(`Error: no pude conectar con FreeLLMAPI (${error.message || 'error de red'}).`);
}

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function chatUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function checkedBaseUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('Error: base URL inválida; tiene que empezar con http:// o https://.');
  }
  return base;
}

const DISCOVERY_TIMEOUT_MS = 8000;
const DISCOVERY_EXCLUDED = new Set(['auto', 'fusion']);

function supportsTools(model) {
  const params = model && model.supported_parameters;
  if (!Array.isArray(params)) return true;
  return params.includes('tools');
}

async function fetchModelsJson(base, apiKey, path, link) {
  const res = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: link.signal,
  });
  const text = await res.text();
  if (!res.ok) throw httpError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Error: respuesta inválida de FreeLLMAPI (no es JSON).');
  }
}

export async function fetchAvailableModels({
  baseUrl,
  apiKey,
  signal,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
}) {
  const base = checkedBaseUrl(baseUrl);
  const link = linkedSignal(signal, timeoutMs);
  try {
    let json;
    try {
      json = await fetchModelsJson(base, apiKey, '/models?available=true', link);
    } catch (error) {
      const status = Number(error && error.status);
      if (status !== 400 && status !== 404 && status !== 405) throw error;
      json = await fetchModelsJson(base, apiKey, '/models', link);
    }
    const data = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.models)
        ? json.models
        : [];
    const list = [];
    for (const model of data) {
      const id = String((model && model.id) || '').trim();
      if (!id || DISCOVERY_EXCLUDED.has(id.toLowerCase())) continue;
      if (model.available === false) continue;
      if (!supportsTools(model)) continue;
      if (!list.includes(id)) list.push(id);
    }
    return list;
  } catch (error) {
    throw mapRequestError(error, link, signal, timeoutMs);
  } finally {
    link.cleanup();
  }
}

async function checkModel({ baseUrl, apiKey, model, signal }) {
  const url = chatUrl(baseUrl);
  const common = { model, stream: false };

  const runCheck = async (extra) => {
    const link = linkedSignal(signal, 60000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({ ...common, ...extra }),
        signal: link.signal,
      });
      const text = await res.text();
      if (!res.ok) throw httpError(res.status, text);
      try {
        JSON.parse(text);
      } catch {
        throw new Error('Error: respuesta inválida de FreeLLMAPI (no es JSON).');
      }
    } catch (error) {
      throw mapRequestError(error, link, signal, 60000);
    } finally {
      link.cleanup();
    }
  };

  await runCheck({
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });

  await runCheck({
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16,
    tools: [
      {
        type: 'function',
        function: {
          name: 'nyxen_ping',
          description: 'Comprobación de tool calling.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ],
  });
}

export async function validateConnection({ baseUrl, apiKey, model, signal }) {
  const base = checkedBaseUrl(baseUrl);
  await checkModel({ baseUrl: base, apiKey, model, signal });
  return true;
}

export async function resolveConnection({ baseUrl, apiKey, model, models, signal, onFallback }) {
  const base = checkedBaseUrl(baseUrl);
  const list = candidateModels(model, models);
  if (!list.length) throw new Error('Error: no hay ningún modelo configurado.');

  let lastError = null;
  for (let i = 0; i < list.length; i += 1) {
    try {
      await checkModel({ baseUrl: base, apiKey, model: list[i], signal });
      return list[i];
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      if (!canFallback(error) || i === list.length - 1) throw error;
      lastError = error;
      if (onFallback) onFallback(list[i], list[i + 1], error);
    }
  }
  throw lastError || new Error('Error: no pude validar la conexión.');
}

async function chatOnceModel({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTokens = 800,
  temperature = 0.2,
  signal,
}) {
  const link = linkedSignal(signal, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(chatUrl(baseUrl), {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: link.signal,
    });
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, text);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Error: respuesta inválida de FreeLLMAPI (no es JSON).');
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Error: la respuesta del modelo llegó vacía.');
    }
    return content;
  } catch (error) {
    throw mapRequestError(error, link, signal, REQUEST_TIMEOUT_MS);
  } finally {
    link.cleanup();
  }
}

export async function chatOnce({
  baseUrl,
  apiKey,
  model,
  models,
  messages,
  maxTokens = 800,
  temperature = 0.2,
  signal,
  onFallback,
}) {
  const list = candidateModels(model, models);
  if (!list.length) throw new Error('Error: no hay ningún modelo configurado.');

  let lastError = null;
  for (let i = 0; i < list.length; i += 1) {
    try {
      return await chatOnceModel({
        baseUrl,
        apiKey,
        model: list[i],
        messages,
        maxTokens,
        temperature,
        signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      if (!canFallback(error) || i === list.length - 1) throw error;
      lastError = error;
      if (onFallback) onFallback(list[i], list[i + 1], error);
    }
  }
  throw lastError || new Error('Error: no pude completar la petición a FreeLLMAPI.');
}

function accumulateToolCall(map, toolCall, fallbackIndex) {
  const rawIndex = Number(toolCall.index);
  const index = Number.isInteger(rawIndex) ? rawIndex : fallbackIndex;
  let acc = map.get(index);
  if (!acc) {
    acc = { id: '', type: 'function', function: { name: '', arguments: '' } };
    map.set(index, acc);
  }
  if (toolCall.id) acc.id = toolCall.id;
  if (toolCall.type) acc.type = toolCall.type;
  const fn = toolCall.function || {};
  if (typeof fn.name === 'string' && fn.name) {
    if (!acc.function.name) acc.function.name = fn.name;
    else if (!acc.function.name.endsWith(fn.name)) acc.function.name += fn.name;
  }
  if (typeof fn.arguments === 'string') acc.function.arguments += fn.arguments;
}

async function parseStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const toolMap = new Map();
  let buffer = '';
  let content = '';
  let finishReason = null;
  let sawDone = false;

  const processLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) {
      const message = json.error.message || JSON.stringify(json.error);
      const error = new Error(`Error: FreeLLMAPI respondió error: ${cleanBody(message)}`);
      if (typeof json.error.code === 'string' && json.error.code) error.code = json.error.code;
      throw error;
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall, i) => accumulateToolCall(toolMap, toolCall, i));
    }
  };

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while (!sawDone && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && !sawDone) processLine(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignorar.
    }
  }

  const toolCalls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call], position) => ({
      ...call,
      id: call.id || `call_${index}_${position}`,
    }));

  return { content, toolCalls, finishReason };
}

async function streamChatModel({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  signal,
  onDelta,
  onRetry,
}) {
  const body = { model, messages, stream: true };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      if (onRetry) onRetry(attempt, MAX_RETRIES);
      try {
        await sleep(RETRY_DELAYS[attempt - 1], undefined, { signal });
      } catch {
        throw abortError();
      }
    }

    const link = linkedSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(chatUrl(baseUrl), {
        method: 'POST',
        headers: { ...headers(apiKey), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: link.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = httpError(res.status, text);
        if (FAST_FAIL_CODES.has(error.code)) throw error;
        if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
          lastError = error;
          continue;
        }
        throw error;
      }

      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
        const text = await res.text();
        throw httpError(res.status, text);
      }

      return await parseStream(res, onDelta);
    } catch (error) {
      if (error && error.code && FAST_FAIL_CODES.has(error.code)) throw error;
      if (error && error.status && RETRYABLE.has(error.status)) {
        if (attempt < MAX_RETRIES) {
          lastError = error;
          continue;
        }
        throw error;
      }
      throw mapRequestError(error, link, signal, REQUEST_TIMEOUT_MS);
    } finally {
      link.cleanup();
    }
  }

  throw lastError || new Error('Error: no pude completar la petición a FreeLLMAPI.');
}

export async function streamChat({
  baseUrl,
  apiKey,
  model,
  models,
  messages,
  tools,
  signal,
  onDelta,
  onRetry,
  onFallback,
}) {
  const list = candidateModels(model, models);
  if (!list.length) throw new Error('Error: no hay ningún modelo configurado.');

  let lastError = null;
  for (let i = 0; i < list.length; i += 1) {
    let emitted = false;
    try {
      const result = await streamChatModel({
        baseUrl,
        apiKey,
        model: list[i],
        messages,
        tools,
        signal,
        onRetry,
        onDelta: (text) => {
          emitted = true;
          if (onDelta) onDelta(text);
        },
      });
      return { ...result, model: list[i] };
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      if (emitted || !canFallback(error) || i === list.length - 1) throw error;
      lastError = error;
      if (onFallback) onFallback(list[i], list[i + 1], error);
    }
  }

  throw lastError || new Error('Error: no pude completar la petición a FreeLLMAPI.');
}
