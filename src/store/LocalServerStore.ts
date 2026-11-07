import {NativeEventEmitter, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DeviceInfo from 'react-native-device-info';
import {makeAutoObservable, runInAction, toJS} from 'mobx';
import {makePersistable} from 'mobx-persist-store';

import NativeLocalServer from '../specs/NativeLocalServer';
import type {LocalServerStatus} from '../specs/NativeLocalServer';
import {Pal} from '../types/pal';
import {Model, ModelOrigin, ModelType} from '../utils/types';
import {acquireKeepAwake} from '../utils/keepAwake';
import {ensureNotificationPermission} from '../utils/androidPermission';
import {resolveSystemPrompt} from '../utils/systemPromptResolver';
import {stopQuietly} from '../utils/stopQuietly';
import {appendServerLog} from '../services/localServer/log';
import {BadRequestError} from '../services/localServer/openaiApi';
import {ServerRequestHandler} from '../services/localServer/requestHandler';
import type {
  ServerEngine,
  ServerLogEntry,
  ServerRequest,
  ServerResponseWriter,
} from '../services/localServer/types';

import {chatSessionStore} from './ChatSessionStore';
import {palStore} from './PalStore';
import {modelStore} from './ModelStore';
import {uiStore} from './UIStore';

const DEFAULT_PORT = 8080;
const AUTO_RELEASE_REASON = 'local-server';

/** Settings the server is allowed to take from global/Pal defaults. */
const GENERATION_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'typical_p',
  'tfs_z',
  'repeat_penalty',
  'repeat_last_n',
  'presence_penalty',
  'frequency_penalty',
  'penalize_nl',
  'mirostat',
  'mirostat_tau',
  'mirostat_eta',
  'n_predict',
  'seed',
  'ignore_eos',
];

export interface LocalServerRequestEvent {
  requestId: string;
  method: string;
  path: string;
  headers: string;
  body: string;
  remoteAddress?: string;
}

export interface LocalServerClientClosedEvent {
  requestId: string;
}

const uniqueStrings = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
};

const cleanStopWords = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return value ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
};

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Compact byte count for the notification ("1.2 MB", "340 KB"). */
const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || size >= 10 ? Math.round(size) : size.toFixed(1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
};

/**
 * Owns the built-in OpenAI-compatible server: the selected model/Pal, the
 * listen port and LAN switch, the request queue that serialises inference
 * through the single llama.rn context, and the in-memory request log.
 */
class LocalServerStore {
  port = DEFAULT_PORT;
  allowLan = false;
  modelId: string | undefined = undefined;
  palId: string | undefined = undefined;

  running = false;
  starting = false;
  loadingModel = false;
  error: string | null = null;
  requestCount = 0;
  lastRequestAt: number | null = null;
  logs: ServerLogEntry[] = [];

  /** True while a completion is running; drives the screen and notification. */
  generating = false;
  generatedTokens = 0;
  generationRate = 0;

  /** Machine load, refreshed once a second while the server is running. */
  cpuPercent = 0;
  processMemoryBytes = 0;
  systemMemoryUsedBytes = 0;
  systemMemoryTotalBytes = 0;
  batteryTempC = 0;
  batteryLevel = 0;

  // Internal counters, excluded from MobX so traffic/token ticks do not
  // re-render the screen on every token.
  trafficIn = 0;
  trafficOut = 0;
  liveTokens = 0;
  firstTokenAt = 0;
  statusTimer: ReturnType<typeof setInterval> | null = null;

  private keepAwakeRelease: (() => void) | null = null;
  private lanIp: string | null = null;
  private lastNotificationAt = 0;
  private lastStatusRefreshAt = 0;
  private eventEmitter: NativeEventEmitter<{
    'LocalServer:request': [LocalServerRequestEvent];
    'LocalServer:clientClosed': [LocalServerClientClosedEvent];
    'LocalServer:notificationAction': [{action: 'stop' | 'stop-and-unload'}];
    'LocalServer:tick': [];
  }> | null = null;
  private subscriptions: Array<{remove: () => void}> = [];
  private queue: Promise<void> = Promise.resolve();
  private closedRequests = new Set<string>();
  private pendingRequests = new Set<string>();
  private activeRequestId: string | null = null;

