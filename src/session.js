import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';

const MAX_SESSION_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 2000;
const BACKUP_LIMIT_BYTES = 50 * 1024 * 1024;

export function sessionsDir() {
  return path.join(configDir(), 'sessions');
}

export function hashCwd(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 24);
}

export function sessionPath(cwd) {
  return path.join(sessionsDir(), `${hashCwd(cwd)}.json`);
}

export function sanitizeHistory(messages) {
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (!message || typeof message !== 'object') {
      i += 1;
      continue;
    }
    if (message.role === 'tool') {
      i += 1;
      continue;
    }
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      out.push(message);
      i += 1;
      continue;
    }

    const ids = message.tool_calls
      .map((call) => (call && typeof call.id === 'string' ? call.id : ''))
      .filter(Boolean);
    const uniqueIds = new Set(ids);
    const results = new Map();
    let next = i + 1;
    while (next < messages.length && messages[next] && messages[next].role === 'tool') {
      const result = messages[next];
      if (typeof result.tool_call_id === 'string' && !results.has(result.tool_call_id)) {
        results.set(result.tool_call_id, result);
      }
      next += 1;
    }

    const complete =
      ids.length === message.tool_calls.length &&
      uniqueIds.size === ids.length &&
      ids.length > 0 &&
      ids.every((id) => results.has(id));

    if (complete) {
      out.push(message);
      for (const id of ids) out.push(results.get(id));
    } else if (typeof message.content === 'string' && message.content.trim()) {
      out.push({ role: 'assistant', content: message.content });
    }
    i = next;
  }
  return out;
}

export function loadSession(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(cwd), 'utf8'));
    if (!Array.isArray(parsed)) return null;
    const filtered = parsed.filter(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') &&
        (typeof m.content === 'string' || m.content === null || Array.isArray(m.tool_calls)),
    );
    return sanitizeHistory(filtered);
  } catch {
    return null;
  }
}

export function saveSession(cwd, messages) {
  try {
    const mapped = messages
      .filter((m) => m && m.role !== 'system')
      .map((m) => {
        const out = { role: m.role };
        if (typeof m.content === 'string') {
          out.content = m.role === 'tool' ? m.content.slice(0, MAX_TOOL_RESULT_CHARS) : m.content;
        } else {
          out.content = m.content ?? null;
        }
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
      });

    let stored = sanitizeHistory(mapped).slice(-MAX_SESSION_MESSAGES);
    stored = sanitizeHistory(stored);

    const firstUser = stored.findIndex((m) => m.role === 'user');
    if (firstUser > 0) stored = stored.slice(firstUser);

    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = sessionPath(cwd);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // Nunca romper la sesión por no poder guardar.
  }
}

export function clearSession(cwd) {
  try {
    fs.rmSync(sessionPath(cwd), { force: true });
  } catch {
    // Ignorar.
  }
}

export function backupRoot(cwd) {
  return path.join(cwd, '.nyxen', 'backup');
}

export function backupStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function formatStamp(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(stamp));
  if (!match) return String(stamp);
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

export function ensureSelfIgnore(cwd) {
  const dir = path.join(cwd, '.nyxen');
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, '*\n', 'utf8');
  }
}

export function uniqueStamp(cwd) {
  const root = backupRoot(cwd);
  fs.mkdirSync(root, { recursive: true });
  const base = backupStamp();
  let stamp = base;
  let counter = 1;
  while (fs.existsSync(path.join(root, stamp))) {
    stamp = `${base}-${counter}`;
    counter += 1;
  }
  return stamp;
}

function relInside(cwd, abs) {
  const rel = path.relative(cwd, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('ruta fuera del directorio de trabajo.');
  }
  return rel;
}

function destinationFor(cwd, abs, stamp) {
  const rel = relInside(cwd, abs);
  const root = path.join(backupRoot(cwd), stamp);
  let dest = path.join(root, rel);
  let counter = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(root, `${rel}--${counter}`);
    counter += 1;
  }
  return dest;
}

export function copyToBackup(cwd, abs, stamp) {
  ensureSelfIgnore(cwd);
  const dest = destinationFor(cwd, abs, stamp);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  return dest;
}

export function moveToBackup(cwd, abs, stamp) {
  ensureSelfIgnore(cwd);
  const dest = destinationFor(cwd, abs, stamp);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(abs, dest);
  } catch {
    fs.cpSync(abs, dest, { recursive: true, preserveTimestamps: true });
    fs.rmSync(abs, { recursive: true, force: true });
  }
  return dest;
}

export function scanPath(abs) {
  const result = { files: 0, dirs: 0, bytes: 0, list: [] };
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return result;
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    result.files = 1;
    result.bytes = stat.size;
    result.list.push(path.basename(abs));
    return result;
  }

  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let info;
      try {
        info = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        result.dirs += 1;
        walk(full);
      } else {
        result.files += 1;
        result.bytes += info.size;
        if (result.list.length < 5) {
          const rel = path.relative(abs, full);
          result.list.push(rel);
        }
      }
    }
  };

  walk(abs);
  return result;
}

export function isRecoverableDelete(bytes) {
  return bytes < BACKUP_LIMIT_BYTES;
}

export function latestBackup(cwd) {
  const root = backupRoot(cwd);
  let stamps = [];
  try {
    stamps = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }

  for (const stamp of stamps) {
    const dir = path.join(root, stamp);
    const scan = scanPath(dir);
    if (scan.files > 0) {
      return { stamp, dir, files: scan.files, bytes: scan.bytes };
    }
  }
  return null;
}

export function listBackupFiles(cwd, stamp) {
  const root = path.join(backupRoot(cwd), stamp);
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(root, full));
    }
  };
  walk(root);
  return files;
}
