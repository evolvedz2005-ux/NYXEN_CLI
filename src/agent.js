import fs from 'node:fs';
import path from 'node:path';
import { chatOnce, streamChat } from './api.js';
import { modelChain } from './config.js';
import { formatStamp } from './session.js';
import {
  CONFIRM_TOOLS,
  TOOL_SCHEMAS,
  describeToolCall,
  executeTool,
  isIgnored,
  loadIgnorePatterns,
  planConfirmation,
} from './tools.js';

const MAX_STEPS = 30;
const CONTEXT_CHARS = 80000;
const KEEP_RECENT = 6;

function readNyxenMd(cwd) {
  try {
    const text = fs.readFileSync(path.join(cwd, 'NYXEN.md'), 'utf8');
    return text.slice(0, 6000);
  } catch {
    return '';
  }
}

function detectChecks(cwd) {
  const checks = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    if (scripts.test && !/no test specified/i.test(String(scripts.test))) checks.push('npm test');
    if (scripts.build) checks.push('npm run build');
  } catch {
    // Sin package.json.
  }
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) checks.push('tsc --noEmit');
  if (
    fs.existsSync(path.join(cwd, 'pytest.ini')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml'))
  ) {
    checks.push('pytest');
  }
  if (fs.existsSync(path.join(cwd, 'gradlew.bat')) || fs.existsSync(path.join(cwd, 'gradlew'))) {
    checks.push('gradlew build');
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) checks.push('go build ./...');
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) checks.push('cargo build');
  return [...new Set(checks)];
}

