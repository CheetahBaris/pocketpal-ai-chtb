# Local server — план исполнения и журнал работ

Этот файл — рабочая инструкция для продолжения доработки встроенного
OpenAI-совместимого сервера. Он дополняет `docs/local-server-plan.md`: там
описана целевая архитектура и все этапы, здесь — **что уже сделано**, **что
осталось**, **точный порядок действий** и **журнал фактически выполненных шагов**.

Правило: после каждого шага обновлять раздел «Журнал работ» в конце файла.
Если лимит контекста закончился — продолжать с первого незакрытого пункта.

---

## 1. Проверенное состояние (на 2026-10-31)

Команды перед началом:

```powershell
yarn typecheck                 # OK
yarn jest src/services/localServer src/utils/__tests__/androidPermission.test.ts --coverage=false
# 5 suites / 50 tests passed
```

| Этап | Статус | Что именно |
| --- | --- | --- |
| A. Чистый обработчик | ✅ готово | `types.ts`, `log.ts`, `prompt.ts`, `requestHandler.ts`, тесты; `LocalServerStore` использует `ServerRequestHandler` |
| B1. Склейка промпта | ✅ готово | `prompt.ts` + `prompt.test.ts` |
| B2. Pal в store | ✅ готово | `palId`, `availablePals`, `selectedPal`, `defaultParams()` через `resolveCompletionSettings`, `tools` отфильтрованы |
| B3. Pal в UI | ✅ готово | селектор `server-pal-select`, превью системного промпта |
| C0. Детали логов | ✅ готово | тело запроса (pretty JSON) и превью ответа в `detail` |
| C1. Компонент логов | ✅ готово | `ServerLogList.tsx` + кнопка «Очистить» (`server-log-clear`) |
| C2. Логи в store | ✅ готово | `logs`, `pushLog`, `clearLogs`, lifecycle-записи |
| C3. Логи в UI | ✅ готово | карточка «Request log» под эндпоинтами |
| D. Уведомление | ✅ готово | `LocalServerService.kt`, `LocalServerNotifications.kt`, manifest, `updateNotification`, события действий |
| E. Кнопки Stop / Stop+Unload | ✅ готово | кнопки на экране, методы store уже были |
| F. Приёмка | ✅ готово | typecheck/lint/целевые тесты/Kotlin-компиляция зелёные; `assembleProdDebug` собран; ручной чек-лист F2 пройден на устройстве 2211133G (Android 16) |
| G. Живой статус | ✅ готово | состояние генерации и tok/s на экране и в уведомлении, счётчики трафика из сокетов, статичная иконка, исправлена ошибка `onClientClosed` и ложное «client closed» |
| H. Маскот и ресурсы | ✅ готово | иконка уведомления — маскот (силуэт в статус-баре и анимированный крупный значок во время генерации), мониторинг CPU/RAM/батареи на экране и в уведомлении, полные тела запросов/ответов в логах |
| I. Pal ByeDPI | ✅ готово | встроенный Pal с промптом, настройками генерации, pact и моделью по умолчанию; сеется один раз, существующий не перезаписывает |

Итого осталось: **только полный `yarn test` на CI/macOS** (на этой Windows-машине
падают несвязанные тесты, см. журнал) и оформление PR.

Важно про контекст: `n_ctx` — глобальная настройка Settings
(`ModelStore.contextInitParams.n_ctx`), а не свойство Pal. Pal задаёт только
`n_predict` (лимит выходных токенов). Экран Server показывает фактический
контекст и предупреждает, если `n_predict` больше него; при изменении
Context Size после загрузки модели `Start server` перезагружает контекст.

---

## 2. Порядок работ и точные изменения

### C0. Логи: видеть входящий запрос и исходящий ответ

Файл: `src/services/localServer/requestHandler.ts`

1. Добавить helper `describeBody(body: string)`:

```ts
const BODY_PREVIEW_LIMIT = 2000;

function describeBody(body: string): {
  detail?: string;
  stream?: boolean;
  messages?: number;
} {
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') {
      return {detail: truncate(body, BODY_PREVIEW_LIMIT)};
    }
    const record = parsed as Record<string, unknown>;
    return {
      detail: prettyJson(parsed),
      stream: record.stream === true,
      messages: Array.isArray(record.messages)
        ? record.messages.length
        : undefined,
    };
  } catch {
    return {detail: truncate(body, BODY_PREVIEW_LIMIT)};
  }
}
```

2. В `handle()` запись `kind:'request'` дополнить:

```ts
const bodyInfo = describeBody(req.body);
this.deps.log({
  ...,
  stream: bodyInfo.stream,
  messages: bodyInfo.messages,
  detail: bodyInfo.detail,
  summary: `${method} ${path}${bodyInfo.stream ? ' · stream' : ''}`,
});
```

3. В `logResponse` extra добавить `remoteAddress` в запись (по аналогии с
   request-записью).

4. В `handleChat` / `handleCompletion` в `logResponse` передавать **превью
   ответа**, а не параметры запроса:

```ts
detail: prettyJson({
  finish_reason: finishReasonFromResult(result),
  content: truncate(finalContent, 1500),
}),
```

Для legacy `/v1/completions` в streaming-ветке накопить текст:

```ts
let streamed = '';
const result = await engine.completion(params, data => {
  if (data.token) {
    streamed += data.token;
    // ...существующий streamChunk
  }
});
```

5. Добавить тест в `__tests__/requestHandler.test.ts`: request-запись содержит
   `detail` с `max_tokens`, response-запись содержит превью `Hello`.