  private handler = new ServerRequestHandler({
    getEngine: () => this.getEngine(),
    getModelName: () => this.servedModelName,
    getPalName: () => this.selectedPal?.name,
    getSystemPrompt: () => this.systemPrompt,
    getDefaultParams: () => this.defaultParams(),
    getContextSize: () => this.contextSize,
    getStopWords: requestStops => this.getStopWords(requestStops),
    onGenerationStart: () => this.beginGeneration(),
    onGenerationToken: () => this.noteGenerationToken(),
    onGenerationEnd: () => this.endGeneration(),
    log: entry => this.pushLog(entry),
  });

  constructor() {
    makeAutoObservable(
      this,
      {
        trafficIn: false,
        trafficOut: false,
        liveTokens: false,
        firstTokenAt: false,
        statusTimer: false,
      },
      {autoBind: true},
    );

    makePersistable(this, {
      name: 'LocalServerStore',
      properties: ['port', 'allowLan', 'modelId', 'palId'],
      storage: AsyncStorage,
    }).catch(() => {
      // A failed hydration only loses remembered UI preferences.
    });

    this.setupNativeEvents();
  }

  get supported(): boolean {
    return Platform.OS === 'android' && NativeLocalServer !== null;
  }

  get busy(): boolean {
    return this.activeRequestId !== null;
  }

  /** Downloaded models the server can actually load. */
  get availableModels(): Model[] {
    return modelStore.models.filter(
      model =>
        model.isDownloaded &&
        model.origin !== ModelOrigin.REMOTE &&
        model.modelType !== ModelType.PROJECTION &&
        model.modelType !== ModelType.DRAFT,
    );
  }

  get selectedModel(): Model | undefined {
    const model = this.modelId
      ? modelStore.models.find(item => item.id === this.modelId)
      : undefined;
    if (model && model.isDownloaded && model.origin !== ModelOrigin.REMOTE) {
      return model;
    }
    // Falling back keeps the first run (and a deleted model) from leaving the
    // screen with nothing selected and Start silently disabled.
    return this.availableModels[0];
  }

  /** Pals whose capabilities make sense for a text API. */
  get availablePals(): Pal[] {
    return palStore.pals.filter(pal => {
      const capabilities = pal.capabilities;
      return (
        !capabilities?.video && !capabilities?.realtime && !capabilities?.audio
      );
    });
  }

  get selectedPal(): Pal | undefined {
    return this.palId ? palStore.getPalById(this.palId) : undefined;
  }

  /** Pal prompt (or the model's template prompt) applied to every request. */
  get systemPrompt(): string {
    return resolveSystemPrompt({
      pal: this.selectedPal,
      model: this.selectedModel,
    });
  }

  get modelLoaded(): boolean {
    const model = this.selectedModel;
    return !!(
      model &&
      modelStore.context &&
      modelStore.activeModelId === model.id
    );
  }

  /**
   * The context size requests actually run against: the loaded context when
   * the served model is the active one, otherwise the configured value the
   * next load will use. Pals never change this — it lives in Settings.
   */
  get contextSize(): number {
    const model = this.selectedModel;
    if (
      model &&
      modelStore.activeModelId === model.id &&
      modelStore.activeContextSettings?.n_ctx
    ) {
      return modelStore.activeContextSettings.n_ctx;
    }
    return modelStore.contextInitParams.n_ctx;
  }

  /** Max output tokens the selected Pal asks for, when it sets one. */
  get palRequestedTokens(): number | undefined {
    const value = Number(this.selectedPal?.completionSettings?.n_predict);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /**
   * True when the served model is loaded with a context size that no longer
   * matches Settings (the user changed it after the load). initContext()
   * skips an already-loaded model, so Start has to release it first.
   */
  get contextReloadPending(): boolean {
    const model = this.selectedModel;
    return !!(
      model &&
      modelStore.context &&
      modelStore.activeModelId === model.id &&
      modelStore.activeContextSettings?.n_ctx !==
        modelStore.contextInitParams.n_ctx
    );
  }

  /** The context size the next model load will use. */
  get configuredContextSize(): number {
    return modelStore.contextInitParams.n_ctx;
  }

  /** The id advertised by /v1/models and echoed in completions. */
  get servedModelName(): string {
    return this.selectedModel?.name ?? 'pocketpal';
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  selectModel(modelId: string | undefined): void {
    this.modelId = modelId;
  }

  selectPal(palId: string | undefined): void {
    this.palId = palId;
    if (this.running) {
      this.logLifecycle(
        this.selectedPal
          ? `Pal selected: ${this.selectedPal.name}`
          : 'Pal cleared',
      );
      this.updateNotification(true);
    }
  }

  setPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.error = 'Port must be between 1 and 65535';
      return;
    }
    this.port = port;
    this.error = null;
  }

