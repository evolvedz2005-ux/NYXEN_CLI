import { isConfigured, providerLabel } from './config.js';
import { formatStamp } from './session.js';

function firstLine(text, max = 160) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((item) => item.trim()) || '';
  const clean = line.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function isFailure(text) {
  const value = String(text || '').trim();
  return (
    /^(Error:|✗|No pude crear el backup|No existe:|Timeout de )/.test(value) ||
    /\nExit code: [1-9][0-9]*\s*$/.test(value)
  );
}

export class UI {
  constructor({ input = process.stdin, output = process.stdout, noColor = false } = {}) {
    this.input = input;
    this.output = output;
    this.noColor = noColor;
    this.rl = null;
    this.mode = 'input';
    this.atLineStart = true;
    this.pendingResolve = null;
  }

  attach(rl) {
    this.rl = rl;
  }

  write(text) {
    const value = String(text ?? '');
    if (!value) return;
    this.output.write(value);
    this.atLineStart = value.endsWith('\n');
  }

  line(text = '') {
    this.write(`${text}\n`);
  }

  endStream() {
    if (!this.atLineStart) this.line();
  }

  banner(cwd, config, extra = '') {
    this.line(`NYXEN_CLI  ·  ${cwd}`);
    if (isConfigured(config)) {
      this.line(`✓ ${providerLabel(config.baseUrl)} · ${config.model}`);
    } else {
      this.line('Sin conexión. Escribí /connect para configurar la API.');
    }
    if (extra) this.line(extra);
    this.line();
  }

  restored(count) {
    const label = count === 1 ? 'mensaje' : 'mensajes';
    this.line(`↺ Sesión anterior restaurada (${count} ${label}). Decí "empezá de cero" para limpiarla.`);
  }

  backupInfo(info) {
    const label = info.files === 1 ? 'archivo' : 'archivos';
    this.line(
      `↺ Último backup: ${formatStamp(info.stamp)} (${info.files} ${label}). Decí "restaurá el backup" para volver atrás.`,
    );
  }

  tool(name, summary = '') {
    this.line(`• ${name}${summary ? ` ${summary}` : ''}`);
  }

  ok(text) {
    this.line(`✓ ${text}`);
  }

  err(text) {
    this.line(`✗ ${text}`);
  }

  retry(attempt, max) {
    this.line(`• reintentando (${attempt}/${max})…`);
  }

  result(text) {
    const line = firstLine(text);
    if (!line) return;
    if (line.startsWith('✗')) this.line(line);
    else if (isFailure(text)) this.err(line);
    else this.ok(line);
  }

  async ask(prompt, { defaultValue = '', hidden = false } = {}) {
    if (!this.rl) throw new Error('readline no inicializado.');
    const previous = this.mode;
    this.mode = 'ask';
    let restore = null;
    try {
      if (hidden && this.input.isTTY) {
        restore = this.rl._writeToOutput;
        this.rl._writeToOutput = () => {};
        this.write(prompt);
        const answer = await this.question();
        if (Array.isArray(this.rl.history)) this.rl.history.length = 0;
        this.line();
        return String(answer).trim() || defaultValue;
      }
      this.write(prompt);
      const answer = await this.question();
      return String(answer).trim() || defaultValue;
    } finally {
      if (restore) this.rl._writeToOutput = restore;
      this.mode = previous;
    }
  }

  question() {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  submitAnswer(value) {
    if (!this.pendingResolve) return false;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve(value);
    return true;
  }

  cancelPrompt() {
    this.submitAnswer('');
  }

  async confirm(label, preview = '') {
    if (!this.rl || !this.input.isTTY) {
      this.err('No puedo pedir confirmación en una terminal no interactiva; cancelé la acción.');
      return false;
    }

    const previous = this.mode;
    this.mode = 'confirm';
    try {
      if (preview) {
        this.line(`• ${label}`);
        for (const line of String(preview).split('\n')) this.line(`  ${line}`);
        this.write('  ¿continuar? [s/N] ');
      } else {
        this.write(`• ${label}  ¿continuar? [s/N] `);
      }
      const answer = await this.question();
      return /^(s|si|sí|y|yes)$/i.test(String(answer).trim());
    } finally {
      this.mode = previous;
    }
  }
}