Критерий: на экране по тапу на REQ видно тело запроса, по тапу на RESP — текст
ответа и finish_reason.

---

### B3. Селектор Pal на экране

Файл: `src/store/LocalServerStore.ts`

- Добавить геттер (используется и обработчиком, и экраном):

```ts
get systemPrompt(): string {
  return resolveSystemPrompt({
    pal: this.selectedPal,
    model: this.selectedModel,
  });
}
```

- В deps обработчика: `getSystemPrompt: () => this.systemPrompt`.
- В `selectPal()` писать lifecycle-запись (только если сервер запущен):

```ts
selectPal(palId: string | undefined): void {
  this.palId = palId;
  if (this.running) {
    this.logLifecycle(
      this.selectedPal ? `Pal selected: ${this.selectedPal.name}` : 'Pal cleared',
    );
    this.updateNotification(true);
  }
}
```

Файл: `src/screens/ServerScreen/ServerScreen.tsx`

- Импорт: `import {Dropdown} from '../../components/ui';`
- В карточке `Configuration` **над** списком моделей:

```tsx
<Text style={styles.label}>{l10n.server.palTitle}</Text>
<Text style={styles.hint}>{l10n.server.palHint}</Text>
<Dropdown
  testID="server-pal-select"
  value={localServerStore.palId ?? '__none__'}
  options={[
    {value: '__none__', label: l10n.server.palNone},
    ...localServerStore.availablePals.map(pal => ({
      value: pal.id,
      label: pal.name,
    })),
  ]}
  onChange={value =>
    localServerStore.selectPal(value === '__none__' ? undefined : value)
  }
  disabled={!canEdit || localServerStore.loadingModel}
/>
{localServerStore.systemPrompt ? (
  <Text style={[styles.hint, styles.palPreview]} numberOfLines={2}>
    {l10n.server.palPromptPreview.replace(
      '{{preview}}',
      localServerStore.systemPrompt,
    )}
  </Text>
) : null}
```

Строки `palTitle`, `palHint`, `palNone`, `palPromptPreview` уже есть в
`src/locales/en.json` (секция `server`). Новые строки — только туда.

Критерий: выбор Pal меняет системный промпт в запросе (тест
`requestHandler.test.ts` уже покрывает склейку); «None» возвращает поведение
без Pal.

---

### C3. Карточка логов на экране

Файл: `src/screens/ServerScreen/ServerLogList.tsx`

- Добавить prop `onClear: () => void`.
- Над списком — строка с кнопкой:

```tsx
<Button
  mode="text"
  compact
  onPress={onClear}
  disabled={logs.length === 0}
  testID="server-log-clear">
  {l10n.server.logsClear}
</Button>
```

- Пустой список оставить как сейчас (`l10n.server.logsEmpty`), но кнопку
  показывать всегда (disabled).

Файл: `src/screens/ServerScreen/ServerScreen.tsx`

- Импорт `ServerLogList`.
- После карточки эндпоинтов:

```tsx
<Card style={styles.card}>
  <Card.Title title={l10n.server.logsTitle} />
  <Card.Content>
    <ServerLogList
      logs={localServerStore.logs}
      onClear={() => localServerStore.clearLogs()}
    />
  </Card.Content>
</Card>
```

Критерий: каждый запрос даёт REQ + RESP; ошибка — ERR; «Очистить» работает;
после перезапуска приложения лог пуст (не персистится).

---

### D. Постоянное уведомление с действиями

#### D1. `android/app/src/main/AndroidManifest.xml`

Добавить permissions рядом с `POST_NOTIFICATIONS`:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
```

Внутрь `<application>` (рядом с DownloadJobService):

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

#### D2. `android/app/src/main/java/com/pocketpalai/LocalServerNotifications.kt` (новый)

```kotlin
package com.pocketpal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/** Ongoing "server is running" notification; labels arrive from JS as JSON. */
class LocalServerNotifications(private val context: Context) {

  private val launchIntent: PendingIntent? =
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE)
      }

  private fun ensureChannel(name: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val existing = manager.getNotificationChannel(CHANNEL_ID)
    if (existing == null) {
      manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW))
    } else if (existing.name != name) {
      existing.name = name
      manager.createNotificationChannel(existing)
    }
  }

  fun build(payloadJson: String): Notification {
    val payload = try {
      JSONObject(payloadJson)
    } catch (_: Exception) {
      JSONObject()
    }
    val title = payload.optString("title").ifEmpty { DEFAULT_TITLE }
    val model = payload.optString("model")
    val address = payload.optString("address")
    val requests = payload.optInt("requests", 0)
    val channelName = payload.optString("channelName").ifEmpty { DEFAULT_CHANNEL_NAME }
    val stopLabel = payload.optString("stopLabel").ifEmpty { DEFAULT_STOP }
    val unloadLabel = payload.optString("unloadLabel").ifEmpty { DEFAULT_UNLOAD }
    ensureChannel(channelName)

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }

    builder
        .setSmallIcon(android.R.drawable.stat_sys_upload)
        .setContentTitle(title)
        .setContentText(model)
        .setSubText(address)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .setContentIntent(launchIntent)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      builder.setSilent(true)
    }
    if (requests > 0) {
      builder.setNumber(requests)
    }
    builder.addAction(action(stopLabel, ACTION_STOP_SERVER, 1))
    builder.addAction(action(unloadLabel, ACTION_STOP_AND_UNLOAD, 2))
    return builder.build()
  }

  private fun action(label: String, action: String, code: Int): Notification.Action {
    val intent = Intent(context, LocalServerService::class.java).setAction(action)
    val pending = PendingIntent.getService(
        context,
        code,
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return Notification.Action.Builder(null, label, pending).build()
  }

  companion object {
    const val CHANNEL_ID = "local_server"
    const val DEFAULT_TITLE = "PocketPal server"
    const val DEFAULT_CHANNEL_NAME = "Local server"
    const val DEFAULT_STOP = "Stop"
    const val DEFAULT_UNLOAD = "Stop and unload model"
    const val ACTION_STOP_SERVER = "com.pocketpal.localServer.STOP"
    const val ACTION_STOP_AND_UNLOAD = "com.pocketpal.localServer.STOP_AND_UNLOAD"
  }
}
```

#### D3. `android/app/src/main/java/com/pocketpalai/LocalServerService.kt` (новый)

```kotlin
package com.pocketpal

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat

