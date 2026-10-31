# План доработки встроенного сервера (OpenAI-compatible local server)

Документ для исполнителя (в т.ч. локальной LLM). Задачи идут по порядку, каждая
самодостаточна: файлы → что сделать → критерий готовности. Не перескакивать через
этапы: каждый этап должен оставлять `yarn typecheck`, `yarn lint` и тесты зелёными.

---

## 1. Что уже есть (состояние на текущий момент)

Реализовано и работает на Android:

| Слой | Файл |
| --- | --- |
| Нативный HTTP/1.1 listener (Kotlin, TurboModule) | `android/app/src/main/java/com/pocketpalai/LocalServerModule.kt` |
| Регистрация пакета | `android/app/src/main/java/com/pocketpalai/LocalServerPackage.kt`, `MainApplication.kt` |
| TurboModule spec | `src/specs/NativeLocalServer.ts` |
| Store (модель, порт, LAN, очередь, SSE) | `src/store/LocalServerStore.ts` |
| Чистые OpenAI-хелперы (парсинг/сборка JSON/SSE) | `src/services/localServer/openaiApi.ts` |
| Тесты хелперов | `src/services/localServer/__tests__/openaiApi.test.ts` |
| Экран | `src/screens/ServerScreen/ServerScreen.tsx`, `styles.ts` |
| Пункт меню | `src/components/SidebarContent/SidebarContent.tsx` (`drawer-item-server`) |
| Роут | `src/utils/navigationConstants.ts` (`ROUTES.SERVER`), `App.tsx` |
| Строки | `src/locales/en.json` → `server`, `screenTitles.server` |

Текущее поведение:

- `startServer()`: грузит выбранную скачанную модель через `modelStore.initContext`,
  затем `NativeLocalServer.start(port, allowLan)` (127.0.0.1 либо 0.0.0.0).
- Эндпоинты: `GET /v1/models`, `GET /health`, `POST /v1/chat/completions`,
  `POST /v1/completions` (+ алиасы без `/v1`), `OPTIONS` → 204. SSE для `stream: true`.
- Очередь запросов (`this.queue`) сериализует запросы сервера; при обрыве клиента
  вызывается `context.stopCompletion()`.
- Пока сервер запущен: `disableAutoRelease('local-server')` + keep-awake.
- Ограничение платформы: только Android (`supported` getter, на iOS экран пишет
  «доступно только на Android»).

Чего нет (предмет этого плана):

1. Нет логов запросов/ответов в UI.
2. Нет foreground-уведомления и действий «Остановить» / «Остановить и выгрузить модель».
3. Нет выбора Pal (системный контекст, параметры, шаблоны).
4. Нет кнопки «Выгрузить модель» и корректного сценария unload.
5. Store разросся: HTTP-роутинг, обработка completion и MobX-состояние в одном классе;
   нет тестов на роутинг/стриминг.

---

## 2. Целевая архитектура

```
src/services/localServer/
  openaiApi.ts          // как сейчас: только wire-формат (парсинг запроса, JSON/SSE)
  prompt.ts             // NEW: склейка системного промпта Pal + клиентского system
  log.ts                // NEW: типы лога, ring buffer, безопасное усечение
  requestHandler.ts     // NEW: чистый роутер HTTP → completion, без MobX и без сокетов
  __tests__/
    openaiApi.test.ts
    prompt.test.ts
    log.test.ts
    requestHandler.test.ts

src/store/LocalServerStore.ts   // только состояние + оркестрация + мост к NativeLocalServer
src/screens/ServerScreen/       // экран + ServerLogList (отдельный компонент)
src/specs/NativeLocalServer.ts  // + updateNotification, событие notificationAction
android/.../LocalServerModule.kt        // + мост к сервису уведомления
android/.../LocalServerService.kt       // NEW: foreground service
android/.../LocalServerNotifications.kt // NEW: канал + билдер уведомления
```

Правила (важно для слабой LLM):