  setAllowLan(allowLan: boolean): void {
    this.allowLan = allowLan;
  }

  clearLogs(): void {
    this.logs = [];
  }

  private pushLog(entry: ServerLogEntry): void {
    runInAction(() => {
      this.logs = appendServerLog(this.logs, entry);
    });
  }

  private logLifecycle(summary: string, detail?: string): void {
    this.pushLog({
      id: `${Date.now().toString(36)}-${this.logs.length}`,
      at: Date.now(),
      kind: 'lifecycle',
      summary,
      detail,
    });
  }

  async startServer(): Promise<boolean> {
    if (this.starting || this.running) {
      return this.running;
    }
    if (!this.supported) {
      this.error =
        'The built-in server is currently available on Android only.';
      return false;
    }

    const model = this.selectedModel;
    if (!model) {
      this.error = 'Select a downloaded model first.';
      return false;
    }
    if (!model.isDownloaded) {
      this.error = 'The selected model is not downloaded.';
      return false;
    }

    runInAction(() => {
      this.starting = true;
      this.error = null;
    });

    try {
      await ensureNotificationPermission();
      if (!this.modelLoaded || this.contextReloadPending) {
        const loaded = await this.loadSelectedModel();
        if (!loaded) {
          return false;
        }
      }

      const status: LocalServerStatus = await NativeLocalServer!.start(
        this.port,
        this.allowLan,
      );

      runInAction(() => {
        this.running = status.running;
        this.port = status.port || this.port;
        this.allowLan = status.allowLan;
      });
      this.holdResources();
      await this.refreshLanIp();
      this.updateNotification(true);
      this.startStatusTimer();
      this.logLifecycle(
        `Server started on ${this.allowLan ? '0.0.0.0' : '127.0.0.1'}:${
          this.port
        }`,
        `model=${this.servedModelName}${this.selectedPal ? ` pal=${this.selectedPal.name}` : ''}`,
      );
      return true;
    } catch (error: any) {
      runInAction(() => {
        this.error = error?.message ?? 'Failed to start the server.';
      });
      return false;
    } finally {
      runInAction(() => {
        this.starting = false;
      });
    }
  }

  /**
   * Loads the selected model without starting the listener, so the user can
   * warm it up (or fix a load error) before exposing an endpoint.
   */
  async loadSelectedModel(): Promise<boolean> {
    if (this.loadingModel) {
      return false;
    }
    const model = this.selectedModel;
    if (!model) {
      this.error = 'Select a downloaded model first.';
      return false;
    }
    if (!model.isDownloaded) {
      this.error = 'The selected model is not downloaded.';
      return false;
    }

    runInAction(() => {
      this.loadingModel = true;
      this.error = null;
    });
    try {
      if (this.contextReloadPending) {
        // The user changed the context size after this model was loaded;
        // initContext() would otherwise reuse the stale context.
        await modelStore.releaseContext();
      }
      await modelStore.initContext(model);
      this.logLifecycle(
        `Model loaded: ${model.name}`,
        `context=${this.contextSize} tokens`,
      );
      return true;
    } catch (error: any) {
      runInAction(() => {
        this.error = error?.message ?? 'Failed to load the model.';
      });
      return false;
    } finally {
      runInAction(() => {
        this.loadingModel = false;
      });
    }
  }

  async stopServer(): Promise<void> {
    if (!this.supported) {
      return;
    }
    if (this.activeRequestId) {
      // Do not leave a socket-less generation burning CPU.
      stopQuietly(() => modelStore.context?.stopCompletion());
    }
    try {
      await NativeLocalServer!.stop();
    } catch (error: any) {
      runInAction(() => {
        this.error = error?.message ?? 'Failed to stop the server.';
      });
    } finally {
      runInAction(() => {
        this.running = false;
      });
      this.releaseResources();
      this.logLifecycle('Server stopped');
    }
  }

