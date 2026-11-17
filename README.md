# NYXEN_CLI — especificación completa (handoff para Freebuff)

CLI de IA para **Windows** que vive en la terminal: se instala con un comando, se abre
escribiendo `nyxen`, y **trabaja directamente sobre tus proyectos** (lee archivos, crea
carpetas y archivos, edita, ejecuta comandos) usando **solo la API de FreeLLMAPI**.

> **Qué es esto (categoría):** un *CLI coding agent* / *agente de IA para la terminal*.
> Ejemplos del género: OpenCode, Freebuff, Claude Code, Aider, Codex CLI.
>
> **Este archivo es la especificación.** Copiá esta carpeta al PC y pedile a Freebuff que
> lo implemente tal cual. Al final está el prompt listo para pegar (§15) y la checklist
> con la que se considera terminado (§13).

---

## 1. Qué debe poder hacer (resultado final)

Ejecutás `nyxen` dentro de una carpeta y podés:

```
› creame una landing page en HTML y CSS para una cafetería
• list_dir .
• write index.html
• write styles.css
✓ Listo: index.html y styles.css creados. Abrilo con doble clic.
```

```
› en este proyecto agregá validación al formulario de login
• list_dir .
• search "login"
• read src/components/Login.tsx
• edit src/components/Login.tsx
✓ Agregué la validación de email y contraseña en Login.tsx (líneas 42–58).
```

```
› borrá la carpeta old-tests, ya no la uso
• delete old-tests/ (recursivo · 12 archivos · 48 KB)  ¿continuar? [s/N] s
✓ Borré old-tests/ (12 archivos).
```

Es decir: **entiende el proyecto, escribe y borra archivos reales en disco y verifica lo
que hizo**, todo en la misma terminal, sin copiar y pegar.

---

## 2. Decisiones cerradas

| Decisión        | Valor                                                             |
| --------------- | ----------------------------------------------------------------- |
| Nombre          | **NYXEN_CLI** (paquete `nyxen_cli`, comando de consola `nyxen`)    |
| SO              | Windows (PowerShell / CMD / Windows Terminal)                      |
| Stack           | Node.js 20+ (ESM), **cero dependencias de npm**                    |
| Interfaz        | Minimalista: texto plano, prompt `› `, streaming, líneas de acción |
| Entrada         | Multilínea (pegado) y `Alt+Enter` para seguir escribiendo          |
| Deshacer        | Copia automática en `.nyxen/backup/` antes de escribir o borrar    |
| Sesiones        | Se guardan por carpeta y se retoman al reabrir                     |
| Comandos        | **Solo dos: `/connect` y `/exit`**                                 |
| Proveedor       | FreeLLMAPI únicamente (endpoint compatible con OpenAI)            |
| Escrituras      | Con confirmación del usuario, borrado incluido (ver §9)            |

Regla dura de comandos: **no** existen `/help`, `/clear`, `/model`, `/init`, etc.
Si el usuario escribe algo que empieza con `/` y no es `/connect` o `/exit`:

```
Comando desconocido. Disponibles: /connect, /exit
```

Todo lo demás que tipea el usuario es una **instrucción para el agente**.

---

## 3. Requisitos

1. **Node.js 20 o superior** (con npm). Si falta:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   Cerrá y reabrí la terminal, luego verificá:
   ```powershell
   node -v    # v20.x o mayor
   npm -v
   ```
2. Una **API key de FreeLLMAPI** (`sk_live_...` para el servicio hospedado).
3. Opcional para el agente: `git` en el PATH (para `git diff` / `git status`).

---

## 4. Instalación

Desde la carpeta del proyecto (donde está `package.json`):

```powershell
npm install -g .
```

Comprobación:

```powershell
nyxen --version   # 0.1.0
```

A partir de ahí `nyxen` funciona desde cualquier carpeta:

```powershell
cd C:\Users\tu-usuario\proyectos\mi-app
nyxen
```

Si PowerShell bloquea el shim (`nyxen.ps1 cannot be loaded`), ver §14.

### 4.1 Instalación en un comando (desde otro PC)

Para que `npm install -g ...` funcione en cualquier PC, el código tiene que estar
publicado en algún lugar accesible. Hay tres caminos; el **A** es el más rápido.

**Opción A — GitHub (recomendada, no hace falta publicar en npm)**

1. Crear un repo **público** en GitHub y subir la carpeta del proyecto:

   ```powershell
   cd NYXEN_CLI
   git init
   git add .
   git commit -m "NYXEN_CLI"
   git branch -M main
   git remote add origin https://github.com/evolvedz2005-ux/NYXEN_CLI.git
   git push -u origin main
   ```