- Не добавлять новых MobX-сторов. Всё состояние сервера — в `LocalServerStore`.
- Не добавлять HTTP-библиотеки (express/fastify/http-сервер на JS). Транспорт уже есть.
- Не менять публичные API `ModelStore` / `PalStore`, кроме явно описанного.
- Локали: только `src/locales/en.json`. Остальные языки — Weblate, не трогать.
- Не менять поведение чата и существующие экраны, если это не описано в задаче.
- Каждый этап заканчивать командами:
  `yarn typecheck`, `yarn lint`, `yarn jest <затронутые тесты> --coverage=false`.

---

## 3. Этап A. Модернизация: вынести обработчик запросов + тесты

Цель: поведение не меняется, но HTTP-логика перестаёт зависеть от MobX и сокетов,
появляется возможность тестировать без телефона и без llama.rn.

### A1. Типы

Новый файл `src/services/localServer/types.ts`:

```ts
import type {
  CompletionResult,
  CompletionStreamData,
} from '../../utils/completionTypes';

export type ServerLogKind = 'request' | 'response' | 'error' | 'lifecycle';

export interface ServerLogEntry {
  id: string;
  at: number;                 // Date.now()
  kind: ServerLogKind;
  requestId?: string;
  method?: string;            // 'POST'
  path?: string;              // '/v1/chat/completions'
  status?: number;            // 200 / 400 / 500 / 503
  stream?: boolean;
  remoteAddress?: string;
  model?: string;
  pal?: string;
  messages?: number;          // сколько messages пришло
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  bytes?: number;
  summary?: string;           // одна строка для списка
  detail?: string;            // pretty JSON / текст ошибки, усечённый
}

export interface ServerEngine {
  completion(
    params: Record<string, unknown>,
    onToken?: (data: CompletionStreamData) => void,
  ): Promise<CompletionResult>;
  stopCompletion(): Promise<void>;
}

export interface ServerRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  remoteAddress?: string;
}

export interface ServerResponseWriter {
  json(status: number, body: string): void;
  sseStart(): void;
  sseChunk(payload: string): void;
  sseEnd(): void;
  isClosed(): boolean;
}

export interface ServerHandlerDeps {
  /** Гарантирует загруженную модель и возвращает движок. Может бросить Error. */
  getEngine(): Promise<ServerEngine>;
  getModelName(): string;
  /** Готовый системный промпт выбранного Pal (или ''). Снимок на момент запроса. */
  getSystemPrompt(): string;
  /** Дефолтные параметры генерации (Pal + глобальные), без messages/tools. */
  getDefaultParams(): Record<string, unknown>;
  getPalName(): string | undefined;
  log(entry: ServerLogEntry): void;
}
```

### A2. Ring buffer лога

`src/services/localServer/log.ts`:

```ts
export const SERVER_LOG_LIMIT = 200;

export function appendServerLog(
  logs: ServerLogEntry[],
  entry: ServerLogEntry,
): ServerLogEntry[] {
  return [entry, ...logs].slice(0, SERVER_LOG_LIMIT);
}

export function truncate(value: string, max = 4000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function prettyJson(value: unknown): string | undefined {
  try {
    return truncate(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}
```

Тест `__tests__/log.test.ts`: добавление сохраняет порядок (новые первыми),
лимит соблюдается, `truncate` не рвёт короткие строки.

### A3. Чистый обработчик

`src/services/localServer/requestHandler.ts`:

```ts
export class ServerRequestHandler {
  constructor(
    private deps: ServerHandlerDeps,
    private now: () => number = Date.now,
  ) {}

  async handle(req: ServerRequest, res: ServerResponseWriter): Promise<void>;
}
```

Логика — перенос из `LocalServerStore.handleRequest` / `handleChatCompletion` /
`handleCompletion`, но без `NativeLocalServer`, без `runInAction` и без очереди:

- `normalisePath` — сюда же (экспортировать для тестов).
- `OPTIONS` → `res.json(204, '')`.
- `GET /v1/models` → `buildModelsResponse([deps.getModelName()], nowSec)`.
- `GET /` и `/health` → JSON `{status:'ok', model, pal?, endpoints:[...]}`.
- `POST /v1/chat/completions`:
  - `parseChatCompletionRequest(body)`;
  - `engine = await deps.getEngine()`;
  - системный промпт: `mergeSystemPrompt(request.messages, deps.getSystemPrompt())`;
  - параметры: `{...deps.getDefaultParams(), ...requestOverrides}` (запрос главнее);
  - stream/non-stream как сейчас, включая дельты reasoning/content, tool_calls,
    финальный chunk с `finish_reason`, `[DONE]`;
  - после ответа — запись в лог `kind:'response'` с usage/duration/bytes.
- `POST /v1/completions` — аналогично, `text_completion`.
- Неизвестный путь → 404 JSON `buildErrorResponse`.
- `BadRequestError` → 400; прочие ошибки → 500 (для SSE — SSE-событие ошибки + `[DONE]`).

Логи внутри handler:

- при входе: `kind:'request'` (`method`, `path`, `stream`, `messages`, `remoteAddress`,
  `model`, `pal`, `summary`);
- при успехе: `response` (`status`, `durationMs`, `promptTokens`, `completionTokens`,
  `bytes`);
- при ошибке: `error` (`status`, `summary`, `detail: truncate(message)`).

Не логировать полные тела по умолчанию (приватность/память). `detail` запроса —
краткая сводка: `{"messages":3,"max_tokens":512,"temperature":0.7}`.

### A4. Store становится тонким

В `LocalServerStore`:

- Удалить `handleChatCompletion`, `handleCompletion`, `headers`/`streamHeaders`
  (перенести в writer/handler).
- Создать `private handler = new ServerRequestHandler({...})` с deps:
  - `getEngine: () => this.ensureSelectedModelLoaded()`;
  - `getModelName: () => this.servedModelName`;
  - `getSystemPrompt: () => resolveSystemPrompt({pal: this.selectedPal, model: this.selectedModel})`;
  - `getDefaultParams: () => this.defaultParams()`;
  - `getPalName: () => this.selectedPal?.name`;
  - `log: entry => this.pushLog(entry)`.
- `Responder` (маленький адаптер внутри store) реализует `ServerResponseWriter`
  через `NativeLocalServer!.respond/streamStart/streamChunk/streamEnd`, добавляет
  CORS/Content-Type заголовки.
- `handleRequest` в store: ранний выход, если `!this.running` или запрос уже закрыт;
  затем `await this.handler.handle(event, responder)`.
- Публичное состояние: `logs: ServerLogEntry[] = []`, `clearLogs()`, `pushLog()`
  (через `runInAction` + `appendServerLog`).
- `busy = activeRequestId !== null` — оставить.

Критерий A: `yarn jest src/services/localServer` включает новые тесты,
`yarn typecheck` и `yarn lint` зелёные, на устройстве поведение сервера идентично
(`/v1/models`, chat non-stream, chat stream).

### A5. Тесты обработчика

`requestHandler.test.ts` — фейковый движок:

```ts
const engine: ServerEngine = {
  completion: jest.fn(async (params, onToken) => {
    onToken?.({token: 'Hel', content: 'Hel'});
    onToken?.({token: 'lo', content: 'Hello'});
    return {
      text: 'Hello',
      content: 'Hello',
      tokens_evaluated: 3,
      tokens_predicted: 2,
    } as CompletionResult;
  }),
  stopCompletion: jest.fn(),
};
```

Проверить:

1. `GET /v1/models` → 200, `data[0].id === 'test-model'`.
2. `/health` содержит `pal`, если Pal выбран.
3. chat non-stream → 200, `choices[0].message.content === 'Hello'`, usage.
4. chat stream → последовательность: start, чанки с `delta.content`, финальный
   `finish_reason`, `[DONE]`, end. Собрать тексты из `sseChunk` и склеить.
