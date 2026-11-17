import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  copyToBackup,
  isRecoverableDelete,
  moveToBackup,
  scanPath,
  uniqueStamp,
} from './session.js';

const MAX_READ_LINES = 800;
const MAX_SEARCH_RESULTS = 80;
const MAX_TOOL_RESULT = 8000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'venv',
  '__pycache__',
  '.nyxen',
]);

export const CONFIRM_TOOLS = new Set(['write_file', 'edit_file', 'make_dir', 'delete', 'run_command']);
const TOOL_NAMES = new Set([
  'list_dir',
  'read_file',
  'search',
  'write_file',
  'edit_file',
  'make_dir',
  'delete',
  'run_command',
]);

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'Lista archivos y carpetas de una ruta dentro del directorio de trabajo. Omite carpetas ignoradas.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa a listar. Por defecto ".".' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Lee un archivo de texto con números de línea. Máximo 800 líneas por llamada e informa el total.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa del archivo.' },
          offset: { type: 'integer', description: 'Línea inicial (1-based). Por defecto 1.' },
          limit: { type: 'integer', description: 'Cantidad de líneas a devolver (máximo 800).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Busca texto de forma recursiva dentro del proyecto. Devuelve archivo:línea: texto. Máximo 80 resultados.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto a buscar.' },
          glob: { type: 'string', description: 'Filtro opcional de archivos, por ejemplo "*.ts".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Crea o sobrescribe un archivo de texto, creando las carpetas intermedias. Requiere confirmación.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa del archivo.' },
          content: { type: 'string', description: 'Contenido completo nuevo.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Reemplaza un bloque exacto y único dentro de un archivo. Si hay varias coincidencias, devuelve sus líneas. Requiere confirmación.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa del archivo.' },
          old_string: { type: 'string', description: 'Texto exacto a reemplazar.' },
          new_string: { type: 'string', description: 'Texto nuevo.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_dir',
      description: 'Crea una carpeta de forma recursiva. Requiere confirmación.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa de la carpeta.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete',
      description:
        'Borra un archivo o una carpeta. Para carpetas hay que pasar recursive: true. Requiere confirmación.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta relativa a borrar.' },
          recursive: { type: 'boolean', description: 'Borra la carpeta completa con su contenido.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Ejecuta un comando de consola en el directorio de trabajo. Timeout de 120 s, o 900 s para builds. Requiere confirmación.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando a ejecutar.' },
          cwd: { type: 'string', description: 'Subcarpeta donde ejecutarlo (opcional).' },
        },
        required: ['command'],
      },
    },
  },
];

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
  }
  return `${Math.round((n / (1024 * 1024 * 1024)) * 10) / 10} GB`;
}

export function quotePath(value) {
  const text = String(value ?? '');
  return /\s/.test(text) ? `"${text}"` : text;
}