function buildTree(cwd, maxDepth = 2) {
  const patterns = loadIgnorePatterns(cwd);
  const entries = [];

  const walk = (dir, depth) => {
    if (entries.length >= 160 || depth > maxDepth) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (entries.length >= 160) return;
      const full = path.join(dir, item.name);
      const rel = path.relative(cwd, full);
      if (isIgnored(rel, item.name, item.isDirectory(), patterns)) continue;
      entries.push(`${rel.split(path.sep).join('/')}${item.isDirectory() ? '/' : ''}`);
      if (item.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  };

  walk(cwd, 1);
  let text = entries.join('\n');
  if (text.length > 4000) text = `${text.slice(0, 4000)}\n… (árbol truncado)`;
  return text;
}

function buildSystemPrompt(cwd, backup) {
  const checks = detectChecks(cwd);
  const tree = buildTree(cwd, 2);
  const nyxenMd = readNyxenMd(cwd);

  let prompt = `Sos NYXEN_CLI, un agente de programación que trabaja en la terminal.
Directorio de trabajo: ${cwd}
Sistema: ${process.platform} · Node ${process.versions.node}

Reglas:
- Usá las herramientas para inspeccionar y modificar archivos; no inventes contenido de archivos que no leíste.
- Antes de editar, leé el archivo. Preferí ediciones puntuales sobre reescribir todo.
- Nunca escribas fuera del directorio de trabajo.
- Nunca ejecutes comandos destructivos (borrados masivos, git reset --hard, push --force).
- Verificá tu trabajo cuando sea posible (leer el resultado o correr un comando de check).
- Si modificaste archivos y el proyecto tiene un check conocido, corrélo con run_command antes de terminar el turno. Si falla, intentá arreglarlo y reportá el estado final.
- Para borrar carpetas usá delete con recursive: true. El detalle y la confirmación los maneja el CLI.
- Respuestas finales: 1–4 líneas, en el idioma del usuario, sin repetir el código.

## Árbol del proyecto
${tree || '(vacío)'}

## Checks conocidos
${checks.length ? checks.map((check) => `- ${check}`).join('\n') : '(ninguno detectado)'}
`;

  if (nyxenMd) {
    prompt += `\n## Contexto del proyecto (NYXEN.md)\n${nyxenMd}\n`;
  }

  prompt += `\n## Backups
Los backups se guardan en .nyxen/backup/<fecha>/<ruta-relativa>.
Si el usuario pide restaurar el backup, mirá la carpeta más reciente de .nyxen/backup y copiá sus archivos de vuelta con read_file y write_file.
`;
  if (backup) {
    prompt += `Último backup detectado: ${formatStamp(backup.stamp)} en .nyxen/backup/${backup.stamp} (${backup.files} archivos).\n`;
  }

  return prompt;
}

function looksLikeNoTools(text) {
  if (!text) return false;
  return /(no (puedo|tengo) (acceder|leer|escribir|modificar|ejecutar|crear)|no tengo acceso|no puedo interactuar con (archivos|el sistema)|como (modelo|IA) no puedo|I (can't|cannot) (access|read|write|modify)|no dispongo de (acceso|herramientas))/i.test(
    text,
  );
}

function messageSize(message) {
  const content = typeof message.content === 'string' ? message.content.length : 0;
  const calls = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  return content + calls;
}

export class Agent {
  constructor({ config, cwd, ui, history = [], backup = null }) {
    this.config = config;
    this.models = modelChain(config);
    this.cwd = cwd;
    this.ui = ui;
    this.systemPrompt = buildSystemPrompt(cwd, backup);
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    if (Array.isArray(history) && history.length) {
      this.messages.push(...history.slice(-20));
    }
    this.nudgedNoTools = false;
  }

  setConfig(config) {
    this.config = config;
    this.models = modelChain(config);
  }

  clearHistory() {
    this.messages = [{ role: 'system', content: this.systemPrompt }];
  }

  getHistory() {
    return this.messages.slice(1);
  }

  async compactIfNeeded(signal) {
    const size = this.messages.reduce((total, message) => total + messageSize(message), 0);
    if (size <= CONTEXT_CHARS || this.messages.length <= KEEP_RECENT + 2) return;

    const system = this.messages[0];
    const old = this.messages.slice(1, -KEEP_RECENT);
    const recent = this.messages.slice(-KEEP_RECENT);
    if (!old.length) return;

    let transcript = old
      .map((message) => {
        const content = typeof message.content === 'string' ? message.content : '';
        const tool = message.tool_calls ? ` [tool_calls: ${JSON.stringify(message.tool_calls)}]` : '';
        return `[${message.role}] ${content}${tool}`;
      })
      .join('\n\n');
    if (transcript.length > 30000) transcript = transcript.slice(-30000);

    try {
      const summary = await chatOnce({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.models[0],
        models: this.models.slice(1),
        messages: [
          {
            role: 'system',
            content: 'Sos un asistente que resume conversaciones técnicas de forma compacta.',
          },
          {
            role: 'user',
            content: `Resumí esta conversación en 10 bullets técnicos, sin código largo:\n\n${transcript}`,
          },
        ],
        maxTokens: 800,
        signal,
      });

      this.messages = [
        system,
        { role: 'user', content: `[Resumen de la conversación anterior]\n${summary}` },
        { role: 'assistant', content: 'Entendido. Continúo desde ese resumen.' },
        ...recent,
      ];
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      this.messages = [
        system,
        {
          role: 'user',
          content: '[Nota: la conversación anterior fue recortada por límite de contexto.]',
        },
        ...recent.filter((message) => message.role !== 'system'),
      ];
    }
  }

  async runTurn(input, { signal } = {}) {
    this.messages.push({ role: 'user', content: input });
    let usedAnyTool = false;
    let invalidRetried = false;

    for (let step = 0; step < MAX_STEPS; step += 1) {
      await this.compactIfNeeded(signal);

      let response;
      try {
        response = await streamChat({
          baseUrl: this.config.baseUrl,
          apiKey: this.config.apiKey,
          model: this.models[0],
          models: this.models.slice(1),
          messages: this.messages,
          tools: TOOL_SCHEMAS,
          signal,
          onDelta: (text) => this.ui.write(text),
          onRetry: (attempt, max) => this.ui.retry(attempt, max),
          onFallback: (from, to) => this.ui.line(`• ${from} no disponible; probando ${to}…`),
        });
      } catch (error) {
        this.ui.endStream();
        if (error && error.name === 'AbortError') return;
        throw error;
      }
      this.ui.endStream();
      if (response.model && response.model !== this.models[0]) {
        this.models = [response.model, ...this.models.filter((model) => model !== response.model)];
        this.config.model = response.model;
      }

      const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      if (!calls.length) {
        if (response.content && response.content.trim()) {
          this.messages.push({ role: 'assistant', content: response.content });
          if (!usedAnyTool && !this.nudgedNoTools && looksLikeNoTools(response.content)) {
            this.ui.line('El modelo no devolvió herramientas; probá /connect con otro modelo.');
            this.nudgedNoTools = true;
          }
        } else {
          this.ui.err('El modelo no devolvió respuesta.');
        }
        return;
      }

      const parsed = [];
      let invalid = false;
      for (const call of calls) {
        const raw = call.function && typeof call.function.arguments === 'string'
          ? call.function.arguments.trim()
          : '';
        let args;
        try {
          args = raw ? JSON.parse(raw) : {};
        } catch {
          invalid = true;
          break;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          invalid = true;
          break;
        }
        parsed.push({ call, args });
      }

      if (invalid) {
        if (!invalidRetried) {
          invalidRetried = true;
          this.ui.line('No pude interpretar la llamada, reintentando…');
          this.messages.push({
            role: 'user',
            content:
              '[sistema] Tu llamada a herramientas anterior tenía argumentos JSON inválidos. Respondé de nuevo con JSON válido.',
          });
          continue;
        }
        this.ui.err('El modelo devolvió argumentos inválidos dos veces. Corto el turno.');
        return;
      }

      const historyCalls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.function?.name || '',
          arguments: call.function?.arguments || '',
        },
      }));
      this.messages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: historyCalls,
      });

      for (const { call, args } of parsed) {
        usedAnyTool = true;
        const name = call.function?.name || '';
        const toolCallId = call.id;

        if (!TOOL_SCHEMAS.some((tool) => tool.function.name === name)) {
          this.ui.tool(name || '(sin nombre)');
          const result = `Error: herramienta desconocida: ${name}`;
          this.messages.push({ role: 'tool', tool_call_id: toolCallId, content: result });
          this.ui.err(result);
          continue;
        }

        if (CONFIRM_TOOLS.has(name)) {
          let plan;
          try {
            plan = planConfirmation(name, args, this.cwd);
          } catch (error) {
            const result = `Error: ${error.message}`;
            this.messages.push({ role: 'tool', tool_call_id: toolCallId, content: result });
            this.ui.err(result);
            continue;
          }
          const approved = plan.skipConfirm
            ? true
            : await this.ui.confirm(plan.label, plan.preview);
          if (!approved) {
            const result = 'cancelado por el usuario';
            this.messages.push({ role: 'tool', tool_call_id: toolCallId, content: result });
            this.ui.err('cancelado');
            continue;
          }
          if (plan.skipConfirm) this.ui.tool(name, describeToolCall(name, args));
        } else {
          this.ui.tool(name, describeToolCall(name, args));
        }

        let result;
        try {
          result = await executeTool(name, args, { cwd: this.cwd, signal });
        } catch (error) {
          if (error && error.name === 'AbortError') {
            this.messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: 'cancelado por el usuario',
            });
            throw error;
          }
          result = `Error: ${error.message || 'fallo desconocido'}`;
        }
        this.messages.push({ role: 'tool', tool_call_id: toolCallId, content: result });
        this.ui.result(result);
      }
    }

    this.ui.err('Alcancé el límite de 30 pasos sin terminar. Probá dividir la tarea.');
  }
}