5. `messages: []` → 400, лог `kind:'error'`.
6. `engine.completion` бросает после `sseStart` → SSE-ошибка + `[DONE]`.
7. Системный промпт Pal попадает первым сообщением (см. этап B).
8. Дефолтные параметры Pal применяются, но `temperature` из запроса их перекрывает.

---

## 4. Этап B. Pal как системный контекст

### B1. Чистая склейка промпта

`src/services/localServer/prompt.ts`:

```ts
import type {OpenAIChatMessage} from './openaiApi';

export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part && typeof part === 'object' && part.type === 'text')
      .map(part => String((part as {text?: unknown}).text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Ровно одно ведущее system-сообщение: промпт Pal + все клиентские system.
 * Если промпта нет — массив возвращается без изменений.
 */
export function mergeSystemPrompt(
  messages: OpenAIChatMessage[],
  systemPrompt: string,
): OpenAIChatMessage[];
```

Правила:

- клиентские `role === 'system'` собираются, из середины массива удаляются;
- части склеиваются через `\n\n`, пустые отбрасываются;
- если итог пуст — вернуть исходный массив;
- порядок остальных сообщений сохраняется.

Тест `prompt.test.ts`: 5 кейсов (нет промпта; только Pal; Pal + system;
две system; content-массив частей).

### B2. Store: выбор Pal

В `LocalServerStore`:

```ts
palId: string | undefined = undefined;               // + в makePersistable properties

get availablePals(): Pal[] {
  return palStore.pals.filter(p => {
    const caps = p.capabilities;
    return !caps?.video && !caps?.realtime && !caps?.audio;
  });
}

get selectedPal(): Pal | undefined {
  return this.palId ? palStore.getPalById(this.palId) : undefined;
}

selectPal(palId: string | undefined): void { this.palId = palId; }
```

`defaultParams()`:

```ts
private defaultParams(): Record<string, unknown> {
  const settings = ... // см. ниже
  const allowed = [
    'temperature','top_p','top_k','min_p','typical_p','tfs_z',
    'repeat_penalty','repeat_last_n','presence_penalty','frequency_penalty',
    'penalize_nl','mirostat','mirostat_tau','mirostat_eta',
    'n_predict','seed','ignore_eos',
  ];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}
```

Источник настроек — существующий резолвер, не дублировать логику:

```ts
const settings = await chatSessionStore.resolveCompletionSettings(
  undefined,
  this.palId,
);
```

Важно:

- `resolveCompletionSettings` подмешивает `tools` из `pact.talents` — **удалить**
  `tools` из результата: сервер не исполняет таланты, инструменты приходят только
  от клиента (`request.tools`).
- `resolveCompletionSettings` асинхронный → `defaultParams` сделать async и
  загружать один раз на запрос (или кэшировать по `palId` + версии настроек;
  проще — на запрос).
- Не отправлять в llama.rn `messages`/`prompt` из настроек.

### B3. Экран

В `ServerScreen` добавить карточку/секцию «Pal» над выбором модели:

- `Dropdown` из `src/components/ui` (`value`, `options`, `onChange`, `disabled`);
- опции: `{value: '__none__', label: l10n.server.palNone}` + `availablePals`
  (`value: pal.id`, `label: pal.name`);
- под селектором: `l10n.server.palHint` и превью системного промпта (2 строки,
  `numberOfLines={2}`);
- при выборе Pal обновлять уведомление (если сервер запущен) — см. этап D;
- селект заблокирован, пока `running || starting || loadingModel`;
- testID: `server-pal-select`.

Строки в `en.json` (`server`):

```json
"palTitle": "Pal",
"palHint": "The pal's system prompt and default generation settings are applied to every request.",
"palNone": "None (model default)",
"palPromptPreview": "System prompt: {{preview}}"
```

Логика на сервере: `getSystemPrompt()` возвращает `resolveSystemPrompt({pal, model})`;
`/health` дополнительно отдаёт `pal: selectedPal?.name`.