  /** Stops the listener and frees the llama context (notification action). */
  async stopServerAndUnload(): Promise<void> {
    const modelId = this.selectedModel?.id;
    await this.stopServer();
    // Let the last queued generation finish/abort before touching the context.
    await this.queue.catch(() => {});
    if (
      modelId &&
      modelStore.activeModelId === modelId &&
      !modelStore.inferencing
    ) {
      await modelStore.manualReleaseContext();
      this.logLifecycle(`Model unloaded: ${this.servedModelName}`);
    }
  }

  async unloadModel(): Promise<void> {
    if (this.running || this.starting) {
      return;
    }
    const model = this.selectedModel;
    if (model && modelStore.activeModelId === model.id) {
      await modelStore.manualReleaseContext();
      this.logLifecycle(`Model unloaded: ${model.name}`);
    }
  }

  private holdResources(): void {
    modelStore.disableAutoRelease(AUTO_RELEASE_REASON);
    if (!this.keepAwakeRelease) {
      this.keepAwakeRelease = acquireKeepAwake();
    }
  }

  private releaseResources(): void {
    this.stopStatusTimer();
    modelStore.enableAutoRelease(AUTO_RELEASE_REASON);
    this.keepAwakeRelease?.();
    this.keepAwakeRelease = null;
  }

  private setupNativeEvents(): void {
    if (!this.supported) {
      return;
    }
    try {
      this.eventEmitter = new NativeEventEmitter(NativeLocalServer as any);
      this.subscriptions.push(
        this.eventEmitter.addListener(
          'LocalServer:request',
          (event: LocalServerRequestEvent) => this.onRequest(event),
        ),
      );
      this.subscriptions.push(
        this.eventEmitter.addListener(
          'LocalServer:clientClosed',
          (event: LocalServerClientClosedEvent) =>
            this.onClientClosed(event.requestId),
        ),
      );
      this.subscriptions.push(
        this.eventEmitter.addListener(
          'LocalServer:notificationAction',
          (event: {action: 'stop' | 'stop-and-unload'}) => {
            if (event.action === 'stop') {
              this.stopServer().catch(() => {});
            } else {
              this.stopServerAndUnload().catch(() => {});
            }
          },
        ),
      );
      // Native heartbeat: Android pauses JS timers in the background, so the
      // module pokes us once a second to keep metrics and the notification
      // fresh while another app is on screen.
      this.subscriptions.push(
        this.eventEmitter.addListener('LocalServer:tick', () =>
          this.onNativeTick(),
        ),
      );
    } catch (error) {
      console.warn('Failed to attach local server events:', error);
    }

    NativeLocalServer!
      .getStatus()
      .then(status => {
        runInAction(() => {
          if (status.running) {
            this.running = true;
            this.port = status.port || this.port;
            this.allowLan = status.allowLan;
            this.holdResources();
          }
        });
        if (status.running) {
          this.startStatusTimer();
        }
      })
      .catch(() => {});
  }

  private onRequest(event: LocalServerRequestEvent): void {
    this.pendingRequests.add(event.requestId);
    runInAction(() => {
      this.requestCount += 1;
      this.lastRequestAt = Date.now();
    });
    this.queue = this.queue
      .then(() => this.handleRequest(event))
      .catch(error => {
        console.warn('Local server request failed:', error);
      });
  }

  private onClientClosed(requestId: string): void {
    // A close that arrives after the handler finished is just the normal end
    // of a one-shot connection; only track closes for requests still waiting
    // or generating, otherwise this set grows for the whole process lifetime.
    if (!this.pendingRequests.has(requestId)) {
      return;
    }
    this.closedRequests.add(requestId);
    if (this.activeRequestId === requestId) {
      // The client is gone; stop burning tokens for nobody.
      stopQuietly(() => modelStore.context?.stopCompletion());
    }
  }

  private async handleRequest(event: LocalServerRequestEvent): Promise<void> {
    const {requestId} = event;

    if (this.closedRequests.delete(requestId)) {
      this.pendingRequests.delete(requestId);
      return;
    }

    if (!this.running) {
      this.pendingRequests.delete(requestId);
      NativeLocalServer?.respond(
        requestId,
        503,
        this.headers(),
        JSON.stringify({
          error: {
            message: 'The local server is stopping',
            type: 'server_error',
            param: null,
            code: null,
          },
        }),
      );
      return;
    }

    this.activeRequestId = requestId;
    try {
      await this.handler.handle(
        this.toRequest(event),
        this.responder(requestId),
      );
    } finally {
      this.activeRequestId = null;
      this.closedRequests.delete(requestId);
      this.pendingRequests.delete(requestId);
      this.updateNotification();
    }
  }