2. En cualquier PC con Node 20+ y git:

   ```powershell
   npm install -g github:evolvedz2005-ux/NYXEN_CLI
   nyxen
   ```

   Sin clonar nada, sin `npm login`. npm baja el repo, instala y crea el comando
   global usando el campo `bin` del `package.json`.

   Si el repo es privado, el comando pide credenciales de GitHub
   (`https://github.com/evolvedz2005-ux/NYXEN_CLI.git`) o hay que usar un token.

**Opción B — npm público (`npm i -g nyxen_cli`)**

1. Crear cuenta en <https://www.npmjs.com> y iniciar sesión en la terminal:
   `npm login`
2. Comprobar que el nombre esté libre: `npm view nyxen_cli` (debe dar 404).
3. Publicar:

   ```powershell
   npm publish
   ```

4. En cualquier PC:

   ```powershell
   npm install -g nyxen_cli
   ```

Notas: el nombre del paquete es único a nivel mundial; si `nyxen_cli` está tomado,
usar un scope (`@tu-usuario/nyxen-cli`, requiere `npm publish --access public`). El
comando que se escribe en consola sigue siendo `nyxen` (viene del campo `bin`). Si el
paquete incluye una API key hardcodeada, **no** publicarlo.

**Opción C — Release + script de una línea (sin npm ni git)**

Útil para amigos sin Node instalado. En el repo, un script `install.ps1`:

```powershell
# install.ps1 — uso: irm https://raw.githubusercontent.com/evolvedz2005-ux/NYXEN_CLI/main/install.ps1 | iex
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
}
npm install -g "github:evolvedz2005-ux/NYXEN_CLI"
Write-Host "Listo. Abrí una terminal nueva y escribí: nyxen"
```

Y el comando único para el usuario final:

```powershell
irm https://raw.githubusercontent.com/evolvedz2005-ux/NYXEN_CLI/main/install.ps1 | iex
```

> Antes de instalar en otra PC: el repo debe incluir el `package.json` con
> `"bin": { "nyxen": "bin/nyxen.js" }` y `"files": ["bin", "src", "README.md"]`,
> y **nunca** el `config.json` con la API key (ese archivo vive en `%APPDATA%`, no en
> el repo). Agregar `.gitignore` con `node_modules/`, `*.log` y `config.json`.

### 4.2 Verificar la instalación

```powershell
nyxen --version      # 0.1.0
nyxen --help         # uso básico (no es un comando de barra, es flag de arranque)
```

Después de instalar o actualizar, hay que abrir una terminal nueva para que el `PATH`
tome el shim recién creado.

### 4.3 Actualizar / desinstalar

```powershell
npm install -g github:evolvedz2005-ux/NYXEN_CLI   # actualizar (Opción A)
npm update -g nyxen_cli                      # actualizar (Opción B)
npm uninstall -g nyxen_cli                   # desinstalar
```

---

## 5. Primer uso: `/connect`

Único flujo de configuración. Pasos exactos:

1. Pide la **API key** con entrada oculta (no se ve lo que se tipea).
2. Pide la **base URL** sin default visible (`Base URL:`). El usuario pega la que
   muestra FreeLLMAPI (por ejemplo `https://api.freellmapi.ai/v1`, o
   `http://localhost:3001/v1` si autoaloja el router). Si queda vacía, cancela.
3. **Descubre los modelos disponibles** con `GET {baseUrl}/models?available=true`:
   - incluye `available !== false` y los que declaran `tools` en `supported_parameters`;
   - incluye los slots sin metadata (por ejemplo `claude-sonnet-4-5`);
   - excluye `auto`, `fusion` y los modelos que declaran no soportar tools;
   - si `?available=true` no existe (400/404/405), cae a `GET {baseUrl}/models` y filtra
     la disponibilidad del lado de NYXEN;
   - si el endpoint falla, sigue con la cadena configurada y no bloquea `/connect`.
4. Pide el **modelo** con `Modelo (Enter = automático):`.
   - Enter o `auto` → usa la cadena configurada + los modelos descubiertos y guarda el
     primero que funcione.
   - Si se escribe un modelo, se usa como principal y los respaldos se prueban después.
5. **Valida antes de guardar**:
   - `POST {baseUrl}/chat/completions` con
     `{ model, messages: [{role:"user", content:"ping"}], max_tokens: 1, stream: false }`
   - Si además se quiere validar tool calling: repetir con un `tools` trivial y comprobar
     que la respuesta no sea un error.
   - Si el modelo elegido falla por disponibilidad (404/429/5xx o
     `no_providers_configured`), prueba automáticamente el resto de la cadena y guarda
     el primero que funcione.
   - Si **ninguno** funciona → mostrar `HTTP <status>` + cuerpo recortado a 400 caracteres,
     **no** guardar nada, seguir en el REPL.
6. Guarda en `%APPDATA%\NYXEN_CLI\config.json`:

   ```json
   {
     "baseUrl": "https://api.freellmapi.ai/v1",
     "model": "claude-sonnet-4-5",
     "apiKey": "sk_live_xxx",
     "fallbackModels": ["poolside-laguna-xs-2.1", "qwen3.7-flash"]
   }
   ```