Критерий B: запрос с выбранным Pal содержит его system prompt (проверить тестом и
на устройстве: например, Pal с промптом «отвечай только по-русски» → ответ на
русском); без Pal поведение прежнее.

---

## 5. Этап C. Логи в UI

### C1. Компонент

`src/screens/ServerScreen/ServerLogList.tsx`:

- props: `logs: ServerLogEntry[]`, `onClear: () => void`;
- рендер до 50 последних, новые сверху, без вложенного `FlatList`
  (экран уже в `ScrollView` — использовать `.slice(0, 50).map`);
- строка: время `HH:mm:ss`, бейдж `REQ/RESP/ERR/SYS`, `method path`, статус,
  `durationMs`, токены;
- тап по строке раскрывает `detail` (monospace `Text`, `selectable`);
- кнопка «Очистить» (disabled при пустом списке);
- `l10n.server.logs.*` строки;
- testID: `server-log-list`, `server-log-clear`.

### C2. Store

- `logs: ServerLogEntry[] = []`;
- `pushLog(entry)` — `runInAction`, `appendServerLog`, генерация `id`:
  `${Date.now().toString(36)}-${counter++}`;
- `clearLogs()`;
- записи `lifecycle`: старт сервера, стоп, загрузка/выгрузка модели, смена Pal.

### C3. Экран

Добавить карточку «Логи» под эндпоинтами. Если пусто — `l10n.server.logs.empty`.
Логи только в памяти (не персистить): приватность + размер.

Критерий C: каждый запрос даёт 2 записи (request/response), ошибки — `error`;
«Очистить» работает; после перезапуска приложения список пуст.

---

## 6. Этап D. Постоянное уведомление + действия

### D1. Manifest (`android/app/src/main/AndroidManifest.xml`)

Добавить permissions:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
```

Сервис внутри `<application>`:

```xml
<service
    android:name="com.pocketpal.LocalServerService"
    android:exported="false"
    android:foregroundServiceType="specialUse">
    <property
        android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
        android:value="Local OpenAI-compatible inference server" />
</service>
```

`POST_NOTIFICATIONS` уже есть. На API 33 запросить разрешение перед стартом
(см. D5). `specialUse` — для сборок вне Play; если Play не примет, заменить на
`dataSync` (учесть лимит 6 ч на Android 15).

### D2. Уведомление

`android/.../LocalServerNotifications.kt`:

- канал `local_server`, `IMPORTANCE_LOW`, имя канала приходит из JS
  (`channelName`) или фолбэк `"PocketPal server"`;
- `Notification.Builder(context, CHANNEL_ID)`:
  - `setSmallIcon(android.R.drawable.stat_sys_upload)` (или ic_launcher);
  - title/text/subText из payload: `title`, `model`, `address`, `requests`;
  - `setOngoing(true)`, `setOnlyAlertOnce(true)`, `setSilent(true)`,
    `setCategory(Notification.CATEGORY_SERVICE)`;
  - `contentIntent` — `packageManager.getLaunchIntentForPackage` (FLAG_IMMUTABLE);
  - две action-кнопки:
    - `ACTION_STOP_SERVER` (`stopLabel`), requestCode 1;
    - `ACTION_STOP_AND_UNLOAD` (`unloadLabel`), requestCode 2;
  - PendingIntent: `PendingIntent.getService(context, code, intent, FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT)`.

Payload — JSON-строка из JS:

```json
{
  "title": "PocketPal server",
  "model": "Qwen3 4B",
  "address": "http://192.168.1.5:8080",
  "requests": 12,
  "channelName": "Local server",
  "stopLabel": "Stop",
  "unloadLabel": "Stop and unload model"
}
```

### D3. Foreground service

`android/.../LocalServerService.kt`:

```kotlin
class LocalServerService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_SHOW -> {
        payloadJson = intent.getStringExtra(EXTRA_PAYLOAD) ?: payloadJson
        val notification = LocalServerNotifications(this).build(payloadJson)
        if (Build.VERSION.SDK_INT >= 34) {
          startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
          startForeground(ID, notification)
        }
      }
      ACTION_STOP_SERVER -> {
        LocalServerModule.dispatchNotificationAction("stop")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
      ACTION_STOP_AND_UNLOAD -> {
        LocalServerModule.dispatchNotificationAction("stop-and-unload")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }
}
```

Companion:

```kotlin
fun show(context: Context, payloadJson: String) {
  val intent = Intent(context, LocalServerService::class.java)
    .setAction(ACTION_SHOW)
    .putExtra(EXTRA_PAYLOAD, payloadJson)
  ContextCompat.startForegroundService(context, intent)
}