/** Foreground service that owns the ongoing notification and its actions. */
class LocalServerService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_SHOW -> {
        payloadJson = intent.getStringExtra(EXTRA_PAYLOAD) ?: payloadJson
        startForegroundCompat(LocalServerNotifications(this).build(payloadJson))
      }
      LocalServerNotifications.ACTION_STOP_SERVER -> {
        LocalServerModule.dispatchNotificationAction(ACTION_STOP)
        stopForegroundCompat()
        stopSelf()
      }
      LocalServerNotifications.ACTION_STOP_AND_UNLOAD -> {
        LocalServerModule.dispatchNotificationAction(ACTION_STOP_AND_UNLOAD)
        stopForegroundCompat()
        stopSelf()
      }
      else -> stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun startForegroundCompat(notification: Notification) {
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }

  override fun onDestroy() {
    payloadJson = ""
    super.onDestroy()
  }

  companion object {
    const val ACTION_SHOW = "com.pocketpal.localServer.SHOW"
    const val ACTION_STOP = "stop"
    const val ACTION_STOP_AND_UNLOAD = "stop-and-unload"
    private const val EXTRA_PAYLOAD = "payload"
    private const val NOTIFICATION_ID = 0x5E7A
    @Volatile private var payloadJson: String = ""

    fun show(context: Context, payload: String) {
      val intent = Intent(context, LocalServerService::class.java)
          .setAction(ACTION_SHOW)
          .putExtra(EXTRA_PAYLOAD, payload)
      ContextCompat.startForegroundService(context, intent)
    }

    fun hide(context: Context) {
      context.stopService(Intent(context, LocalServerService::class.java))
    }
  }
}
```

Важно: `startForeground` вызывается сразу в `onStartCommand`, не ждёт JS.

#### D4. `LocalServerModule.kt`

- Импорты: `java.lang.ref.WeakReference`.
- В класс: `init { instanceRef = WeakReference(this) }`.
- В `start()` после успешного bind/accept:

```kotlin
LocalServerService.show(reactApplicationContext, defaultNotificationPayload())
```

- В `stop()` после закрытия сокета: `LocalServerService.hide(reactApplicationContext)`.
- Новый метод (должен появиться в TS-spec, см. D5):

```kotlin
override fun updateNotification(payloadJson: String) {
  if (running.get()) {
    LocalServerService.show(reactApplicationContext, payloadJson)
  }
}
```

- Мост в JS:

```kotlin
fun emitNotificationAction(action: String) {
  emit("LocalServer:notificationAction", Arguments.createMap().apply {
    putString("action", action)
  })
}
```

- В `invalidate()`: `LocalServerService.hide(reactApplicationContext)`,
  `instanceRef = null`, затем существующая очистка.
- В `companion object`:

```kotlin
private var instanceRef: WeakReference<LocalServerModule>? = null

fun dispatchNotificationAction(action: String): Boolean {
  val module = instanceRef?.get() ?: return false
  module.emitNotificationAction(action)
  return true
}

private fun defaultNotificationPayload(): String =
    JSONObject()
        .put("title", "PocketPal server")
        .put("model", "")
        .put("address", "http://127.0.0.1:$boundPort")
        .put("requests", 0)
        .put("channelName", "Local server")
        .put("stopLabel", "Stop")
        .put("unloadLabel", "Stop and unload model")
        .toString()