7. Confirmación en una línea, nunca mostrando la key completa:

   ```
   ✓ Conectado a freellmapi · modelo claude-sonnet-4-5
   ```

`/connect` de nuevo reemplaza la configuración existente. Si hay `LUMI_*`… no: usar solo
estas variables de entorno opcionales, con prioridad sobre el archivo:
`NYXEN_API_KEY`, `NYXEN_BASE_URL`, `NYXEN_MODEL`, `NYXEN_FALLBACK_MODELS`
(lista separada por comas) y alias `FREELMAPI_API_KEY`.

**Descubrimiento de modelos**: al abrir NYXEN y al usar `/connect`, consulta
`GET {baseUrl}/models?available=true` para conocer los modelos que el usuario tiene
realmente disponibles en FreeLLMAPI. La cadena activa se arma así:

1. los modelos de la config que figuran como disponibles, en su orden;
2. todos los demás modelos descubiertos con tool calling, en el orden del gateway;
3. los modelos de la config que no figuran en la lista, al final (por si el gateway no
   los lista pero siguen funcionando).

`/connect` guarda una instantánea de la cadena en `fallbackModels`; el arranque la
refresca en memoria, sin reescribir el archivo. Así los modelos agregados después en
FreeLLMAPI se usan solos al volver a abrir NYXEN.

**Failover de modelos**: si el modelo activo no está disponible, NYXEN prueba en orden la
cadena activa y avisa `• X no disponible; probando Y…`. Solo cambia ante errores de
disponibilidad (404/429/5xx, timeout, `no_providers_configured`); nunca ante 401/403 ni
errores de la petición. El modelo que funcione queda primero para el resto de la sesión.

```json
{
  "baseUrl": "https://api.freellmapi.ai/v1",
  "model": "claude-sonnet-4-5",
  "apiKey": "sk_live_xxx",
  "fallbackModels": ["poolside-laguna-xs-2.1", "qwen3.7-flash", "bazaarlink-auto"]
}
```

---

## 6. Interfaz (minimalista)

```
NYXEN_CLI  ·  C:\Users\ana\proyectos\mi-app
✓ freellmapi · claude-sonnet-4-5
• 47 modelos disponibles en FreeLLMAPI.

› agregá un README con instrucciones de instalación
• list_dir .
• read package.json
• write README.md
Listo: creé README.md con instalación, uso y scripts disponibles.

› /exit
Adiós.
```

Reglas visuales:

- Banner de 2–3 líneas con nombre, `cwd` y modelo. Nada de cajas grandes ni arte ASCII.
- Prompt `› ` para el usuario; `• ` para cada herramienta; `✓ `/`✗ ` para resultado.
- Entrada **multilínea**: pegar texto con saltos de línea lo envía como un solo mensaje
  (no rompe el REPL ni manda una instrucción por línea). `Alt+Enter` agrega otra línea a
  mano; una línea vacía finaliza el mensaje.
- Las respuestas del modelo en streaming, texto plano (sin renderizar Markdown ni ANSI
  decorativo). Respetar `NO_COLOR=1`.
- Al iniciar sin config: una línea indicando `/connect`.
- Ctrl+C durante una respuesta → aborta la petición (AbortController) y vuelve al prompt.
  Ctrl+C en el prompt vacío → avisa `Usá /exit para salir.` y sigue. Ctrl+D → sale.

---

## 7. Comandos

### `/connect`
Descrito en §5. Es el **único** camino para configurar la API key.

### `/exit`
Cierra con código 0 y una línea: `Adiós.` No borra la config.

---

## 8. Modo agente (el corazón del CLI)

### 8.1 Loop

```
messages = [system, ...historial]
bucle (máx. 30 pasos):
    respuesta = streamChat({ model, messages, tools })   # streaming
    si respuesta.content: imprimir en streaming
    si no hay tool_calls: terminar turno
    para cada tool_call:
        mostrar "• <tool>(<arg resumen>)"
        si requiere confirmación y el usuario dice no → devolver "cancelado por el usuario"
        ejecutar → resultado (recortado a 8000 caracteres)
        messages.push({ role:"tool", tool_call_id, content: resultado })
```

Detalles obligatorios:

- `stream: true` siempre. Los `tool_calls` llegan **fragmentados** en el stream
  (`choices[0].delta.tool_calls[i].function.arguments` por partes): acumular por `index`
  y parsear el JSON al cerrar (`finish_reason === "tool_calls"`).
- Si el modelo devuelve `tool_calls` con JSON inválido: reintentar **una vez** avisando
  `No pude interpretar la llamada, reintentando…`; si vuelve a fallar, mostrar error y
  cortar el turno (sin romper el REPL).