fun update(context: Context, payloadJson: String) {
  // если сервис уже работает — снова ACTION_SHOW (startForegroundService безопасен)
}

fun hide(context: Context) {
  context.stopService(Intent(context, LocalServerService::class.java))
}
```

Требование: `startForeground` вызвать в `onStartCommand` в течение 5 секунд —
поэтому `ACTION_SHOW` сразу билдит уведомление и не ждёт JS.

### D4. Мост service → JS

В `LocalServerModule`:

```kotlin
companion object {
  private var instanceRef: WeakReference<LocalServerModule>? = null

  fun dispatchNotificationAction(action: String): Boolean {
    val module = instanceRef?.get() ?: return false
    module.emitNotificationAction(action)
    return true
  }
}

init { instanceRef = WeakReference(this) }

fun emitNotificationAction(action: String) {
  emit("LocalServer:notificationAction", Arguments.createMap().apply {
    putString("action", action)
  })
}
```

`invalidate()` — `instanceRef = null`.

Если JS-модуля нет (процесс без RN), сервис просто закрывается: сокет живёт в
модуле, значит сервер и так уже недоступен.

### D5. TurboModule spec и JS

`src/specs/NativeLocalServer.ts`:

```ts
updateNotification(payloadJson: string): void;
```

События (типизировать в store):

```ts
'LocalServer:notificationAction': [{action: 'stop' | 'stop-and-unload'}];
```

`LocalServerStore`:

- `startServer()` после успешного старта:
  `NativeLocalServer!.updateNotification(JSON.stringify(this.notificationPayload()))`;
- `this.notificationPayload()`: title/model/address/requests/labels/channelName;
  адрес: `http://127.0.0.1:port`, при LAN — LAN-IP (можно через `DeviceInfo.getIpAddress`,
  как на экране; в store кэшировать последний известный IP);
- `stopServer()` → `NativeLocalServer!.stop()` уже останавливает сервис в модуле;
- после каждого обработанного запроса — обновление счётчика не чаще 1 раза в секунду
  (`private lastNotificationAt = 0`);
- слушатель `LocalServer:notificationAction`:
  `stop` → `void this.stopServer()`, `stop-and-unload` → `void this.stopServerAndUnload()`.

`ensureNotificationPermission()` (`src/utils/androidPermission.ts`) сейчас
пропускает API 33 (`Platform.Version < 34`). Исправить на `< 33` и вызывать его в
`startServer` (или в `handleStart` на экране) **до** старта сервиса.

### D6. Связка native start/stop

- `LocalServerModule.start(...)`: после `bind` и запуска accept-потока вызвать
  `LocalServerService.show(reactApplicationContext, initialPayload)`; payload можно
  принять строкой в `start(...)` третьим аргументом, либо сразу вызвать
  `updateNotification(...)` из JS (проще, без изменения сигнатуры `start`).
- `LocalServerModule.stop()`: `LocalServerService.hide(...)`.
- `invalidate()`: `stopForeground`/`hide`.

Критерий D: запуск сервера показывает постоянное уведомление; свайп приложения из
recents не убивает сервер (проверить запросом); кнопки уведомления останавливают
сервер; «Stop and unload» дополнительно выгружает модель (см. этап E).

---

## 7. Этап E. Выгрузка модели и кнопки

