#!/usr/bin/env node
import process from 'node:process';
import readline from 'node:readline';
import {
  DEFAULT_MODEL,
  VERSION,
  isConfigured,
  loadConfig,
  mergeModelChain,
  modelChain,
  normalizeBaseUrl,
  providerLabel,
  saveConfig,
} from '../src/config.js';
import { fetchAvailableModels, resolveConnection } from '../src/api.js';
import { Agent } from '../src/agent.js';
import { UI } from '../src/ui.js';
import {
  clearSession,
  latestBackup,
  loadSession,
  saveSession,
} from '../src/session.js';

const HELP = `NYXEN_CLI ${VERSION} — agente de programación para la terminal

Uso:
  nyxen              abre el CLI en la carpeta actual
  nyxen --version    muestra la versión
  nyxen --help       muestra esta ayuda

Dentro del CLI:
  /connect           configura la API key, la base URL y el modelo
  /exit              sale

Todo lo demás que escribas es una instrucción para el agente.`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const cwd = process.cwd();
const ui = new UI({ input: process.stdin, output: process.stdout });
let config = loadConfig();
let availableCount = 0;

if (isConfigured(config)) {
  try {
    const available = await fetchAvailableModels({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeoutMs: 3500,
    });
    if (available.length) {
      availableCount = available.length;
      const chain = mergeModelChain(modelChain(config), available);
      if (chain.length) {
        config = { ...config, model: chain[0], fallbackModels: chain.slice(1) };
      }
    }
  } catch {
    // Sin descubrimiento: la cadena configurada sigue siendo válida.
  }
}

ui.banner(
  cwd,
  config,
  availableCount ? `• ${availableCount} modelos disponibles en FreeLLMAPI.` : '',
);

let history = [];
try {
  const stored = loadSession(cwd);
  if (Array.isArray(stored) && stored.length) {
    history = stored.slice(-20);
    const firstUser = history.findIndex((message) => message.role === 'user');
    if (firstUser > 0) history = history.slice(firstUser);
    ui.restored(history.length);
  }
} catch {
  history = [];
}

const backup = latestBackup(cwd);
if (backup) ui.backupInfo(backup);

const agent = new Agent({ config, cwd, ui, history, backup });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
  historySize: 50,
  removeHistoryDuplicates: true,
});
ui.attach(rl);

let busy = false;
let abortController = null;
let exiting = false;
let eofRequested = false;
let multiline = false;
let multilineBuffer = [];
let altEnterPending = false;
let pasteMode = false;
let pasteTimer = null;
let pasteLines = [];
const pendingInput = [];

function showPrompt() {
  if (exiting || busy || ui.mode !== 'input') return;
  if (!process.stdin.isTTY) return;
  rl.setPrompt(multiline ? '… ' : '› ');
  rl.prompt();
}

function setPromptMode(next) {
  multiline = next;
  if (process.stdin.isTTY && ui.mode === 'input') rl.setPrompt(next ? '… ' : '› ');
}

function finish(code = 0, sayBye = false) {
  if (exiting) return;
  exiting = true;
  if (pasteTimer) {
    clearTimeout(pasteTimer);
    pasteTimer = null;
  }
  if (abortController) abortController.abort();
  saveSession(cwd, agent.getHistory());
  if (sayBye) ui.line('Adiós.');
  try {
    rl.close();
  } catch {
    // Ignorar.
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 30);
}