```

#### D5. JS-спека и store

`src/specs/NativeLocalServer.ts`:

```ts
updateNotification(payloadJson: string): void;
```

`src/store/LocalServerStore.ts`:

- Новый тип события в `NativeEventEmitter`:
  `'LocalServer:notificationAction': [{action: 'stop' | 'stop-and-unload'}]`.
- Подписка в `setupNativeEvents()`:

```ts
this.eventEmitter.addListener(
  'LocalServer:notificationAction',
  (event: {action: 'stop' | 'stop-and-unload'}) => {
    if (event.action === 'stop') {
      void this.stopServer();
    } else {
      void this.stopServerAndUnload();
    }
  },
);
```

- `notificationPayload()` (адрес — LAN IP, если включён LAN):

```ts
private notificationPayload(): string {
  const address =
    this.allowLan && this.lanIp
      ? `http://${this.lanIp}:${this.port}`
      : this.baseUrl;
  return JSON.stringify({
    title: uiStore.l10n.server.notificationTitle,
    model: this.servedModelName,
    address,
    requests: this.requestCount,
    channelName: uiStore.l10n.server.notificationChannel,
    stopLabel: uiStore.l10n.server.stop,
    unloadLabel: uiStore.l10n.server.stopAndUnload,
  });
}
```

- `private lanIp: string | null = null;` + `refreshLanIp()` через
  `DeviceInfo.getIpAddress()`.
- `private lastNotificationAt = 0;` + `updateNotification(force = false)` с
  троттлингом 1 запись/сек; вызывать:
  - в `startServer()` после успешного старта (`force = true`, сначала
    `refreshLanIp()` при `allowLan`);
  - в `selectPal()`;
  - в `finally` метода `handleRequest`.
- В `startServer()` **до** `NativeLocalServer!.start(...)`:
  `await ensureNotificationPermission();`
- `ensureNotificationPermission()` (`src/utils/androidPermission.ts`):
  порог `Number(Platform.Version) < 33` (POST_NOTIFICATIONS появился в API 33),
  тест `androidPermission.test.ts` — кейс «ниже Android 13» с `Version = 32`.

Строки в `src/locales/en.json` (`server`):

```json
"notificationTitle": "PocketPal server",
"notificationChannel": "Local server"
```

#### D6. Поведение

- Запуск сервера → постоянное уведомление, две кнопки.
- Свайп приложения из recents не убивает сервер (FGS + сокет в процессе).
- «Stop» → `stopServer()`; «Stop and unload model» → `stopServerAndUnload()`.
- Если JS-модуля нет (процесс без RN), сервис просто закрывается.

---

### E. Кнопки «Остановить» / «Остановить и выгрузить»

Методы store уже есть (`stopServerAndUnload`, `unloadModel`). Осталось UI.

Файл: `src/screens/ServerScreen/ServerScreen.tsx`, блок `styles.actions`:

```tsx
<View style={styles.actionsRow}>
  {localServerStore.running ? (
    <>
      <Button
        mode="contained"
        onPress={() => localServerStore.stopServer()}
        testID="server-stop-button">
        {l10n.server.stop}
      </Button>
      <Button
        mode="outlined"
        onPress={() => localServerStore.stopServerAndUnload()}
        testID="server-stop-unload-button">
        {l10n.server.stopAndUnload}
      </Button>
    </>
  ) : (
    <>
      <Button
        mode="contained"
        onPress={handleStart}
        disabled={
          !localServerStore.supported ||
          localServerStore.starting ||
          localServerStore.loadingModel ||
          localServerStore.availableModels.length === 0
        }
        loading={localServerStore.starting || localServerStore.loadingModel}
        testID="server-start-button">
        {l10n.server.start}
      </Button>
      {localServerStore.modelLoaded ? (
        <Button
          mode="text"
          onPress={() => localServerStore.unloadModel()}
          testID="server-unload-button">
          {l10n.server.unloadModel}
        </Button>
      ) : null}
    </>
  )}
</View>
```

Строки `stopAndUnload`, `unloadModel` уже есть в `en.json`.

Критерий: «Stop and unload» → `modelStore.context === undefined`,
`activeModelId === undefined`; простой «Stop» оставляет модель загруженной.

---

### F. Проверка

```powershell
yarn typecheck
yarn lint
yarn jest src/services/localServer src/screens/ServerScreen src/utils/__tests__/androidPermission.test.ts --coverage=false
yarn test
cd android
.\gradlew.bat :app:assembleProdDebug --console=plain
```

Ручной чек-лист — в `docs/local-server-plan.md`, раздел F2.

---

## 3. Риски, которые нельзя забыть

1. **Android-only.** iOS не поддерживается; `supported` уже это учитывает.
2. **FGS type `specialUse`.** Для Play нужен subtype (добавлен property). Для
   локальных сборок ок. `dataSync` — альтернатива с лимитом 6 ч на Android 15.
3. **Старт FGS из фона запрещён (Android 12+).** Наш сценарий — видимая
   активность, поэтому ок.
4. **Общий llama-контекст.** Сервер и чат могут конкурировать; `getEngine()`
   бросает ошибку, если `modelStore.inferencing`. Это известное ограничение v1.
5. **Логи.** Ring buffer 200, тела усечены (запрос ~4000, ответ ~1500 символов),
   не персистятся.
6. **Pal с талантами.** `pact.talents` не исполняются сервером; `tools` только
   из запроса клиента.
7. **Мультимодальные Pal.** `video/realtime/audio` исключены из `availablePals`.
8. **Порт занят.** `EADDRINUSE` уже возвращается в JS.

---

## 4. Журнал работ

### 2026-10-31 — сессия 1 (аудит + план)

- Прочитаны `docs/local-server-plan.md`, `LocalServerStore.ts`,
  `requestHandler.ts`, `prompt.ts`, `log.ts`, `types.ts`, `openaiApi.ts`,
  `ServerScreen.tsx`, `ServerLogList.tsx`, `NativeLocalServer.ts`,
  `LocalServerModule.kt`, `AndroidManifest.xml`, `androidPermission.ts`.
- Прогнаны `yarn typecheck` и целевые тесты: всё зелёное (50 тестов).
- Зафиксировано: A и B2 готовы, B3/C3/D/E не готовы.
- Создан этот файл.

### 2026-10-31 — сессия 1 (реализация)

Порядок фактических правок:

1. **C0. Логи запрос/ответ** — `src/services/localServer/requestHandler.ts`:
   добавлен `describeBody()` (pretty JSON, `stream`, число `messages`,
   усечение 2000), request-запись теперь содержит тело и флаг stream;
   response-запись содержит `finish_reason` и превью ответа (1500 символов);
   `remoteAddress` добавлен и в response. Новый тест в
   `requestHandler.test.ts` проверяет `detail` у REQ и RESP.
2. **C1/C3. UI логов** — `ServerLogList.tsx` получил `onClear` и кнопку
   `server-log-clear`; `ServerScreen.tsx` рендерит карточку `logsTitle`
   под эндпоинтами и передаёт `localServerStore.logs` / `clearLogs()`.
3. **B3. Pal** — `LocalServerStore.systemPrompt` (геттер) используется и
   обработчиком, и экраном; `selectPal()` пишет lifecycle и обновляет
   уведомление; на экране `Dropdown` (`server-pal-select`) + превью промпта.
4. **E. Кнопки** — на экране: при `running` — «Stop» и «Stop and unload
   model»; при остановленном сервере и загруженной модели — «Unload model».
   testID: `server-stop-unload-button`, `server-unload-button`.
5. **D. Уведомление**:
   - manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`,
     `<service ... foregroundServiceType="specialUse">` + property;
   - новые `LocalServerNotifications.kt` (канал `local_server`, две action-
     кнопки, payload JSON из JS) и `LocalServerService.kt` (FGS,
     `startForeground` сразу в `onStartCommand`, `START_NOT_STICKY`);
   - `LocalServerModule.kt`: `WeakReference` на модуль, `updateNotification`,
     `emitNotificationAction`, `dispatchNotificationAction`, показ/скрытие
     сервиса в `start`/`stop`/`invalidate`;
   - `NativeLocalServer.ts`: `updateNotification(payloadJson)`;
   - `LocalServerStore.ts`: событие `LocalServer:notificationAction`,
     `notificationPayload()`, `refreshLanIp()` (DeviceInfo), троттлинг
     обновления 1/сек, `ensureNotificationPermission()` перед стартом;
   - `androidPermission.ts`: порог POST_NOTIFICATIONS исправлен на API 33;
     тест обновлён (кейс API 32).