### E1. Store

```ts
async stopServerAndUnload(): Promise<void> {
  const modelId = this.selectedModel?.id;
  await this.stopServer();
  // Дать текущей генерации завершиться/остановиться.
  await this.queue.catch(() => {});
  if (
    modelId &&
    modelStore.activeModelId === modelId &&
    !modelStore.inferencing
  ) {
    await modelStore.manualReleaseContext();
    this.pushLog({...lifecycle, summary: 'Model unloaded'});
  }
}

async unloadModel(): Promise<void> {
  if (this.running) return; // сначала остановить сервер
  if (this.selectedModel && modelStore.activeModelId === this.selectedModel.id) {
    await modelStore.manualReleaseContext();
  }
}
```

Дополнительно в `handleRequest`: если `!this.running` на момент выполнения —
ответить 503 и не запускать генерацию; в `stopServer()` при `activeRequestId`
вызвать `modelStore.context?.stopCompletion()`.

### E2. UI

- Рядом с `Start/Stop`:
  - при `running`: кнопка «Остановить» (contained) и «Остановить и выгрузить модель»
    (outlined);
  - при `!running && modelLoaded`: «Выгрузить модель» (text);
- статус `modelLoaded` уже есть;
- testID: `server-stop-unload-button`, `server-unload-button`.

Строки `en.json`:

```json
"stopAndUnload": "Stop and unload model",
"unloadModel": "Unload model"
```

Критерий E: после «Stop and unload» `modelStore.context === undefined`,
`activeModelId === undefined`, память освобождена; после простого «Stop» модель
остаётся загруженной.

---

## 8. Этап F. Проверка и приёмка

### F1. Автоматические проверки

```powershell
yarn typecheck
yarn lint
yarn jest src/services/localServer src/screens/ServerScreen --coverage=false
yarn test            # перед PR/финалом, полный прогон
```

Сборка:

```powershell
cd android
.\gradlew.bat :app:assembleProdDebug --console=plain
```

### F2. Ручной чек-лист на устройстве

1. Скачать модель (Models → Download), открыть Server, выбрать модель и Pal.
2. `Start server` → появляется уведомление, статус «Running», в логах 1 lifecycle.
3. С хоста:
   ```powershell
   adb forward tcp:8080 tcp:8080
   Invoke-RestMethod http://127.0.0.1:8080/v1/models
   $b = @{ model="x"; messages=@(@{role="user";content="Скажи привет"}); max_tokens=64 } | ConvertTo-Json -Depth 5
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/v1/chat/completions -ContentType 'application/json' -Body $b
   ```
4. Stream:
   ```powershell
   curl.exe -N http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d '{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true}'
   ```
5. LAN: включить тумблер, перезапустить сервер, с ПК в той же Wi‑Fi
   `Invoke-RestMethod http://<IP-телефона>:8080/v1/models`.
6. Логи: каждая пара request/response видна, статус/токены/время совпадают,
   ошибка 400 при пустом `messages` попадает в лог.
7. Уведомление: свернуть приложение, запрос с ПК всё ещё работает; «Stop»
   останавливает; «Stop and unload» выгружает модель.
8. Проверка Pal: Pal с промптом «отвечай только на русском» меняет ответ;
   «None» возвращает поведение по умолчанию.

Выполнено 2026-10-31 на 2211133G (Android 16, API 36); результаты и
оговорки — в `docs/local-server-execution-plan.md`, раздел «сессия 2».
Пункт 5 (LAN с ПК) не проверялся: на устройстве не было Wi-Fi.

### F3. Definition of Done

- [x] Все этапы A–E реализованы, публичное поведение чата не изменилось.
- [x] `yarn typecheck`, `yarn lint` — без ошибок; полный `yarn test` нужно
      прогнать на CI/macOS (на Windows падают несвязанные тесты).
- [x] APK собирается, проверен на Android-устройстве по F2.
- [x] В PR/отчёте указано, как проверялось (устройство 2211133G, Android 16).
- [x] Новые строки только в `src/locales/en.json`.