async function doConnect() {
  if (!process.stdin.isTTY) {
    ui.err('No puedo configurar la API en una terminal no interactiva.');
    return;
  }

  ui.line();
  const apiKey = await ui.ask('API key: ', { hidden: true });
  if (!apiKey) {
    ui.line('Cancelado.');
    return;
  }
  const baseUrl = normalizeBaseUrl(await ui.ask('Base URL: '));
  if (!baseUrl) {
    ui.line('Cancelado.');
    return;
  }
  let available = [];
  try {
    available = await fetchAvailableModels({ baseUrl, apiKey, timeoutMs: 8000 });
  } catch {
    available = [];
  }
  const existingChain = modelChain(config);
  const discoveredChain = mergeModelChain(existingChain, available);

  const modelInput = (await ui.ask('Modelo (Enter = automático): ')).trim();
  const autoModel = !modelInput || /^auto$/i.test(modelInput);
  const attemptChain = autoModel
    ? [...discoveredChain]
    : [modelInput, ...discoveredChain.filter((name) => name !== modelInput)];
  if (!attemptChain.length) attemptChain.push(DEFAULT_MODEL);

  if (available.length) {
    ui.line(`• ${available.length} modelos disponibles en FreeLLMAPI.`);
  }

  const requestedModel = attemptChain[0];
  const requestedFallbacks = attemptChain.slice(1);

  ui.write('• validando conexión…');
  let activeModel = requestedModel;
  try {
    activeModel = await resolveConnection({
      baseUrl,
      apiKey,
      model: requestedModel,
      models: requestedFallbacks,
      onFallback: (from, to) => {
        ui.endStream();
        ui.line(`• ${from} no disponible; probando ${to}…`);
      },
    });
  } catch (error) {
    ui.endStream();
    ui.err(error.message || 'no pude validar la conexión.');
    return;
  }
  ui.endStream();
  if (activeModel !== requestedModel) ui.line(`• usando ${activeModel}.`);

  const fallbackModels = attemptChain.filter(
    (name) => name !== activeModel && name !== requestedModel,
  );
  if (requestedModel !== activeModel) fallbackModels.push(requestedModel);
  try {
    saveConfig({ baseUrl, model: activeModel, apiKey, fallbackModels });
  } catch (error) {
    ui.err(`no pude guardar la configuración: ${error.message}`);
    return;
  }

  config = loadConfig();
  agent.setConfig(config);
  ui.ok(`Conectado a ${providerLabel(config.baseUrl)} · modelo ${config.model}`);
}

function isResetPhrase(text) {
  return /^(empezá|empeza|empezar|comenzá|comenza|reset)\s*(de\s*cero)?[.!]?$|^(borr[áa]|limpi[áa])\s+(la\s+)?sesi[óo]n[.!]?$/i.test(
    text.trim(),
  );
}

async function handleMessage(text) {
  const message = String(text || '').trim();
  if (!message) {
    showPrompt();
    return;
  }

  if (isResetPhrase(message)) {
    clearSession(cwd);
    agent.clearHistory();
    ui.ok('Sesión borrada.');
    showPrompt();
    processNextNonInteractive();
    return;
  }

  if (!isConfigured(config)) {
    ui.line('No hay conexión. Usá /connect primero.');
    showPrompt();
    processNextNonInteractive();
    return;
  }

  busy = true;
  abortController = new AbortController();
  try {
    await agent.runTurn(message, { signal: abortController.signal });
  } catch (error) {
    if (!error || error.name !== 'AbortError') {
      ui.err(error && error.message ? error.message : 'error inesperado.');
    }
  } finally {
    busy = false;
    abortController = null;
    saveSession(cwd, agent.getHistory());
    processNextNonInteractive();
    showPrompt();
  }
}

async function handleCommand(command) {
  if (command === '/exit') {
    finish(0, true);
    return;
  }
  if (command === '/connect') {
    await doConnect();
    showPrompt();
    processNextNonInteractive();
    return;
  }
  ui.line('Comando desconocido. Disponibles: /connect, /exit');
  showPrompt();
  processNextNonInteractive();
}

function processNextNonInteractive() {
  if (process.stdin.isTTY) return;
  if (busy) return;
  if (pendingInput.length) {
    const next = pendingInput.shift();
    setImmediate(() => {
      if (next.startsWith('/')) handleCommand(next);
      else handleMessage(next);
    });
    return;
  }
  if (eofRequested) finish(0, false);
}