- Si el modelo no soporta tools (responde solo texto a una instrucción que requiere
  archivos), decirlo una vez: `El modelo no devolvió herramientas; probá /connect con
  otro modelo.` y no entrar en bucle.
- **Presupuesto de contexto**: si el historial supera ~80k caracteres, resumir los
  mensajes viejos con una llamada corta al mismo modelo (`Resumí esta conversación en 10
  bullets técnicos, sin código largo`) y reemplazarlos por ese resumen. Conservar siempre
  el system prompt y los últimos 6 mensajes. Si el resumen falla, recortar y seguir: nunca
  romper la sesión.
- **Reintentos de red**: en 429/500/502/503/504 reintentar hasta 3 veces con espera 2 s,
  5 s y 10 s, mostrando `• reintentando (2/3)…`. Si se agotan, mostrar el error y volver
  al prompt.

### 8.2 System prompt (base, ajustable)

```
Sos NYXEN_CLI, un agente de programación que trabaja en la terminal.
Directorio de trabajo: {{cwd}}
Sistema: {{platform}} · Node {{nodeVersion}}

Reglas:
- Usá las herramientas para inspeccionar y modificar archivos; no inventes contenido
  de archivos que no leíste.
- Antes de editar, leé el archivo. Preferí ediciones puntuales sobre reescribir todo.
- Nunca escribas fuera del directorio de trabajo.
- Nunca ejecutes comandos destructivos (borrados masivos, git reset --hard, push --force).
- Verificá tu trabajo cuando sea posible (leer el resultado o correr un comando de check).
- Respuestas finales: 1–4 líneas, en el idioma del usuario, sin repetir el código.
```

Agregar al system prompt un listado del árbol del proyecto (profundidad 2) excluyendo
`node_modules`, `.git`, `dist`, `build`, `.next`, `venv`, `__pycache__`, `*.lock`.

### 8.3 Herramientas (esquemas exactos)

Declarar en el request como `tools: [{ type: "function", function: {...} }]`.

| Herramienta   | Args                              | Acción | Confirma |
| ------------- | --------------------------------- | ------ | -------- |
| `list_dir`    | `{ path?: string }`               | Lista entradas (nombre, tipo, tamaño) del `cwd` o subcarpeta. Oculta las carpetas ignoradas | no |
| `read_file`   | `{ path: string, offset?: number, limit?: number }` | Devuelve el contenido con números de línea. Máx. 800 líneas por llamada e informa el total del archivo | no |
| `search`      | `{ query: string, glob?: string }` | Búsqueda de texto recursiva (implementar en JS, sin ripgrep): devuelve `archivo:línea: texto`, máx. 80 resultados | no |
| `write_file`  | `{ path: string, content: string }` | Crea o **sobrescribe** el archivo, creando carpetas intermedias | sí |
| `edit_file`   | `{ path: string, old_string: string, new_string: string }` | Reemplazo exacto de un bloque único (si no es único, devuelve las líneas de cada coincidencia) | sí |
| `make_dir`    | `{ path: string }`                | Crea una carpeta (recursivo) | sí |
| `delete`      | `{ path: string, recursive?: boolean }` | Borra un archivo, o una carpeta si `recursive: true`. Devuelve cuántos archivos borró | sí (mostrando el detalle) |
| `run_command` | `{ command: string, cwd?: string }` | Ejecuta con `cmd.exe /d /s /c` en Windows. Timeout 120 s (900 s para builds), devuelve stdout+stderr (últimas 800 líneas) | sí |

Reglas de implementación:

- Todas las rutas se resuelven contra el `cwd` de la sesión con `path.resolve`, y se
  rechaza cualquiera que empiece con `..` o caiga fuera del `cwd`:
  `Error: ruta fuera del directorio de trabajo.`
- `read_file`:
  - La primera línea del resultado siempre es `# <ruta> · <N> líneas totales`.
  - Si el archivo es binario (byte nulo en los primeros 8 KB) →
    `Error: archivo binario, no se puede leer como texto.`
- `edit_file`:
  - Si `old_string` aparece **exactamente una vez** → reemplaza.
  - Si aparece 0 veces → error con el fragmento más parecido y su número de línea.
  - Si aparece 2+ veces → devolver `Encontrado N veces en las líneas 12, 48, 91` para que
    el modelo agregue contexto y vuelva a intentar.
- `run_command`:
  - Rechazar comandos vacíos; citar la ruta de trabajo si tiene espacios.
  - **Timeout según el comando**: 900 s para `gradle`, `gradlew`, `mvn`, `npm install`,
    `npm run build`, `yarn`, `pnpm`, `cargo build`, `dotnet build`, `pip install`,
    `go build`; 120 s para todo lo demás. Al vencer: matar el árbol de procesos y
    devolver `Timeout de <N> s. Probá correrlo en una terminal aparte.`
  - Salida máxima 800 líneas; si se excede, devolver **las últimas 800** (ahí está el
    error real de un build).