---

## 9. План модернизации кода (сводно)

| # | Что | Зачем | Риск |
| --- | --- | --- | --- |
| M1 | `requestHandler.ts` (этап A) | Тестируемость, store < 350 строк | Средний: механический перенос, покрыть тестами |
| M2 | `prompt.ts` + `log.ts` | Чистые функции, нет MobX | Низкий |
| M3 | Ошибки сервера: коды вместо английских строк в store | Локализация, единый UX | Низкий |
| M4 | `ServerLogList` отдельным компонентом | Экран не разрастается | Низкий |
| M5 | `ServerResponseWriter` адаптер | Один слой знает про native | Низкий |
| M6 | Кэш `defaultParams` по `palId` | Не дёргать async-резолвер на каждый запрос | Низкий |
| M7 | (опционально) API lease в `ModelStore` | Сериализация сервера и чата на одном контексте | Высокий, отдельная задача |

M3 (коды ошибок): в store хранить `errorCode: 'no-model' | 'not-downloaded' |
'port-invalid' | 'start-failed' | 'unsupported'`, на экране маппить в
`l10n.server.errors.*`. Не делать в первом проходе, если не хватает времени.

M7: сейчас очередь сериализует только серверные запросы. Чат может стартовать
генерацию параллельно на том же `LlamaContext`. На v1 это известное ограничение,
задокументировать. Правильное решение — публичный метод в `ModelStore`:

```ts
async withGenerationLease<T>(
  run: (engine: CompletionEngine) => Promise<T>,
): Promise<T | null>;
```

внутри — `this.generationSlot.acquire(async () => {}, () => this.engine ?? null)`.
Сервер оборачивает completion в этот вызов. Делать только отдельной задачей с
тестами `ModelStore.generationLease.test.ts`.

---

## 10. Риски и ограничения

1. **Android-only.** iOS-реализация (NWListener) вне этого плана; экран уже пишет
   «доступно только на Android».
2. **Foreground service type.** `specialUse` требует описания для Play; для
   локальных сборок ок. Альтернатива `dataSync` имеет лимит 6 ч/24 ч на Android 15.
3. **Старт FGS из фона запрещён (Android 12+).** Сервер стартует только из
   видимой активности — это наш сценарий.
4. **Общий llama-контекст.** Сервер и чат могут конкурировать (см. M7).
5. **Память логов.** Ring buffer 200 записей, тела не логируются целиком.
6. **Pal с талантами.** `pact.talents` не исполняются сервером; tools — только из
   запроса клиента. В системный промпт попадает сам текст Pal, без фрагментов
   талантов.
7. **Мультимодальные Pal.** `capabilities.video/realtime/audio` исключены из
   выбора: сервер не умеет камеру/микрофон.
8. **Порт занят.** Уже возвращается `EADDRINUSE`; UI показывает ошибку.

---

## 11. Памятка исполнителю (для локальной LLM)

- Работать строго по этапам: A → B → C → D → E → F. После каждого этапа — проверки.
- Сначала прочитать целиком: `src/store/LocalServerStore.ts`,
  `src/services/localServer/openaiApi.ts`, `src/specs/NativeLocalServer.ts`,
  `android/.../LocalServerModule.kt`, `src/screens/ServerScreen/ServerScreen.tsx`.
- Не «улучшать» попутно чужие файлы. Любая правка вне списка задач — отдельный PR.
- Если не хватает контекста — открывать только указанные файлы, не весь репозиторий.
- Строки UI — только `en.json`; в коде — `l10n.server.*`, без литералов.
- Комментарии — по делу, на английском, в стиле окружающего кода.
- Не добавлять `console.log` в финальный код; для отладки — временно.
- После каждой задачи: `yarn typecheck`; перед сдачей — `yarn lint` и тесты.
- При сомнении между «сделать красиво» и «повторить существующий паттерн» —
  повторять существующий паттерн (см. `AGENTS.md`).
