import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';
export const DEFAULT_MODEL = 'claude-sonnet-4-5';
export const DEFAULT_FALLBACK_MODELS = [
  'claude-sonnet-4-5',
  'poolside-laguna-xs-2.1',
  'qwen3.7-flash',
  'bazaarlink-auto',
];

export function configDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'NYXEN_CLI');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'NYXEN_CLI');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function modelChain(config) {
  const list = [];
  for (const value of [config.model, ...(Array.isArray(config.fallbackModels) ? config.fallbackModels : [])]) {
    const name = String(value || '').trim();
    if (name && !list.includes(name)) list.push(name);
  }
  return list;
}

export function mergeModelChain(configured, available) {
  const availableList = (Array.isArray(available) ? available : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const configuredList = (Array.isArray(configured) ? configured : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (!availableList.length) {
    return [...new Set(configuredList)];
  }

  const availableSet = new Set(availableList);
  const chain = [];
  const tail = [];
  for (const name of configuredList) {
    if (availableSet.has(name)) {
      if (!chain.includes(name)) chain.push(name);
    } else if (!tail.includes(name)) {
      tail.push(name);
    }
  }
  for (const name of availableList) {
    if (!chain.includes(name)) chain.push(name);
  }
  for (const name of tail) {
    if (!chain.includes(name)) chain.push(name);
  }
  return chain;
}

export function loadConfig() {
  let file = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') file = parsed;
  } catch {
    // Sin config o config corrupta: arrancar limpio.
  }

  const envFallbacks = parseList(process.env.NYXEN_FALLBACK_MODELS);
  const fileFallbacks = parseList(file.fallbackModels);

  return {
    baseUrl: normalizeBaseUrl(process.env.NYXEN_BASE_URL || file.baseUrl || ''),
    model: String(process.env.NYXEN_MODEL || file.model || '').trim(),
    apiKey: String(process.env.NYXEN_API_KEY || process.env.FREELMAPI_API_KEY || file.apiKey || '').trim(),
    fallbackModels: envFallbacks.length
      ? envFallbacks
      : Array.isArray(file.fallbackModels)
        ? fileFallbacks
        : [...DEFAULT_FALLBACK_MODELS],
  };
}

export function saveConfig({ baseUrl, model, apiKey, fallbackModels }) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  const tmp = `${file}.tmp`;
  let previous = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') previous = parsed;
  } catch {
    // Sin config previa.
  }
  const providedFallbacks = fallbackModels !== undefined;
  const fallbacks = providedFallbacks
    ? parseList(fallbackModels)
    : parseList(previous.fallbackModels);
  const payload = {
    baseUrl: normalizeBaseUrl(baseUrl),
    model: String(model || '').trim(),
    apiKey: String(apiKey || '').trim(),
  };
  if (providedFallbacks || fallbacks.length) payload.fallbackModels = fallbacks;
  const data = JSON.stringify(payload, null, 2);
  fs.writeFileSync(tmp, `${data}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // En Windows los permisos POSIX no aplican.
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Ignorar.
  }
}

export function isConfigured(config) {
  return Boolean(config && config.apiKey && config.baseUrl && config.model);
}

export function maskKey(apiKey) {
  const key = String(apiKey || '');
  if (!key) return '(sin key)';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function providerLabel(baseUrl) {
  try {
    const host = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase();
    if (host.includes('freellmapi')) return 'freellmapi';
    return host || 'freellmapi';
  } catch {
    return 'freellmapi';
  }
}