  private toRequest(event: LocalServerRequestEvent): ServerRequest {
    let headers: Record<string, string> = {};
    try {
      headers = JSON.parse(event.headers);
    } catch {
      // A malformed header blob is treated as empty; the handler does not use
      // headers for routing today.
    }
    return {
      requestId: event.requestId,
      method: event.method,
      path: event.path,
      headers,
      body: event.body,
      remoteAddress: event.remoteAddress,
    };
  }

  private responder(requestId: string): ServerResponseWriter {
    return {
      json: (status, body) => {
        NativeLocalServer?.respond(requestId, status, this.headers(), body);
      },
      sseStart: () => {
        NativeLocalServer?.streamStart(requestId, 200, this.streamHeaders());
      },
      sseChunk: payload => {
        NativeLocalServer?.streamChunk(requestId, payload);
      },
      sseEnd: () => {
        NativeLocalServer?.streamEnd(requestId);
      },
      isClosed: () => this.closedRequests.has(requestId),
    };
  }

  private async getEngine(): Promise<ServerEngine> {
    const model = this.selectedModel;
    if (!model) {
      throw new BadRequestError('No model selected on the Server screen');
    }
    if (!model.isDownloaded) {
      throw new BadRequestError('The selected model is not downloaded');
    }
    if (modelStore.inferencing) {
      throw new Error('The model is busy with a chat completion');
    }
    if (modelStore.activeModelId !== model.id || !modelStore.context) {
      await modelStore.initContext(model);
    }
    if (!modelStore.context) {
      throw new Error('The model could not be loaded');
    }
    return modelStore.context as unknown as ServerEngine;
  }

  private getStopWords(requestStops?: string[]): string[] {
    const modelStops = cleanStopWords(toJS(modelStore.activeModel?.stopWords));
    return uniqueStrings([
      ...(Array.isArray(requestStops) ? requestStops : []),
      ...modelStops,
    ]);
  }

  /**
   * Global + Pal generation settings, restricted to sampler keys: the Pal
   * resolver also injects talent tools, which the server must not advertise.
   */
  private async defaultParams(): Promise<Record<string, unknown>> {
    try {
      const settings = await chatSessionStore.resolveCompletionSettings(
        undefined,
        this.palId,
      );
      const source = settings as unknown as Record<string, unknown>;
      const params: Record<string, unknown> = {};
      for (const key of GENERATION_KEYS) {
        if (source[key] !== undefined) {
          params[key] = source[key];
        }
      }
      return params;
    } catch {
      return {};
    }
  }

  private async refreshLanIp(): Promise<void> {
    if (!this.allowLan) {
      this.lanIp = null;
      return;
    }
    try {
      const ip = await DeviceInfo.getIpAddress();
      this.lanIp = ip && ip !== 'unknown' ? ip : null;
    } catch {
      this.lanIp = null;
    }
  }

  private beginGeneration(): void {
    runInAction(() => {
      this.generating = true;
      this.generatedTokens = 0;
      this.generationRate = 0;
      this.liveTokens = 0;
      this.firstTokenAt = 0;
    });
    this.updateNotification(true);
  }

  private noteGenerationToken(): void {
    this.liveTokens += 1;
    if (!this.firstTokenAt) {
      this.firstTokenAt = Date.now();
    }
  }

  private endGeneration(): void {
    const tokens = this.liveTokens;
    const elapsed = this.firstTokenAt
      ? (Date.now() - this.firstTokenAt) / 1000
      : 0;
    runInAction(() => {
      this.generating = false;
      this.generatedTokens = tokens;
      this.generationRate = elapsed > 0 ? tokens / elapsed : 0;
    });
    this.liveTokens = 0;
    this.firstTokenAt = 0;
    this.updateNotification(true);
  }