6. **Строки** — только `src/locales/en.json`: `notificationTitle`,
   `notificationChannel`. В `locales.test.ts` в `EXPECTED_SECTIONS` добавлен
   `server` (секция появилась ещё в прошлой сессии, тест не был обновлён).
7. **Тема** — в `ServerScreen/styles.ts` `theme.radius.xs` заменён на
   `theme.borders.default`, чтобы не нарушать invariant-тест токенов.

Проверки после правок:

```text
yarn typecheck                                   OK (39 s)
yarn lint                                        OK (0 errors, 46 pre-existing warnings)
yarn jest src/services/localServer \
  src/utils/__tests__/androidPermission.test.ts  OK (5 suites, 51 tests)
yarn jest src/locales/__tests__/locales.test.ts \
  src/theme/tokens/__tests__/invariants.test.ts  OK (114 tests)
.\gradlew.bat :app:compileProdDebugKotlin         BUILD SUCCESSFUL
.\gradlew.bat :app:assembleProdDebug              BUILD SUCCESSFUL (3m 12s)
```

APK: `android/app/build/outputs/apk/prod/debug/app-prod-debug.apk`.

`yarn test` (полный прогон) на этой Windows-машине даёт падения **вне**
затронутой области:

- `scripts/__tests__/verify-ios-symbol-overlap.test.js` — нет macOS `nm`/`c++filt`;
- `src/hooks/__tests__/useNavigationBarAppearance.test.ts` — сравнение путей
  с `/`, на Windows приходит `\`;
- `scripts/__tests__/ggml-vendor-names.test.js` — существующий файл
  `src/__automation__/logSignals.ts` содержит `lm_ggml`;
- `scripts/__tests__/verify-android-payload.test.js` — circular JSON в
  jest-worker;
- `ChatInput.test.tsx` — таймаут одного теста (флаки).

Перед PR эти падения нужно либо воспроизвести на CI/macOS, либо оформить
отдельно; к local server они отношения не имеют.

### 2026-10-31 — сессия 2 (ручная проверка на устройстве)

Устройство: `2211133G` (Xiaomi 13), Android 16 / API 36, MIUI, USB-отладка.
Установлен `app-prod-debug.apk` (`adb install -r`), проверка через
`adb shell curl` (сервер слушает loopback устройства; `adb reverse` на этой
машине не создаёт host-listener, поэтому запросы шли из shell устройства).

Проверено по F2:

- **Старт сервера.** Модель `Qwen3.5 4B` загружена, `Start server` →
  статус `Running`, lifecycle-записи `Model loaded`, `Server started on
  127.0.0.1:8080`.
- **Уведомление.** `dumpsys notification` показывает ongoing-уведомление
  канала `local_server`, `FOREGROUND_SERVICE`, две action-кнопки
  «Stop server» / «Stop and unload model», title `PocketPal server`, subText
  с адресом, text с именем модели, `number` = число запросов. В шторке
  уведомление разворачивается и обе кнопки видны.
- **Фон.** После `KEYCODE_HOME` запрос `POST /v1/chat/completions` с хоста
  устройства выполнился, сервер продолжил отвечать; уведомление обновило
  счётчик запросов.
- **Кнопки уведомления.** «Stop server» → сервер перестал отвечать
  (`curl` exit 7), уведомление исчезло, модель осталась загруженной
  (после возврата в приложение — `Model loaded`, кнопка `Unload model`).
  «Stop and unload model» → сервер остановлен, модель выгружена
  (`Model not loaded`, кнопка `Load model`), в логах `Server stopped` и
  `Model unloaded: Qwen3.5 4B`.
- **Логи.** Видны `SYS` (lifecycle), `REQ`, `RESP`, `ERR` (400 при битом
  JSON). По тапу на REQ раскрывается pretty-JSON тела запроса
  (`model`, `messages`, `max_tokens`), по тапу на RESP — `finish_reason` и
  превью ответа. В meta-строке — статус, время, токены. `Clear` очищает
  список. Логи не переживают перезапуск приложения.
- **Pal.** Выбор `Pip` → в логах `Pal selected: Pip`, превью системного
  промпта; `prompt_tokens` в запросе вырос с 16 до 45. Выбор
  `None (model default)` → `Pal cleared`, `prompt_tokens` снова 16.
- **Стриминг.** `stream: true` отдаёт SSE-чанки (`reasoning_content`, затем
  `content`), финальный чанк с `finish_reason`, затем `[DONE]`.
- **LAN.** Тумблер включён, сервер слушает `::` (все интерфейсы), в
  `/proc/net/tcp6` порт `1F90`. На устройстве нет Wi-Fi (только mobile
  data), поэтому проверка «с ПК по Wi-Fi» не выполнялась — нужен стенд с
  общей сетью.
- **Кнопки на экране.** `Stop server` останавливает сервер; при
  остановленном сервере и загруженной модели видна `Unload model`; при
  запущенном — `Stop server` + `Stop and unload model`.

Найдено и исправлено во время проверки:

1. **Pal нельзя было менять при запущенном сервере.** `Dropdown` был
   задизейблен через `canEdit` (`!running && !starting`), хотя
   `selectPal()` рассчитан на работу на лету. Теперь disabled только при
   `starting`/`loadingModel`; проверено на устройстве: меню открывается,
   `Pal selected`/`Pal cleared` пишутся в лог.
2. **Лишнее `messages` в RESP-записи.** Строка ответа показывала
   «1 messages» (данные запроса). `messages` убран из `logResponse` и из
   двух вызовов в `handleChat`; в `requestHandler.test.ts` добавлена
   проверка `logs[1].messages` → `undefined`.

Проверки после правок:

```text
yarn typecheck                                   OK (19 s)
yarn lint                                        OK (0 errors, 46 pre-existing warnings)
yarn jest src/services/localServer                OK (4 suites, 43 tests)
.\gradlew.bat :app:assembleProdDebug              BUILD SUCCESSFUL (2m 3s)
```

Повторная установка APK и проверка исправлений на устройстве выполнена.

Осталось перед PR:

1. Полный `yarn test` на CI/macOS — на этой Windows-машине падают
   несвязанные тесты (список выше).
2. Проверить LAN с ПК в той же Wi-Fi-сети (на тестовом устройстве Wi-Fi
   не было).
3. Указать в PR способ проверки: устройство 2211133G, Android 16 (API 36),
   ручной чек-лист F2 + приложить скриншоты экрана Server и уведомления.

### 2026-10-31 — сессия 3 (контекст Pal и ответ 500)

**Симптом.** Pal `ByeDPI` (большой системный промпт, `n_predict: 8192`)
при заполнении контекста получал `500` с телом, где не было понятной
причины.

**Диагноз.**

- В логе устройства: `ERR Context is full, 500, 0.3 s`. Строка приходит из
  `llama.rn/cpp/jsi/RNLlamaJSI.cpp`: промпт целиком не влез в `n_ctx`,
  генерация ещё не начиналась.
- Размер контекста — глобальная настройка `ModelStore.contextInitParams.n_ctx`
  (в БД было `2048`), а не свойство Pal. Pal задаёт только `n_predict`
  (лимит выходных токенов). Отсюда ощущение, что «настройки Pal не влияют»:
  они и не должны менять `n_ctx`, но UI об этом не сообщал.
- Дополнительно: `ModelStore.initContext()` не перезагружает уже загруженную
  модель, поэтому изменение Context Size в Settings после загрузки не
  применялось при `Start server`.

**Что сделано.**

1. **Понятная ошибка вместо 500** — `requestHandler.ts`: `CONTEXT_FULL_ERROR`
   (`/context is full/i`) маппится в `400 invalid_request_error` с текстом,
   который говорит увеличить Context Size в Settings и перезапустить сервер.
2. **`finish_reason`** — `openaiApi.ts`: `context_full` теперь отдаётся как
   `length` (раньше только `stopped_limit`).
3. **`/health`** — добавлено поле `context` (фактический `n_ctx`).
4. **Store** — `LocalServerStore.ts`:
   - `contextSize` — контекст загруженной модели, если сервер обслуживает
     именно её, иначе значение из Settings;
   - `palRequestedTokens` — `n_predict` выбранного Pal;
   - `contextReloadPending` — Settings разошлись с загруженным контекстом;
   - `configuredContextSize` — значение, которое применит следующая загрузка;
   - `getContextSize()` в зависимостях обработчика;
   - lifecycle-запись `Model loaded` теперь содержит `context=… tokens`;
   - `startServer()` перезагружает модель, если `contextReloadPending`
     (перед `initContext` вызывается `releaseContext()`), иначе
     `initContext()` молча переиспользовал старый контекст.
5. **Экран** — `ServerScreen.tsx`: строка `Context: N tokens (set in
   Settings, not by the Pal)`, красное предупреждение, если `n_predict` Pal
   больше контекста, и предупреждение о необходимости перезапуска, если
   Settings изменены после загрузки.
6. **Строки** — только `en.json`: `server.contextSize`,
   `server.contextReloadPending`, `server.palTokensWarning`.
7. **Тесты** — `requestHandler.test.ts`: `getContextSize` в deps, `context`
   в `/health`, кейс «Context is full → 400 + сообщение»;
   `openaiApi.test.ts`: `context_full → finish_reason: "length"`.

**Проверки.**

```text
yarn typecheck                                   OK (39 s)
yarn lint                                        OK (0 errors, 46 pre-existing warnings)
yarn jest src/services/localServer                OK (4 suites, 44 tests)
.\gradlew.bat :app:assembleProdDebug              BUILD SUCCESSFUL (2m 37s)
```

На устройстве 2211133G экран Server показал
`Context: 2048 tokens (set in Settings, not by the Pal)` и предупреждение
`This pal can generate up to 8192 tokens, but the context is 2048…`.
Дальнейшую ручную проверку (запрос больше контекста → 400, перезапуск с
новым Context Size) пользователь продолжил сам.

**Осознанно не делаем.** Автоперезагрузку с бо́льшим контекстом: на слабых
устройствах это может привести к OOM. Вместо этого показываем лимит и
просим изменить Settings и перезапустить сервер.

**Установка и релиз.** Коммит `58794d6` отправлен в `origin/main`, APK
(`388 556 326` байт, SHA-256 `A845D707…D5F6D3`) установлен на 2211133G через
`adb install -r` (`versionName=1.21.2`, `lastUpdateTime=19:44`). Ассет в
релизе `v1.21.2-local-server` заменён на эту сборку (digest совпадает),
описание обновлено, тег переведён на `58794d6`.

### 2026-10-31 — сессия 4 (трафик, статус генерации, `onClientClosed`)

**1. Трафик и иконка уведомления.**

- `LocalServerModule.kt`: добавлены `AtomicLong` счётчики `bytesIn` /
  `bytesOut`. Входящие считаются по строке запроса, заголовкам и телу;
  исходящие — в `ClientConnection.write()` (включая заголовки ответа).
  Счётчики сбрасываются в `start()` и отдаются в `getStatus()` как
  `bytesIn` / `bytesOut`.
- `LocalServerNotifications.kt`: иконка `stat_sys_upload` (анимированная)
  заменена на статичную `stat_notify_chat`. В уведомлении:
  `contentText` — статус генерации, `subText` — трафик, `BigTextStyle` —
  модель, адрес, статус, трафик и число запросов.
- `LocalServerStore.ts`: раз в секунду тикер опрашивает `getStatus()`,
  обновляет счётчики и перерисовывает уведомление; тикер стартует вместе с
  сервером и останавливается в `releaseResources()`. Байты форматируются в
  B/KB/MB/GB (`formatBytes`). Новые строки в `en.json`:
  `notificationIdle`, `notificationGenerating`, `notificationTraffic`,
  `notificationRequests`.

**2. `TypeError: Cannot read property 'catch' of undefined`.**

- Причина: `modelStore.context?.stopCompletion().catch(...)` — в этой сборке
  `stopCompletion()` может вернуть `undefined`, и `.catch` падал в
  `onClientClosed`. Все такие вызовы заменены на `stopQuietly(() => ...)`
  (`src/utils/stopQuietly.ts`) в store и в `requestHandler.ts`.
- Вторая причина «запрос есть, ответа нет»: `handleClient` ждал EOF на
  чтении и считал это закрытием клиента. Клиент, который закрывает свою
  сторону записи после тела запроса (half-close), получал `clientClosed`
  ещё до ответа, и `handleRequest` молча пропускал запрос. Теперь EOF
  больше не считается отключением: сокет живёт до ответа, а реальный обрыв
  определяется ошибкой записи в `ClientConnection`, которая эмитит
  `clientClosed` и убирает соединение из map.

**3. Статус генерации и tok/s.**

- `ServerHandlerDeps`: `onGenerationStart/Token/End`. В
  `requestHandler.ts` все четыре вызова `engine.completion` идут через
  `complete()`, который включает состояние перед prefill, считает каждый
  токен из callback (даже для non-streaming) и гарантированно выключает
  состояние в `finally`.
- `LocalServerStore.ts`: `generating`, `generatedTokens`, `generationRate`.
  Токены считаются в необзервабливом счётчике, раз в секунду синхронизируются
  на экран; tok/s — от первого токена, чтобы prefill не занижал скорость.
- `ServerScreen.tsx`: при генерации — `Generating · N tokens · X tok/s`,
  при простое — `Idle — waiting for requests`. В уведомлении — то же
  состояние и скорость.

**Проверки.**

```text
yarn typecheck                                   OK (18 s)
yarn lint                                        OK (0 errors, 46 warnings)
yarn jest src/services/localServer \
  src/utils/__tests__/stopQuietly.test.ts \
  src/locales/__tests__/locales.test.ts          OK (6 suites, 160 tests)