function handleNonInteractiveLine(line) {
  const text = line.trim();
  if (!text) return;
  if (busy) {
    pendingInput.push(text);
    return;
  }
  if (text.startsWith('/')) handleCommand(text);
  else handleMessage(text);
}

function submitPaste() {
  const lines = multilineBuffer.length ? [...multilineBuffer, ...pasteLines] : [...pasteLines];
  const text = lines.join('\n').replace(/\n+$/, '');
  pasteLines = [];
  multilineBuffer = [];
  altEnterPending = false;
  setPromptMode(false);
  if (exiting) return;
  if (ui.mode !== 'input') return;
  if (!text.trim()) {
    showPrompt();
    return;
  }
  if (busy) {
    ui.line('Esperá a que termine la respuesta.');
    showPrompt();
    return;
  }
  if (text.trimStart().startsWith('/') && !text.includes('\n')) {
    handleCommand(text.trim());
  } else {
    handleMessage(text);
  }
}

function onLine(line) {
  if (exiting) return;
  if (ui.mode !== 'input') {
    ui.submitAnswer(line);
    return;
  }

  if (!process.stdin.isTTY) {
    handleNonInteractiveLine(line);
    return;
  }
  if (busy) {
    ui.line('Esperá a que termine la respuesta.');
    showPrompt();
    return;
  }

  if (pasteMode) {
    pasteLines.push(line);
    return;
  }

  if (altEnterPending) {
    altEnterPending = false;
    multilineBuffer.push(line);
    setPromptMode(true);
    rl.prompt();
    return;
  }

  if (multiline) {
    if (line.trim() === '') {
      const text = multilineBuffer.join('\n');
      multilineBuffer = [];
      setPromptMode(false);
      if (text.trim()) handleMessage(text);
      else showPrompt();
    } else {
      multilineBuffer.push(line);
      rl.prompt();
    }
    return;
  }

  if (!line.trim()) {
    showPrompt();
    return;
  }

  if (line.trimStart().startsWith('/')) {
    handleCommand(line.trim());
    return;
  }

  handleMessage(line);
}

if (process.stdin.isTTY) {
  process.stdin.on('keypress', (str, key) => {
    if (ui.mode !== 'input' || busy || exiting) return;
    if (key && key.name === 'return' && key.meta) altEnterPending = true;
  });

  process.stdin.prependListener('data', (chunk) => {
    if (exiting || ui.mode !== 'input') return;
    const text = chunk.toString('utf8');
    if (text.includes('\x1b\r') || text.includes('\x1b\n')) {
      if (!busy) altEnterPending = true;
      return;
    }
    if (text.includes('\x1b')) return;
    const newlines = (text.match(/\r\n|\r|\n/g) || []).length;
    const visible = text.replace(/[\r\n]/g, '');
    if (newlines > 0 && visible.length > 0) {
      pasteMode = true;
      if (pasteTimer) clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        pasteTimer = null;
        pasteMode = false;
        submitPaste();
      }, 60);
    }
  });
}

rl.on('line', onLine);

rl.on('SIGINT', () => {
  if (ui.mode === 'confirm' || ui.mode === 'ask') {
    ui.line('^C');
    ui.cancelPrompt();
    return;
  }
  if (busy && abortController) {
    abortController.abort();
    ui.endStream();
    ui.line('^C');
    return;
  }
  if (multilineBuffer.length) {
    multilineBuffer = [];
    setPromptMode(false);
    ui.line('^C');
    showPrompt();
    return;
  }
  ui.line('Usá /exit para salir.');
  showPrompt();
});

rl.on('close', () => {
  eofRequested = true;
  if (exiting) return;
  if (process.stdin.isTTY || (!busy && !pendingInput.length)) finish(0, false);
});

process.on('uncaughtException', (error) => {
  if (exiting) return;
  ui.err(error && error.message ? error.message : String(error));
  finish(1, false);
});

process.on('unhandledRejection', (error) => {
  if (exiting) return;
  ui.err(error && error.message ? error.message : String(error));
  finish(1, false);
});

showPrompt();