function truncateOneLine(value, max = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function displayPath(cwd, abs) {
  const rel = path.relative(cwd, abs) || '.';
  return rel.split(path.sep).join('/');
}

function isInside(cwd, abs) {
  const rel = path.relative(cwd.toLowerCase(), abs.toLowerCase());
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function resolvePath(cwd, value) {
  const raw = typeof value === 'string' && value.trim() ? value : '.';
  const abs = path.resolve(cwd, raw);
  if (!isInside(cwd, abs)) throw new Error('ruta fuera del directorio de trabajo.');
  return abs;
}

function isCwdOrAncestor(cwd, abs) {
  const target = abs.toLowerCase();
  const root = target.endsWith(path.sep) ? target : `${target}${path.sep}`;
  return cwd.toLowerCase() === target || cwd.toLowerCase().startsWith(root);
}

function toCanonical(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function textLines(text) {
  const lines = toCanonical(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function readTextMeta(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) {
    throw new Error('archivo binario, no se puede leer como texto.');
  }
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8', bom ? 3 : 0);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { bom, eol, text };
}

function applyMeta(text, meta) {
  let out = toCanonical(String(text ?? '')).replace(/^\uFEFF/, '');
  if (meta && meta.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  if (meta && meta.bom) out = `\uFEFF${out}`;
  return out;
}

function globSource(glob) {
  let out = '';
  const text = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '*') {
      if (text[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$+.|()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function globRegex(glob) {
  return new RegExp(`^${globSource(glob)}$`, process.platform === 'win32' ? 'i' : '');
}

export function loadIgnorePatterns(cwd) {
  let content = '';
  try {
    content = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => {
      const dirOnly = /\/$/.test(line);
      const pattern = line.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!pattern) return null;
      return {
        dirOnly,
        hasSlash: pattern.includes('/'),
        regex: globRegex(pattern),
      };
    })
    .filter(Boolean);
}

export function isIgnored(rel, name, isDir, patterns) {
  if (isDir && IGNORED_DIRS.has(name)) return true;
  if (!isDir && name.endsWith('.lock')) return true;
  const posixRel = rel.split(path.sep).join('/');
  for (const pattern of patterns) {
    if (pattern.dirOnly && !isDir) continue;
    const target = pattern.hasSlash ? posixRel : name;
    if (pattern.regex.test(target)) return true;
  }
  return false;
}

function toolListDir(cwd, args) {
  const abs = resolvePath(cwd, args.path);
  if (!fs.existsSync(abs)) return `No existe: ${displayPath(cwd, abs)}`;
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    return `Error: ${displayPath(cwd, abs)} es un archivo; usá read_file para leerlo.`;
  }

  const patterns = loadIgnorePatterns(cwd);
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((entry) => {
      const rel = path.relative(cwd, path.join(abs, entry.name));
      return !isIgnored(rel, entry.name, entry.isDirectory(), patterns);
    })
    .sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

  const header = `# ${displayPath(cwd, abs)}`;
  if (!entries.length) return `${header}\n(vacío)`;

  const lines = [header];
  for (const entry of entries) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      lines.push(`[dir]  ${entry.name}/`);
    } else {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      lines.push(`[file] ${entry.name} (${formatSize(size)})`);
    }
  }
  return lines.join('\n');
}

function toolReadFile(cwd, args) {
  const abs = resolvePath(cwd, args.path);
  const display = displayPath(cwd, abs);
  if (!fs.existsSync(abs)) return `No existe: ${display}`;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return `Error: ${display} es una carpeta; usá list_dir.`;
  const meta = readTextMeta(abs);
  const lines = textLines(meta.text);
  const total = lines.length;

  let offset = Number.parseInt(args.offset, 10);
  if (!Number.isFinite(offset) || offset < 1) offset = 1;
  let limit = Number.parseInt(args.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = MAX_READ_LINES;
  limit = Math.min(limit, MAX_READ_LINES);

  const header = `# ${display} · ${total} líneas totales`;
  const start = offset - 1;
  if (start >= total) return `${header}\n(no hay líneas desde el offset ${offset})`;
  const end = Math.min(total, start + limit);
  const body = [];
  for (let i = start; i < end; i += 1) {
    body.push(`${String(i + 1).padStart(5, ' ')}: ${lines[i]}`);
  }
  return `${header}\n${body.join('\n')}`;
}

function toolSearch(cwd, args) {
  const query = String(args.query ?? '');
  if (!query) throw new Error('query vacía.');
  const needle = query.toLowerCase();
  const patterns = loadIgnorePatterns(cwd);
  const glob = args.glob ? globRegex(String(args.glob).replace(/\\/g, '/')) : null;
  const results = [];

  let stop = false;
  const walk = (dir) => {
    if (stop) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (stop) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(cwd, full);
      if (isIgnored(rel, entry.name, entry.isDirectory(), patterns)) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (glob && !glob.test(entry.name) && !glob.test(rel.split(path.sep).join('/'))) continue;

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8192).includes(0)) continue;
      const lines = toCanonical(buf.toString('utf8')).split('\n');
      const shown = rel.split(path.sep).join('/');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push(`${shown}:${i + 1}: ${truncateOneLine(lines[i], 200)}`);
          if (results.length >= MAX_SEARCH_RESULTS) {
            stop = true;
            return;
          }
        }
      }
    }
  };

  walk(cwd);
  if (!results.length) return `Sin resultados para "${query}".`;
  return results.join('\n');
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function occurrences(haystack, needle, max = 20) {
  const found = [];
  let index = 0;
  while (found.length < max) {
    const at = haystack.indexOf(needle, index);
    if (at === -1) break;
    found.push(at);
    index = at + needle.length;
  }
  return found;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function diceCoefficient(a, b) {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const count = grams.get(gram) || 0;
    if (count > 0) {
      grams.set(gram, count - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (left.length - 1 + (right.length - 1));
}

function closestLine(text, needle) {
  const lines = toCanonical(text).split('\n');
  const first = toCanonical(needle)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return null;
  let best = null;
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines[i].trim();
    if (!candidate) continue;
    const score = diceCoefficient(first, candidate);
    if (!best || score > best.score) {
      best = { score, line: truncateOneLine(candidate, 180), number: i + 1 };
    }
  }
  return best;
}

function toolWriteFile(cwd, args) {
  const abs = resolvePath(cwd, args.path);
  const rel = displayPath(cwd, abs);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    throw new Error(`${rel} es una carpeta.`);
  }

  const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
  let meta = null;
  if (fs.existsSync(abs)) {
    try {
      meta = readTextMeta(abs);
    } catch {
      meta = null;
    }
    try {
      copyToBackup(cwd, abs, uniqueStamp(cwd));
    } catch {
      return 'No pude crear el backup, cancelé la operación.';
    }
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const finalContent = applyMeta(content, meta);
  fs.writeFileSync(abs, finalContent, 'utf8');
  return `Escrito: ${rel} (${formatSize(Buffer.byteLength(finalContent, 'utf8'))})`;
}

function toolEditFile(cwd, args) {
  const abs = resolvePath(cwd, args.path);
  const rel = displayPath(cwd, abs);
  if (!fs.existsSync(abs)) return `No existe: ${rel}`;
  if (fs.statSync(abs).isDirectory()) throw new Error(`${rel} es una carpeta.`);

  const meta = readTextMeta(abs);
  const canonical = toCanonical(meta.text);
  const oldCanon = toCanonical(args.old_string);
  const newCanon = toCanonical(args.new_string);
  if (!oldCanon) throw new Error('old_string no puede estar vacío.');

  const count = countOccurrences(canonical, oldCanon);
  if (count === 0) {
    const close = closestLine(canonical, oldCanon);
    if (close) {
      throw new Error(
        `no encontré el fragmento en ${rel}. Lo más parecido (línea ${close.number}): ${close.line}`,
      );
    }
    throw new Error(`no encontré el fragmento en ${rel}.`);
  }
  if (count > 1) {
    const lines = occurrences(canonical, oldCanon).map((index) => lineNumberAt(canonical, index));
    const suffix = count > lines.length ? '…' : '';
    throw new Error(`Encontrado ${count} veces en las líneas ${lines.join(', ')}${suffix}`);
  }

  try {
    copyToBackup(cwd, abs, uniqueStamp(cwd));
  } catch {
    return 'No pude crear el backup, cancelé la operación.';
  }

  const updated = canonical.replace(oldCanon, () => newCanon);
  fs.writeFileSync(abs, applyMeta(updated, meta), 'utf8');
  return `Editado: ${rel} (1 reemplazo)`;
}

function toolMakeDir(cwd, args) {
  const abs = resolvePath(cwd, args.path);
  const rel = displayPath(cwd, abs);
  if (fs.existsSync(abs)) {
    if (fs.statSync(abs).isDirectory()) return `Ya existe: ${rel}/`;
    throw new Error(`${rel} ya existe y es un archivo.`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return `Creado: ${rel}/`;
}

function toolDelete(cwd, args) {
  const raw = path.resolve(cwd, typeof args.path === 'string' && args.path.trim() ? args.path : '.');
  if (isCwdOrAncestor(cwd, raw)) {
    throw new Error('no puedo borrar el directorio de trabajo ni sus padres.');
  }
  const abs = resolvePath(cwd, args.path);
  const rel = displayPath(cwd, abs);
  const nyxenDir = path.join(cwd, '.nyxen').toLowerCase();
  if (abs.toLowerCase() === nyxenDir || abs.toLowerCase().startsWith(`${nyxenDir}${path.sep}`)) {
    throw new Error('no puedo borrar archivos de .nyxen.');
  }
  if (!fs.existsSync(abs)) return `No existe: ${rel}`;
  const stat = fs.lstatSync(abs);
  if (stat.isDirectory() && !stat.isSymbolicLink() && !args.recursive) {
    throw new Error('Es una carpeta: llamá delete con recursive: true para borrarla completa.');
  }

  const scan = scanPath(abs);
  const recoverable = isRecoverableDelete(scan.bytes);
  let extra = '';
  if (recoverable) {
    try {
      moveToBackup(cwd, abs, uniqueStamp(cwd));
      extra = ' · recuperable';
    } catch {
      return 'No pude crear el backup, cancelé la operación.';
    }
  } else {
    fs.rmSync(abs, { recursive: true, force: true });
  }
  return `Borrado: ${rel} (${scan.files} archivos, ${formatSize(scan.bytes)}${extra})`;
}

function isLongBuild(command) {
  const text = command.toLowerCase();
  return [
    'gradle',
    'gradlew',
    'mvn',
    'npm install',
    'npm run build',
    'yarn',
    'pnpm',
    'cargo build',
    'dotnet build',
    'pip install',
    'go build',
  ].some((token) => text.includes(token));
}

export function commandBlocked(command) {
  const text = String(command);
  const patterns = [
    /(^|[&|;]\s*)format(?:\.com|\.exe)?(?:\s|$)/i,
    /\\format(?:\.com|\.exe)?(?:\s|$)/i,
    /\bdiskpart\b/i,
    /\bbcdedit\b/i,
    /\bshutdown\b/i,
    /\bRestart-Computer\b/i,
    /\bStop-Computer\b/i,
    /\bgit\s+push\b[^&|;]*\s(?:-f|--force)(?:\s|$)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[a-z]*f[a-z]*\b/i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  ];
  return patterns.some((regex) => regex.test(text));
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // Seguir con child.kill.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Ignorar.
  }
}

function toolRunCommand(cwd, args, ctx) {
  const command = String(args.command ?? '').trim();
  if (!command) throw new Error('comando vacío.');
  if (commandBlocked(command)) {
    return '✗ Comando bloqueado por seguridad. Usá la herramienta delete para borrar archivos o pedile al usuario que lo haga manualmente.';
  }

  let workdir = cwd;
  if (args.cwd) {
    workdir = resolvePath(cwd, args.cwd);
    if (!fs.existsSync(workdir)) throw new Error(`No existe el directorio: ${displayPath(cwd, workdir)}`);
    if (!fs.statSync(workdir).isDirectory()) throw new Error(`${displayPath(cwd, workdir)} no es una carpeta.`);
  }

  const timeoutMs = isLongBuild(command) ? 900000 : 120000;

  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: workdir, windowsHide: true })
        : spawn('sh', ['-c', command], { cwd: workdir });

    const chunks = [];
    let bytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let dropped = false;
    let forceTimer = null;

    const onData = (data) => {
      chunks.push(data);
      bytes += data.length;
      while (bytes > 2 * 1024 * 1024 && chunks.length > 1) {
        const removed = chunks.shift();
        bytes -= removed.length;
        dropped = true;
      }
    };

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };

    if (ctx && ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child);
      forceTimer = setTimeout(() => finish(null), 5000);
    }, timeoutMs);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (ctx && ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

      if (aborted) {
        const error = new Error('abortado');
        error.name = 'AbortError';
        reject(error);
        return;
      }

      let text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
      let lines = text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      let truncated = dropped;
      if (lines.length > 800) {
        lines = lines.slice(-800);
        truncated = true;
      }
      const body = lines.join('\n');

      if (timedOut) {
        const message = `Timeout de ${Math.round(timeoutMs / 1000)} s. Probá correrlo en una terminal aparte.`;
        let tail = body;
        if (tail.length > 7000) tail = `… (salida truncada)\n${tail.slice(-7000)}`;
        resolve(tail ? `${message}\n${tail}` : message);
        return;
      }

      let result = body || '(sin salida)';
      if (truncated) result = `… (salida truncada, mostrando el final)\n${result}`;
      if (typeof code === 'number' && code !== 0) result += `\nExit code: ${code}`;
      if (result.length > 7800) {
        result = `… (salida truncada, mostrando el final)\n${result.slice(-7800)}`;
      }
      resolve(result);
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (ctx && ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      reject(new Error(`no pude ejecutar el comando: ${error.message}`));
    });
    child.on('close', finish);
  });
}