- `delete` (borrado que el usuario pidió, debe funcionar bien):
  - Antes de borrar, **recorrer** la ruta para contar archivos, carpetas y tamaño total.
  - Si la ruta es una carpeta y no llega `recursive: true` → error explícito:
    `Es una carpeta: llamá delete con recursive: true para borrarla completa.`
  - Rechazar rutas que resuelvan al `cwd` o a un ancestro suyo (`delete .`, `delete ..`,
    `delete C:\`) → `Error: no puedo borrar el directorio de trabajo ni sus padres.`
  - Borrar con `fs.rmSync(ruta, { recursive: true, force: true })` y devolver
    `Borrado: <ruta> (<N> archivos, <tamaño>)`.
  - Si la ruta no existe: `No existe: <ruta>`. No es un crash.
- Los resultados de herramientas se recortan a 8000 caracteres con un sufijo
  `… (truncado)`.

### 8.4 Confirmaciones (no negociable)

Antes de `write_file`, `edit_file`, `make_dir`, `delete` y `run_command`:

```
• write src/index.html (2.1 KB)  ¿continuar? [s/N]
• delete old-tests/ (recursivo · 12 archivos · 48 KB)  ¿continuar? [s/N]
```

- Enter o `n` → cancela esa acción y el agente sigue su razonamiento.
- Antes de escribir o borrar se crea una copia en `.nyxen/backup/` (§9.2), así que decir
  `s` nunca es irreversible.
- Con `edit_file`, mostrar un diff corto (máx. 15 líneas) antes de preguntar.
- Con `delete`, mostrar **siempre** qué se borra y cuánto: lista de archivos si son 5 o
  menos; si son más, solo `N archivos · tamaño total` y el directorio raíz afectado.
  Nunca un `¿continuar?` genérico sin detalle.
- Si el usuario responde `s` **y** la sesión está en una terminal no interactiva
  (piped), abortar con un error claro en lugar de esperar input.

### 8.5 Contexto del proyecto y verificación

- **`NYXEN.md`**: si existe en el `cwd`, su contenido (máx. 6000 caracteres) se agrega al
  system prompt bajo `## Contexto del proyecto (NYXEN.md)`. Es donde el usuario documenta
  stack, versiones y convenciones ("mod Fabric 1.20.1, Java 17, código en src/main/java").
  Se lee solo al arrancar: **no** hay comando ni flag para esto.
- **Reglas de ignorado**: excluir del árbol y de `search` a `node_modules`, `.git`,
  `dist`, `build`, `.next`, `venv`, `__pycache__`, `.nyxen` y `*.lock`; si existe
  `.gitignore`, respetar sus patrones simples de primer nivel.
- **Verificación después de editar**: el system prompt obliga a cerrar el turno corriendo
  el check del proyecto si se conoce uno (`npm test`, `npm run build`, `tsc --noEmit`,
  `pytest`, `gradlew build`). Si falla, el agente intenta arreglarlo en el mismo turno
  (dentro del límite de 30 pasos) y reporta el estado final; no deja el proyecto roto en
  silencio.

### 8.6 Sesiones

- Al salir (`/exit`, Ctrl+C, Ctrl+D) guardar el historial en
  `%APPDATA%\NYXEN_CLI\sessions\<hash-del-cwd>.json` (hash simple del path, sin
  dependencias). Máximo 60 mensajes; al guardar, recortar cada resultado de herramienta a
  2000 caracteres. Nunca guardar la API key en ese archivo.
- Al arrancar en la misma carpeta, restaurar los últimos 20 mensajes y avisar en una
  línea: `↺ Sesión anterior restaurada (14 mensajes). Decí "empezá de cero" para
  limpiarla.` Si el usuario lo pide, borrar la sesión y continuar.
- Si el JSON está corrupto o no existe: arrancar limpio, sin error.

---

## 9. Seguridad — resumen

- Escrituras, borrados y ejecución **siempre** con confirmación explícita y detallada.
- Sin acceso fuera del `cwd` (los borrados incluidos).
- **Borrar sí está permitido**: si el usuario pide borrar algo, el agente usa `delete`,
  muestra el detalle y ejecuta tras el `[s/N]`. Lo que no puede es borrar el `cwd`,
  un padre suyo, una unidad (`C:\`) o algo fuera del proyecto.
- La API key nunca se imprime completa, nunca va al historial de la shell ni a logs.
- Config con permisos `0o600`, carpeta creada con `mkdirSync({ recursive: true })`.
- Nada de telemetría, analytics ni llamadas a otros hosts que no sean la base URL.

### 9.1 Comandos nunca ejecutables (`run_command` los rechaza sin preguntar)

Esta lista cubre **destrucción del sistema o del historial de git**, no borrados de
archivos del proyecto (para eso está `delete`). Chequeo: regex case-insensitive sobre el
string del comando, antes de ejecutarlo.

```
format            diskpart          bcdedit
shutdown          Restart-Computer  Stop-Computer
git push --force  git push -f       git reset --hard
git clean -fd     git clean -fdx    :(){ :|:& };:
```

Respuesta al modelo:
`✗ Comando bloqueado por seguridad. Usá la herramienta delete para borrar archivos o
pedile al usuario que lo haga manualmente.`

### 9.2 Backups y deshacer

- Antes de `write_file`, `edit_file` y `delete`, copiar lo afectado a
  `.nyxen/backup/<YYYYMMDD-HHMMSS>/<ruta-relativa>` (crear con `mkdirSync({ recursive:
  true })`; `.nyxen/` va en el `.gitignore` del proyecto).
- `write_file` sobre un archivo existente y todo `edit_file` → copia del original.
- `delete` → **mueve** a `.nyxen/backup/…` en vez de borrar definitivo si el total es
  menor a 50 MB; si es mayor, borrado real y la confirmación lo dice:
  `delete old-tests/ (12 archivos · 48 KB · recuperable)`.
- Al arrancar, si hay backups, una línea: `↺ Último backup: 2026-11-16 18:52 (3
  archivos). Decí "restaurá el backup" para volver atrás.` El agente lo cumple copiando
  esos archivos de vuelta con `write_file`.
- Si el backup falla (permisos, disco lleno): **no** ejecutar la operación y devolver
  `No pude crear el backup, cancelé la operación.`

---

## 10. Estructura de archivos a crear

```
NYXEN_CLI/
├── README.md            # este documento (ya existe)
├── package.json         # ← crear
├── bin/
│   └── nyxen.js         # ← crear
└── src/
    ├── config.js        # ← crear
    ├── api.js           # ← crear
    ├── tools.js         # ← crear    ├── agent.js           # ← crear
    ├── session.js         # ← crear
    └── ui.js              # ← crear
```

Responsabilidades:

| Archivo | Responsabilidad |
| --- | --- |
| `package.json` | `name: nyxen_cli`, `type: module`, `bin: { "nyxen": "bin/nyxen.js" }`, `engines.node >= 20`, `dependencies: {}` (vacío), `files: ["bin","src","README.md"]` |
| `bin/nyxen.js` | Shebang `#!/usr/bin/env node`; lee `--version` / `--help`; crea el REPL; intercepta `/connect` y `/exit`; pasa todo lo demás a `agent.runTurn()`; maneja Ctrl+C / Ctrl+D |
| `src/config.js` | `configDir()` / `configPath()` (`%APPDATA%\NYXEN_CLI\config.json`, o `~/.config/NYXEN_CLI/` fuera de Windows), `loadConfig()`, `saveConfig()`, `maskKey()`, merge con variables de entorno |
| `src/api.js` | `streamChat({ baseUrl, apiKey, model, messages, tools, signal })`: `fetch` + parseo SSE, acumulación de `tool_calls`, errores HTTP en una línea |
| `src/tools.js` | Las 8 herramientas, sus esquemas JSON, validación de rutas, borrado seguro, recorte de salida, lista negra de comandos y el registro de qué requiere confirmación |
| `src/agent.js` | El loop de §8.1, system prompt con árbol + `NYXEN.md`, presupuesto de contexto y resumen, límite de pasos, diff para `edit_file`, verificación posterior a los cambios |
| `src/session.js` | Guardar/restaurar historial por carpeta en `%APPDATA%\NYXEN_CLI\sessions\` (§8.6) y gestionar `.nyxen/backup/` (§9.2) |
| `src/ui.js` | Banner, prompt `› `, líneas `•`/`✓`/`✗`, entrada oculta para la key, prompt `[s/N]`, manejo de `NO_COLOR` |

Total estimado: 900–1.300 líneas de JavaScript, **cero dependencias** (`fetch`,
`node:readline`, `node:fs`, `node:path`, `node:child_process`, `node:os`,
`node:crypto` para el hash de la sesión).

---

## 11. Detalles técnicos obligatorios

- **Streaming SSE**: leer `res.body` con `getReader()`, cortar por `\n`, aceptar líneas
  `data: {...}` y `data: [DONE]`. Acumular `delta.content` y `delta.tool_calls`.
- **Request de chat**:

  ```js
  POST {baseUrl}/chat/completions
  Authorization: Bearer {apiKey}
  Content-Type: application/json

  {
    "model": "claude-sonnet-4-5",
    "messages": [...],
    "tools": [...],          // solo si el modelo los soporta
    "stream": true
  }
  ```

- **Descubrimiento**: `GET {baseUrl}/models?available=true` con el mismo Bearer. Es la
  fuente de la cadena activa. Si ese endpoint no existe (400/404/405), usar
  `GET {baseUrl}/models` y filtrar `available !== false` localmente. En ambos casos,
  filtrar `auto`, `fusion` y los que tengan `supported_parameters` sin `tools`. Los
  modelos sin `supported_parameters` (slots como `claude-sonnet-4-5`) se consideran
  candidatos y se validan al usarlos.
- **Errores**: `Error: FreeLLMAPI respondió <status>: <cuerpo recortado>` en una línea,
  con pista si es 401/403 (`revisá tu API key con /connect`). Nunca stack traces.
- **Sin config + mensaje del usuario** → `No hay conexión. Usá /connect primero.`
- **Timeout** de red: 180 s por request (AbortSignal), con reintentos progresivos en
  429/500/502/503/504 (2 s, 5 s, 10 s; máx. 3 intentos).
- **Failover de modelos**: tras agotar los reintentos de un modelo, probar el siguiente
  de la cadena activa si el error es de disponibilidad. No hacer failover si ya se emitió
  texto al usuario ni ante 401/403/400. Recordar el modelo que funcionó durante la sesión.
- **Entrada multilínea**: detectar pegado (un chunk de stdin con `\n`) y acumular hasta
  el final del mensaje; `Alt+Enter` (secuencia `\x1b\r` o Escape+Enter) agrega línea
  manual. Nunca interpretar cada línea pegada como un mensaje aparte.
- **Contexto**: leer `NYXEN.md` al arrancar (§8.5), respetar `.gitignore` simple y excluir
  `.nyxen` del árbol y de `search`.
- **Codificación**: leer/escribir UTF-8; conservar CRLF si el archivo original lo usa
  (detectar `\r\n`) y el BOM solo si ya estaba.
- **Rutas con espacios**: citar siempre en `run_command` y al mostrarlas en pantalla.
- **Persistencia**: `%APPDATA%\NYXEN_CLI\sessions\<hash>.json` y
  `<cwd>\.nyxen\backup\<fecha>\…`; ninguno de los dos entra al repo.
- El binario debe funcionar en CMD, PowerShell y Windows Terminal (UTF-8: no usar
  emojis fuera de `• ✓ ✗ …`; escribir con `process.stdout`).
- Idempotencia: correr `nyxen` dos veces en la misma carpeta no debe romper nada.

---

## 12. Referencia de la API de FreeLLMAPI

| Dato | Valor |
| --- | --- |
| Base URL hospedada | `https://api.freellmapi.ai/v1` |
| Base URL self-hosted | `http://localhost:3001/v1` |
| Chat | `POST /chat/completions` (formato OpenAI, `stream: true`) |
| Auth | `Authorization: Bearer sk_live_xxx` |
| Modelos | `GET /models?available=true` (el gateway marca disponibilidad y tool calling) |
| Listado completo | `GET /models` (incluye también los que no tienen provider key) |
| Tool calling | Filtrar por `supported_parameters.includes("tools")`; los slots sin metadata se validan en `/connect` (§5.5) |

Usar el formato **OpenAI Chat Completions** (no el endpoint Anthropic).
NYXEN descubre y usa automáticamente todos los modelos que el usuario tenga disponibles.

---

## 13. Criterios de aceptación (checklist)

Freebuff no termina hasta verificar todo esto en Windows:

- [ ] `npm install -g .` sin errores; `nyxen --version` devuelve `0.1.0`.
- [ ] `nyxen` abre la interfaz desde cualquier carpeta mostrando el `cwd`.
- [ ] Sin config, un mensaje responde `No hay conexión. Usá /connect primero.`
- [ ] `/connect` con key válida guarda `%APPDATA%\NYXEN_CLI\config.json` y confirma.
- [ ] `/connect` con key inválida muestra el error HTTP y **no** guarda.
- [ ] `/connect` permite pegar base URL y modelo custom (Enter acepta defaults).
- [ ] Un mensaje simple devuelve texto en streaming.
- [ ] **Crear proyecto**: en una carpeta vacía, `creame una landing page de una cafetería`
      produce archivos reales (`index.html`, `styles.css`), pidiendo confirmación, y el
      resultado se abre correctamente en el navegador.
- [ ] **Modificar proyecto**: en un proyecto con `package.json`, `agregá un script "dev"`
      edita el archivo sin destruir el resto del contenido.
- [ ] `read_file` sobre un archivo inexistente devuelve un error legible, no crashea.
- [ ] Rutas con `..\..\Windows` son rechazadas.
- [ ] **Borrar archivo**: `borrá notas.txt` ejecuta `delete`, pide confirmación con el
      detalle y borra el archivo real; reporta `Borré notas.txt`.
- [ ] **Borrar carpeta**: `borrá la carpeta old-tests` muestra `12 archivos · 48 KB`,
      confirma y la borra completa (incluido el contenido).
- [ ] `delete` sobre una carpeta **sin** `recursive: true` devuelve el error explicativo
      y no borra nada.
- [ ] `delete .` o `delete C:\` es rechazado con el mensaje de directorio de trabajo.
- [ ] **Pegado multilínea**: pegar 20 líneas de código las envía como un solo mensaje.
- [ ] **NYXEN.md**: con un `NYXEN.md` que define el stack del proyecto, el agente lo
      respeta al crear archivos sin preguntar.
- [ ] **Backup/deshacer**: tras un `edit_file` existe `.nyxen/backup/<fecha>/<archivo>`
      con el contenido original, y `restaurá el backup` devuelve el archivo a su estado
      anterior.
- [ ] **Build largo**: `run_command` con `npm install` no muere a los 120 s.
- [ ] **Salida larga**: un build con 600 líneas de error devuelve el final del stacktrace.
- [ ] **Reintento**: ante un 429 el CLI muestra `• reintentando (1/3)…` y no rompe el REPL.
- [ ] **Sesión**: cerrar y reabrir en la misma carpeta restaura la conversación y avisa
      `↺ Sesión anterior restaurada`.
- [ ] **Archivo binario**: `read_file` sobre un `.png` devuelve `archivo binario`.
- [ ] Negar una confirmación (`n`) cancela solo esa acción y la sesión sigue.
- [ ] `run_command` con un comando que no existe devuelve el stderr, no rompe el REPL.
- [ ] `/exit`, Ctrl+C y Ctrl+D cierran con código 0.
- [ ] Cualquier otro `/comando` responde `Comando desconocido. Disponibles: /connect, /exit`.
- [ ] `grep` del código: solo dos comandos de barra, cero dependencias en `package.json`.

---

## 14. Problemas típicos en Windows

| Síntoma | Solución |
| --- | --- |
| `nyxen: command not found` | Reabrir la terminal; verificar `npm bin -g` / `%APPDATA%\npm` en el `PATH` |
| `nyxen.ps1 cannot be loaded` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Error EPERM al instalar global | Abrir PowerShell como administrador, o `npm config set prefix %APPDATA%\npm` |
| `fetch is not defined` | Node < 18; actualizar a Node 20+ |
| Caracteres raros (`Ã¡`) | Usar Windows Terminal y `chcp 65001` |
| 401 en todas las llamadas | La key es de otro servicio o expiró → `/connect` otra vez |
| El modelo no llama herramientas | `/connect` y Enter en `Modelo (Enter = automático)`; NYXEN elige uno que valide tool calling |

---

## 15. Prompt listo para pegar en Opencode/Freebuff (en tu PC)

```
Leé el README.md de esta carpeta y construí NYXEN_CLI exactamente como está
especificado: CLI de Node.js 20 (ESM, cero dependencias) para Windows, con
binario global `nyxen` instalable con `npm install -g .`, que usa la API de
FreeLLMAPI (endpoint compatible OpenAI en https://api.freellmapi.ai/v1).

Debe ser un agente: loop con tool calling, herramientas list_dir, read_file,
search, write_file, edit_file, make_dir, delete y run_command; confirmación [s/N]
antes de escribir, borrar o ejecutar (con el detalle de qué se borra); bloqueo de
rutas fuera del cwd; streaming de la respuesta; backups automáticos en .nyxen/backup
con deshacer; lectura de NYXEN.md como contexto del proyecto; sesiones guardadas por
carpeta; entrada multilínea; timeouts largos para builds; reintentos ante 429/5xx; y
verificación del proyecto al terminar de editar. Interfaz minimalista, y SOLO dos
comandos: /connect (pide API key, base URL y modelo, valida contra la API y guarda en
%APPDATA%\NYXEN_CLI\config.json) y /exit.

No agregues otros comandos, dependencias, ni funciones fuera de lo especificado.
Al terminar, ejecutá y verificá uno por uno los criterios de aceptación de la
sección 13 del README y reportá el resultado de cada punto.
```

---

## 16. Fuera de alcance (posibles v2, no implementar ahora)

Subagentes, MCP, edición por parches tipo `apply_patch`, **búsqueda web** (requiere un
proveedor de búsqueda), búsqueda semántica de código (embeddings), LSP/diagnósticos,
renderizado Markdown en la terminal, modo `--json`, selector interactivo de modelo,
imágenes, voz, varios agentes en paralelo.

> La falta de búsqueda web es la limitación práctica más grande para mods: el agente
> depende de lo que el modelo "sepa" de la versión del loader. Si eso importa, pegá la
> doc o el error exacto en el mensaje, o anotá las versiones en `NYXEN.md`.

---

## Aviso

Este proyecto fue creado con **inteligencia artificial** usando **[OpenCode](https://opencode.ai)**.