.\gradlew.bat :app:compileProdDebugKotlin         BUILD SUCCESSFUL (2m 29s)
```

Добавлены тесты: generation-хуки вызываются (start/token/end) и `end`
срабатывает при ошибке движка; ожидание параметров completion переведено на
`mock.calls[0][0]`, потому что теперь всегда передаётся callback.

### 2026-11-01 — сессия 5 (маскот, мониторинг ресурсов, полные логи)

**1. Иконка уведомления — маскот.**

- Из `src/assets/pocketpal.gif` (85 кадров, 150×150) собраны ассеты:
  `drawable-nodpi/ic_mascot_00..11.png` — 12 кадров цветного маскота для
  крупного значка; `drawable-xxhdpi/ic_stat_pocketpal.png` — белый силуэт
  (глаза и улыбка вырезаны) для строки состояния. Строка состояния требует
  монохромную иконку, поэтому там силуэт статичный.
- `LocalServerNotifications.kt`: `setSmallIcon(R.drawable.ic_stat_pocketpal)`,
  `setLargeIcon()` с кадром маскота, `bigText`, `subText` (ресурсы), время
  скрыто (`setShowWhen(false)`), общий `NOTIFICATION_ID`.
- Новый `LocalServerNotificationAnimator.kt`: пока `generating` в payload
  равно `true`, `Handler` раз в 160 мс перепубликовывает уведомление со
  следующим кадром (анимация «оживает»); в простое остаётся покоящийся кадр.
  `updateNotification` теперь идёт через аниматор (а не перезапускает
  foreground-сервис), поэтому секундные обновления не сбрасывают кадр.
  Аниматор останавливается в `stop()`, `invalidate()` и `onDestroy()`
  сервиса, включая кнопки Stop / Stop+Unload.

**2. Мониторинг ресурсов.**

- `LocalServerModule.statusMap()`: `cpuPercent` (дельта
  `Process.getElapsedCpuTime()` к wall time, ограничение по числу ядер),
  `processMemoryBytes` (`Debug.MemoryInfo.totalPss`),
  `systemMemoryUsedBytes` / `systemMemoryTotalBytes` (`ActivityManager`),
  `batteryTempC` и `batteryLevel` (sticky `ACTION_BATTERY_CHANGED`).
- `LocalServerStore`: новые observable-поля, обновляются тем же секундным
  тикером, что и трафик; в payload уведомления добавлены `resources` и
  `generating`.
- `ServerScreen.tsx`: карточка «Device resources» — CPU, память приложения,
  системная память (использовано / всего), батарея (%, °C), трафик.
- `en.json`: `notificationResources`, `resourcesTitle`, `resourceCpu`,
  `resourceAppMemory`, `resourceSystemMemory`, `resourceBattery`,
  `resourceTraffic`, `resourcesIdle`.

**3. Полные логи.**

- `log.ts`: `truncate` по умолчанию больше не режет на 4000 символах —
  потолок `LOG_DETAIL_LIMIT = 1_000_000` (защита от патологического тела).
- `requestHandler.ts`: убраны `BODY_PREVIEW_LIMIT` и
  `RESPONSE_PREVIEW_LIMIT`; тело запроса и текст ответа пишутся целиком.
- Тесты: длинные (6 000 символов) промпт и ответ присутствуют в `detail` без
  многоточия; `prettyJson` сохраняет длинные значения.

**Проверки.**

```text
yarn typecheck                                   OK
yarn jest src/services/localServer              OK
yarn lint                                        OK (0 errors)
.\gradlew.bat :app:assembleProdDebug             BUILD SUCCESSFUL
```

Установлено на 2211133G через `adb install -r`.

### 2026-11-02 — сессия 6 (встроенный Pal ByeDPI)

- `src/store/builtinPals.ts`: системный промпт, `completionSettings`
  (`n_predict: 2048`, `temperature: 0.25`, `top_k: 35`, `top_p: 0.9`,
  `stop: ["</s>"]`, `jinja`, `enable_thinking`), pact (render_html,
  calculate, web_search, read_url, datetime) и рекомендуемая модель
  Qwen2.5-3B-Instruct Q4_K_M. Промпт, настройки и pact сняты с рабочей базы
  устройства (`local_pals`), чтобы Pal вёл себя как настроенный вручную.
- `PalStore.initializeByeDpiPal()`: сеет Pal один раз по ключу
  `PalStore.builtin.ByeDPI.seeded`; если Pal с таким именем уже есть (как на
  устройстве пользователя), запись не перезаписывается, дубликат не
  создаётся, а ключ всё равно проставляется — значит правки промпта
  переживают обновления приложения.

**Проверки.**

```text
yarn typecheck                                   OK
yarn lint                                        OK (0 errors)
.\gradlew.bat :app:assembleProdDebug             BUILD SUCCESSFUL
```

Установлено на 2211133G; приложение стартует без ошибок JS.

### 2026-11-02 — сессия 7 (уведомление в фоне)

**Проблема.** Пока приложение не на экране, уведомление замирало: трафик,
CPU/RAM/батарея и счётчик токенов не обновлялись, «оживали» только при
возврате в приложение.

**Причина.** Секундный `setInterval` в `LocalServerStore` — JS-таймер, а
Android приостанавливает таймеры приложения, когда оно не на переднем плане.
Замер на устройстве подтвердил: за 10 с в фоне `numUpdatedByApp` уведомления
не вырос ни на единицу, хотя сервер в это время отвечал на HTTP-запросы
(то есть JS-поток жив и события из native до него доходят).

**Решение.** Тик перенесён на нативную сторону:

- `LocalServerModule`: пока слушатель запущен, `Handler` раз в секунду шлёт в
  JS событие `LocalServer:tick` (стартует в `start()`, останавливается в
  `stop()`/`invalidate()`). События, в отличие от таймеров, доставляются и в
  фоне — так же, как приходят входящие запросы.
- `LocalServerStore`: подписка на `LocalServer:tick` вызывает тот же
  `refreshLiveStatus()`; общий дебаунс 500 мс, чтобы фоновый тик и
  foreground-интервал не дублировали работу.

**Про Pal ByeDPI.** Отдельной доработки не требует: он сеется как Pip
(`PalStore.initializeByeDpiPal`). Выбор пала в разделе Server — это
сохранённая настройка `palId` в AsyncStorage (mobx-persist-store), код её не
подставляет: по умолчанию там `undefined` и в списке стоит «None». Если в
списке выбран ByeDPI, значит он был выбран вручную раньше (например, при
тестировании сервера) — сбрасывается выбором «None» или другого пала.

**Проверки.**

```text
yarn typecheck                                   OK
.\gradlew.bat :app:compileProdDebugKotlin        BUILD SUCCESSFUL
.\gradlew.bat :app:assembleProdDebug             BUILD SUCCESSFUL
```

Обновление уведомления в фоне после фикса на устройстве ещё не проверено —
проверяет пользователь.
