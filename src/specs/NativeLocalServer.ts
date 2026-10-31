import type {TurboModule} from 'react-native';
import {Platform, TurboModuleRegistry} from 'react-native';

/** What the native TCP listener is currently doing. */
export interface LocalServerStatus {
  running: boolean;
  port: number;
  allowLan: boolean;
  /** Socket bytes received/sent since the listener started. */
  bytesIn: number;
  bytesOut: number;
}

/**
 * Native HTTP listener used by the built-in OpenAI-compatible server.
 *
 * The native side owns sockets and HTTP framing only. Each parsed request is
 * emitted to JS as `LocalServer:request`; JS answers through `respond` (one
 * shot) or `streamStart`/`streamChunk`/`streamEnd` (SSE). A client that hangs
 * up before the response is finished is reported as `LocalServer:clientClosed`.
 */
export interface Spec extends TurboModule {
  // Required by NativeEventEmitter.
  addListener(eventName: string): void;
  removeListeners(count: number): void;

  start(port: number, allowLan: boolean): Promise<LocalServerStatus>;
  stop(): Promise<void>;
  getStatus(): Promise<LocalServerStatus>;

  /** Creates or updates the ongoing foreground-service notification. */
  updateNotification(payloadJson: string): void;

  respond(
    requestId: string,
    statusCode: number,
    headersJson: string,
    body: string,
  ): void;
  streamStart(requestId: string, statusCode: number, headersJson: string): void;
  streamChunk(requestId: string, text: string): void;
  streamEnd(requestId: string): void;
}

const NativeLocalServer: Spec | null =
  Platform.OS === 'android'
    ? TurboModuleRegistry.getEnforcing<Spec>('LocalServerModule')
    : null;

export default NativeLocalServer;