export function describeToolCall(name, args = {}) {
  const p = args.path ?? '.';
  switch (name) {
    case 'list_dir':
    case 'read_file':
    case 'edit_file':
      return quotePath(p);
    case 'make_dir':
      return `${quotePath(p)}/`;
    case 'search':
      return `${JSON.stringify(String(args.query ?? ''))}${args.glob ? ` (${args.glob})` : ''}`;
    case 'write_file':
      return quotePath(p);
    case 'delete':
      return `${quotePath(p)}${args.recursive ? ' (recursivo)' : ''}`;
    case 'run_command':
      return truncateOneLine(args.command);
    default:
      return '';
  }
}

function editPreview(cwd, args) {
  try {
    const abs = resolvePath(cwd, args.path);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return '';
    const meta = readTextMeta(abs);
    const canonical = toCanonical(meta.text);
    const oldCanon = toCanonical(args.old_string);
    const newCanon = toCanonical(args.new_string);
    const at = canonical.indexOf(oldCanon);
    if (at === -1) return '';

    const before = canonical.slice(0, at);
    const after = canonical.slice(at + oldCanon.length);
    const contextBefore = before
      .split('\n')
      .slice(-2)
      .map((line) => `  ${truncateOneLine(line, 160)}`)
      .filter((line) => line.trim() !== '');
    const contextAfter = after
      .split('\n')
      .slice(0, 2)
      .map((line) => `  ${truncateOneLine(line, 160)}`)
      .filter((line) => line.trim() !== '');
    const removed = oldCanon.split('\n').map((line) => `- ${truncateOneLine(line, 160)}`);
    const added = newCanon.split('\n').map((line) => `+ ${truncateOneLine(line, 160)}`);

    let lines = [...contextBefore, ...removed, ...added, ...contextAfter];
    if (lines.length > 15) {
      lines = [...lines.slice(0, 14), '… (diff truncado)'];
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function deletePlan(cwd, args) {
  const raw = path.resolve(cwd, typeof args.path === 'string' && args.path.trim() ? args.path : '.');
  if (isCwdOrAncestor(cwd, raw)) {
    throw new Error('no puedo borrar el directorio de trabajo ni sus padres.');
  }
  const abs = resolvePath(cwd, args.path);
  const rel = displayPath(cwd, abs);
  const nyxenDir = path.join(cwd, '.nyxen').toLowerCase();
  if (abs.toLowerCase() === nyxenDir || abs.toLowerCase().startsWith(`${nyxenDir}${path.sep}`)) {
    throw new Error('no puedo borrar archivos de .nyxen.');
  }
  if (!fs.existsSync(abs)) {
    return { label: `delete ${quotePath(rel)} (no existe)`, preview: '', skipConfirm: true };
  }

  const stat = fs.lstatSync(abs);
  if (stat.isDirectory() && !stat.isSymbolicLink() && !args.recursive) {
    throw new Error('Es una carpeta: llamá delete con recursive: true para borrarla completa.');
  }

  const scan = scanPath(abs);
  const recoverable = isRecoverableDelete(scan.bytes);
  const isDir = stat.isDirectory() && !stat.isSymbolicLink();
  const label =
    `delete ${quotePath(rel)}${isDir ? '/' : ''} ` +
    `(${isDir ? 'recursivo · ' : ''}${scan.files} archivos · ${formatSize(scan.bytes)}` +
    `${recoverable ? ' · recuperable' : ''})`;

  let preview = '';
  if (isDir) {
    if (scan.files <= 5) {
      preview = scan.list.map((file) => `- ${file}`).join('\n');
    } else {
      preview = `Directorio afectado: ${rel}/`;
    }
  }
  return { label, preview };
}

export function planConfirmation(name, args, cwd) {
  switch (name) {
    case 'write_file': {
      const rel = displayPath(cwd, resolvePath(cwd, args.path));
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      let exists = false;
      try {
        exists = fs.existsSync(resolvePath(cwd, args.path)) && fs.statSync(resolvePath(cwd, args.path)).isFile();
      } catch {
        exists = false;
      }
      const size = formatSize(Buffer.byteLength(applyMeta(content, null), 'utf8'));
      return { label: `write ${quotePath(rel)} (${size}${exists ? ' · sobrescribe' : ''})`, preview: '' };
    }
    case 'edit_file': {
      const rel = displayPath(cwd, resolvePath(cwd, args.path));
      return { label: `edit ${quotePath(rel)}`, preview: editPreview(cwd, args) };
    }
    case 'make_dir': {
      const rel = displayPath(cwd, resolvePath(cwd, args.path));
      return { label: `make_dir ${quotePath(rel)}/`, preview: '' };
    }
    case 'delete':
      return deletePlan(cwd, args);
    case 'run_command': {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('comando vacío.');
      if (commandBlocked(command)) {
        return { label: `run_command ${truncateOneLine(command)}`, preview: '', skipConfirm: true };
      }
      const where = args.cwd ? ` (en ${quotePath(args.cwd)})` : '';
      return { label: `run_command ${truncateOneLine(command)}${where}`, preview: '' };
    }
    default:
      return { label: name, preview: '' };
  }
}

export async function executeTool(name, args, ctx = {}) {
  const cwd = ctx.cwd;
  let result;
  try {
    if (!TOOL_NAMES.has(name)) throw new Error(`herramienta desconocida: ${name}`);
    switch (name) {
      case 'list_dir':
        result = toolListDir(cwd, args || {});
        break;
      case 'read_file':
        result = toolReadFile(cwd, args || {});
        break;
      case 'search':
        result = toolSearch(cwd, args || {});
        break;
      case 'write_file':
        result = toolWriteFile(cwd, args || {});
        break;
      case 'edit_file':
        result = toolEditFile(cwd, args || {});
        break;
      case 'make_dir':
        result = toolMakeDir(cwd, args || {});
        break;
      case 'delete':
        result = toolDelete(cwd, args || {});
        break;
      case 'run_command':
        result = await toolRunCommand(cwd, args || {}, ctx);
        break;
      default:
        result = `Error: herramienta desconocida: ${name}`;
    }
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    const message = error && error.message ? error.message : 'fallo desconocido';
    result = /^Error:/.test(message) ? message : `Error: ${message}`;
  }

  result = String(result ?? '');
  if (result.length > MAX_TOOL_RESULT) {
    result = `${result.slice(0, MAX_TOOL_RESULT - 15)}\n… (truncado)`;
  }
  return result;
}