  /** Refreshes the visible token count/rate while a completion is running. */
  private syncGenerationStats(): void {
    if (!this.generating) {
      return;
    }
    const elapsed = this.firstTokenAt
      ? (Date.now() - this.firstTokenAt) / 1000
      : 0;
    runInAction(() => {
      this.generatedTokens = this.liveTokens;
      this.generationRate = elapsed > 0 ? this.liveTokens / elapsed : 0;
    });
  }

  private startStatusTimer(): void {
    if (!this.supported || this.statusTimer) {
      return;
    }
    this.statusTimer = setInterval(() => {
      this.refreshLiveStatus().catch(() => {});
    }, 1000);
  }

  private stopStatusTimer(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /**
   * Native one-second heartbeat. Timers freeze in the background, so this is
   * what keeps the notification's metrics moving while the app is not on
   * screen; the interval above covers the foreground. Both funnel through the
   * same debounce.
   */
  private onNativeTick(): void {
    if (!this.running) {
      return;
    }
    this.refreshLiveStatus().catch(() => {});
  }

  /** Pulls socket byte counters and refreshes the ongoing notification. */
  private async refreshLiveStatus(): Promise<void> {
    if (!this.running) {
      this.stopStatusTimer();
      return;
    }
    const now = Date.now();
    if (now - this.lastStatusRefreshAt < 500) {
      return;
    }
    this.lastStatusRefreshAt = now;
    try {
      const status = await NativeLocalServer!.getStatus();
      this.trafficIn = status.bytesIn ?? 0;
      this.trafficOut = status.bytesOut ?? 0;
      runInAction(() => {
        this.cpuPercent = status.cpuPercent ?? 0;
        this.processMemoryBytes = status.processMemoryBytes ?? 0;
        this.systemMemoryUsedBytes = status.systemMemoryUsedBytes ?? 0;
        this.systemMemoryTotalBytes = status.systemMemoryTotalBytes ?? 0;
        this.batteryTempC = status.batteryTempC ?? 0;
        this.batteryLevel = status.batteryLevel ?? 0;
      });
    } catch {
      // Keep the last known counters; the listener itself is unaffected.
    }
    this.syncGenerationStats();
    this.updateNotification(true);
  }

  private notificationPayload(): string {
    const address =
      this.allowLan && this.lanIp
        ? `http://${this.lanIp}:${this.port}`
        : this.baseUrl;
    const traffic = uiStore.l10n.server.notificationTraffic
      .replace('{{in}}', formatBytes(this.trafficIn))
      .replace('{{out}}', formatBytes(this.trafficOut));
    const resources = uiStore.l10n.server.notificationResources
      .replace('{{cpu}}', this.cpuPercent.toFixed(0))
      .replace('{{memory}}', formatBytes(this.processMemoryBytes))
      .replace('{{temp}}', this.batteryTempC.toFixed(1));
    const status = this.generating
      ? uiStore.l10n.server.notificationGenerating
          .replace('{{tokens}}', String(this.generatedTokens))
          .replace('{{rate}}', this.generationRate.toFixed(1))
      : uiStore.l10n.server.notificationIdle;
    const bigText = [
      this.servedModelName,
      address,
      status,
      traffic,
      resources,
      uiStore.l10n.server.notificationRequests.replace(
        '{{count}}',
        String(this.requestCount),
      ),
    ].join('\n');
    return JSON.stringify({
      title: uiStore.l10n.server.notificationTitle,
      model: this.servedModelName,
      address,
      requests: this.requestCount,
      status,
      traffic,
      resources,
      generating: this.generating,
      bigText,
      channelName: uiStore.l10n.server.notificationChannel,
      stopLabel: uiStore.l10n.server.stop,
      unloadLabel: uiStore.l10n.server.stopAndUnload,
    });
  }

  /** Pushes the notification at most once a second; `force` for state changes. */
  private updateNotification(force = false): void {
    if (!this.running || !this.supported) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastNotificationAt < 1000) {
      return;
    }
    this.lastNotificationAt = now;
    try {
      NativeLocalServer!.updateNotification(this.notificationPayload());
    } catch {
      // The notification is best-effort; the server keeps serving.
    }
  }

  private headers(extra: Record<string, string> = {}): string {
    return JSON.stringify({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
      ...extra,
    });
  }

  private streamHeaders(): string {
    return this.headers({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  }
}

export const localServerStore = new LocalServerStore();
