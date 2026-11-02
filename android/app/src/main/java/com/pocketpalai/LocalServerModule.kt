package com.pocketpal

import android.app.ActivityManager
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Debug
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.pocketpal.specs.NativeLocalServerSpec
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.lang.ref.WeakReference
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Minimal HTTP/1.1 listener for the built-in OpenAI-compatible server.
 *
 * It deliberately knows nothing about inference or JSON payloads: a request is
 * parsed into method/path/headers/body and handed to JS, which writes the
 * response back. One connection serves one request and is then closed, which
 * keeps keep-alive/pipelining out of the picture.
 */
@ReactModule(name = NativeLocalServerSpec.NAME)
class LocalServerModule(reactContext: ReactApplicationContext) :
    NativeLocalServerSpec(reactContext) {

  private var serverSocket: ServerSocket? = null
  private var acceptThread: Thread? = null
  private val connections = ConcurrentHashMap<String, ClientConnection>()
  private val running = AtomicBoolean(false)
  private val bytesIn = AtomicLong(0)
  private val bytesOut = AtomicLong(0)

  @Volatile private var boundPort: Int = 0
  @Volatile private var allowLan: Boolean = false

  // Previous CPU sample, so getStatus() can report a rate instead of totals.
  private var cpuSampleAt = 0L
  private var cpuSampleCpuMs = 0L
  private var lastCpuPercent = 0.0

  init {
    instanceRef = WeakReference(this)
  }

  override fun addListener(eventName: String) {}

  override fun removeListeners(count: Double) {}

  override fun start(port: Double, allowLan: Boolean, promise: Promise) {
    if (running.get()) {
      promise.resolve(statusMap())
      return
    }

    val requestedPort = port.toInt()
    if (requestedPort < 1 || requestedPort > 65535) {
      promise.reject("EINVALIDPORT", "Port must be between 1 and 65535")
      return
    }

    try {
      val address = InetAddress.getByName(if (allowLan) "0.0.0.0" else "127.0.0.1")
      val socket = ServerSocket()
      socket.reuseAddress = true
      socket.bind(InetSocketAddress(address, requestedPort))

      serverSocket = socket
      boundPort = requestedPort
      this.allowLan = allowLan
      bytesIn.set(0)
      bytesOut.set(0)
      running.set(true)

      acceptThread = Thread({ acceptLoop(socket) }, "LocalServerAccept").apply {
        isDaemon = true
        start()
      }
      // Show a notification immediately; JS replaces it with localised text.
      // A notification failure must not take the listener down with it.
      try {
        LocalServerService.show(reactApplicationContext, defaultNotificationPayload())
      } catch (e: Exception) {
        Log.w(TAG, "Failed to show the server notification", e)
      }
      promise.resolve(statusMap())
    } catch (e: Exception) {
      Log.e(TAG, "Failed to start server", e)
      closeServerSocket()
      running.set(false)
      promise.reject(
          if (e is java.net.BindException) "EADDRINUSE" else "ESTART",
          e.message ?: "Failed to start server",
          e)
    }
  }

  override fun stop(promise: Promise) {
    try {
      running.set(false)
      closeServerSocket()
      connections.values.forEach { it.closeNow() }
      connections.clear()
      LocalServerNotificationAnimator.stop()
      LocalServerService.hide(reactApplicationContext)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("ESTOP", e.message ?: "Failed to stop server", e)
    }
  }

  override fun getStatus(promise: Promise) {
    promise.resolve(statusMap())
  }

  override fun updateNotification(payloadJson: String) {
    if (!running.get()) {
      return
    }
    try {
      LocalServerNotificationAnimator.update(
          reactApplicationContext, payloadJson)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to update the server notification", e)
    }
  }

  private fun defaultNotificationPayload(): String =
      JSONObject()
          .put("title", LocalServerNotifications.DEFAULT_TITLE)
          .put("model", "")
          .put("address", "http://127.0.0.1:$boundPort")
          .put("requests", 0)
          .put("status", "")
          .put("traffic", "")
          .put("resources", "")
          .put("generating", false)
          .put("bigText", "")
          .put("channelName", LocalServerNotifications.DEFAULT_CHANNEL_NAME)
          .put("stopLabel", LocalServerNotifications.DEFAULT_STOP)
          .put("unloadLabel", LocalServerNotifications.DEFAULT_UNLOAD)
          .toString()

  override fun respond(
      requestId: String,
      statusCode: Double,
      headersJson: String,
      body: String
  ) {
    val connection = connections.remove(requestId)
    if (connection == null) {
      Log.w(TAG, "No connection for request $requestId")
      return
    }

    val bodyBytes = body.toByteArray(Charsets.UTF_8)
    val headers = parseHeaders(headersJson)
    if (!headers.has("Content-Length")) {
      headers.put("Content-Length", bodyBytes.size.toString())
    }
    val head = buildHead(statusCode.toInt(), headers)
    connection.write(head.toByteArray(Charsets.UTF_8))
    connection.write(bodyBytes)
    connection.finish()
  }

  override fun streamStart(
      requestId: String,
      statusCode: Double,
      headersJson: String
  ) {
    val connection = connections[requestId]
    if (connection == null) {
      Log.w(TAG, "No connection for stream $requestId")
      return
    }

    val headers = parseHeaders(headersJson)
    if (!headers.has("Content-Type")) {
      headers.put("Content-Type", "text/event-stream; charset=utf-8")
    }
    if (!headers.has("Cache-Control")) {
      headers.put("Cache-Control", "no-cache")
    }
    connection.write(buildHead(statusCode.toInt(), headers).toByteArray(Charsets.UTF_8))
  }

  override fun streamChunk(requestId: String, text: String) {
    connections[requestId]?.write(text.toByteArray(Charsets.UTF_8))
  }

  override fun streamEnd(requestId: String) {
    connections.remove(requestId)?.finish()
  }

  override fun invalidate() {
    running.set(false)
    closeServerSocket()
    connections.values.forEach { it.closeNow() }
    connections.clear()
    LocalServerNotificationAnimator.stop()
    LocalServerService.hide(reactApplicationContext)
    instanceRef = null
    super.invalidate()
  }

  /** Called by [LocalServerService] when a notification action is tapped. */
  fun emitNotificationAction(action: String) {
    emit("LocalServer:notificationAction", Arguments.createMap().apply {
      putString("action", action)
    })
  }

  private fun acceptLoop(socket: ServerSocket) {
    while (running.get() && !socket.isClosed) {
      try {
        val client = socket.accept()
        Thread({ handleClient(client) }, "LocalServerClient").apply {
          isDaemon = true
          start()
        }
      } catch (e: Exception) {
        if (running.get()) {
          Log.w(TAG, "Accept failed", e)
        }
      }
    }
  }

  private fun handleClient(socket: Socket) {
    var requestId: String? = null
    try {
      socket.soTimeout = HEADER_TIMEOUT_MS
      val input = BufferedInputStream(socket.getInputStream())
      var received = 0

      val requestLine = readLine(input) ?: return
      received += requestLine.toByteArray(Charsets.UTF_8).size + 2
      val parts = requestLine.split(" ")
      if (parts.size < 2) {
        return
      }
      val method = parts[0].uppercase()
      var path = parts[1]
      // Some clients send an absolute-form request target.
      if (path.startsWith("http://") || path.startsWith("https://")) {
        val schemeEnd = path.indexOf("://") + 3
        val slash = path.indexOf('/', schemeEnd)
        path = if (slash >= 0) path.substring(slash) else "/"
      }

      val headers = LinkedHashMap<String, String>()
      var headerBytes = 0
      while (true) {
        val line = readLine(input) ?: break
        received += line.toByteArray(Charsets.UTF_8).size + 2
        if (line.isEmpty()) {
          break
        }
        headerBytes += line.length
        if (headerBytes > MAX_HEADER_BYTES) {
          throw IllegalArgumentException("Request headers too large")
        }
        val colon = line.indexOf(':')
        if (colon > 0) {
          headers[line.substring(0, colon).trim().lowercase()] =
              line.substring(colon + 1).trim()
        }
      }

      val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
      if (contentLength < 0 || contentLength > MAX_BODY_BYTES) {
        throw IllegalArgumentException("Request body too large")
      }
      val body = readBody(input, contentLength)
      received += contentLength
      bytesIn.addAndGet(received.toLong())

      val id = UUID.randomUUID().toString()
      requestId = id
      val connection =
          ClientConnection(socket, id, bytesOut) { abortedId ->
            connections.remove(abortedId)?.closeNow()
            emitClientClosed(abortedId)
          }
      connection.start()
      connections[id] = connection

      val params = Arguments.createMap().apply {
        putString("requestId", id)
        putString("method", method)
        putString("path", path)
        putString("headers", JSONObject(headers).toString())
        putString("body", body)
        putString("remoteAddress", socket.inetAddress?.hostAddress ?: "")
      }
      emit("LocalServer:request", params)

      // The connection stays open until the response is written or the writer
      // reports a real disconnect. EOF on the request stream only means the
      // client sent nothing else; it does not mean it stopped reading.
    } catch (e: Exception) {
      Log.w(TAG, "Failed to handle request", e)
      if (requestId != null) {
        connections.remove(requestId)?.closeNow()
      } else {
        try {
          socket.close()
        } catch (_: Exception) {
        }
      }
    }
  }

  private fun emitClientClosed(requestId: String) {
    val params = Arguments.createMap().apply {
      putString("requestId", requestId)
    }
    emit("LocalServer:clientClosed", params)
  }

  private fun emit(eventName: String, params: WritableMap) {
    try {
      reactApplicationContext.runOnJSQueueThread {
        try {
          reactApplicationContext
              .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              .emit(eventName, params)
        } catch (e: Exception) {
          Log.w(TAG, "Failed to emit $eventName", e)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to schedule $eventName", e)
    }
  }

  private fun statusMap(): WritableMap =
      Arguments.createMap().apply {
        putBoolean("running", running.get())
        putInt("port", boundPort)
        putBoolean("allowLan", allowLan)
        putDouble("bytesIn", bytesIn.get().toDouble())
        putDouble("bytesOut", bytesOut.get().toDouble())
        putDouble("cpuPercent", readCpuPercent())
        putDouble("processMemoryBytes", readProcessMemoryBytes().toDouble())
        val (systemUsed, systemTotal) = readSystemMemory()
        putDouble("systemMemoryUsedBytes", systemUsed.toDouble())
        putDouble("systemMemoryTotalBytes", systemTotal.toDouble())
        val (batteryTemp, batteryLevel) = readBattery()
        putDouble("batteryTempC", batteryTemp)
        putDouble("batteryLevel", batteryLevel)
      }

  /** CPU used by this process since the previous call, relative to wall time. */
  private fun readCpuPercent(): Double {
    val now = System.currentTimeMillis()
    val cpuMs = android.os.Process.getElapsedCpuTime()
    if (cpuSampleAt > 0 && now > cpuSampleAt) {
      val wall = (now - cpuSampleAt).toDouble()
      val used = (cpuMs - cpuSampleCpuMs).toDouble()
      val cores = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
      lastCpuPercent = (used / wall * 100.0).coerceIn(0.0, cores * 100.0)
    }
    cpuSampleAt = now
    cpuSampleCpuMs = cpuMs
    return lastCpuPercent
  }

  /** Resident memory of this process (total PSS), in bytes. */
  private fun readProcessMemoryBytes(): Long =
      try {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        info.totalPss.toLong() * 1024L
      } catch (_: Exception) {
        0L
      }

  /** Device RAM in use / total, in bytes. */
  private fun readSystemMemory(): Pair<Long, Long> =
      try {
        val manager =
            reactApplicationContext.getSystemService(ActivityManager::class.java)
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        Pair(info.totalMem - info.availMem, info.totalMem)
      } catch (_: Exception) {
        Pair(0L, 0L)
      }

  /** Battery temperature in °C and charge level in percent. */
  private fun readBattery(): Pair<Double, Double> =
      try {
        val intent =
            reactApplicationContext.registerReceiver(
                null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val temperature =
            (intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) ?: 0
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val percent = if (scale > 0) level.toDouble() / scale * 100.0 else 0.0
        Pair(temperature, percent)
      } catch (_: Exception) {
        Pair(0.0, 0.0)
      }

  private fun closeServerSocket() {
    try {
      serverSocket?.close()
    } catch (_: Exception) {
    }
    serverSocket = null
    acceptThread = null
  }

  private fun parseHeaders(headersJson: String): JSONObject {
    return try {
      JSONObject(headersJson)
    } catch (_: Exception) {
      JSONObject()
    }
  }

  private fun buildHead(statusCode: Int, headers: JSONObject): String {
    val builder = StringBuilder()
    builder
        .append("HTTP/1.1 ")
        .append(statusCode)
        .append(' ')
        .append(reasonPhrase(statusCode))
        .append("\r\n")
    val keys = headers.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      builder.append(key).append(": ").append(headers.optString(key)).append("\r\n")
    }
    builder.append("Connection: close\r\n\r\n")
    return builder.toString()
  }

  private fun reasonPhrase(statusCode: Int): String =
      when (statusCode) {
        200 -> "OK"
        201 -> "Created"
        204 -> "No Content"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        409 -> "Conflict"
        413 -> "Payload Too Large"
        429 -> "Too Many Requests"
        500 -> "Internal Server Error"
        503 -> "Service Unavailable"
        else -> "OK"
      }

  private fun readLine(input: InputStream): String? {
    val builder = StringBuilder()
    while (true) {
      val byte = input.read()
      if (byte == -1) {
        return if (builder.isEmpty()) null else builder.toString()
      }
      if (byte == '\n'.code) {
        break
      }
      if (byte != '\r'.code) {
        builder.append(byte.toChar())
      }
    }
    return builder.toString()
  }

  private fun readBody(input: InputStream, length: Int): String {
    if (length == 0) {
      return ""
    }
    val bytes = ByteArray(length)
    var read = 0
    while (read < length) {
      val count = input.read(bytes, read, length - read)
      if (count == -1) {
        break
      }
      read += count
    }
    return String(bytes, 0, read, Charsets.UTF_8)
  }

  /**
   * One socket plus a writer thread. Writes are queued so a slow client never
   * blocks the JS thread while tokens are streaming.
   */
  private class ClientConnection(
      private val socket: Socket,
      private val requestId: String,
      private val bytesOut: AtomicLong,
      private val onAborted: (String) -> Unit,
  ) {
    private val output = BufferedOutputStream(socket.getOutputStream())
    private val queue = LinkedBlockingQueue<ByteArray>()
    private val endMarker = ByteArray(0)
    private val closed = AtomicBoolean(false)
    private val writer =
        Thread(
                {
                  var failed = false
                  try {
                    while (true) {
                      val bytes = queue.take()
                      if (bytes === endMarker) {
                        break
                      }
                      output.write(bytes)
                      output.flush()
                    }
                  } catch (_: Exception) {
                    failed = true
                  } finally {
                    closeQuietly()
                  }
                  if (failed) {
                    onAborted(requestId)
                  }
                },
                "LocalServerWriter")
            .apply {
              isDaemon = true
            }

    fun start() {
      writer.start()
    }

    fun write(bytes: ByteArray) {
      if (!closed.get()) {
        bytesOut.addAndGet(bytes.size.toLong())
        queue.offer(bytes)
      }
    }

    fun finish() {
      if (closed.compareAndSet(false, true)) {
        queue.offer(endMarker)
      }
    }

    fun closeNow() {
      if (closed.compareAndSet(false, true)) {
        queue.offer(endMarker)
      }
      closeQuietly()
    }

    private fun closeQuietly() {
      try {
        socket.close()
      } catch (_: Exception) {
      }
    }
  }

  companion object {
    private const val TAG = "LocalServerModule"
    private const val HEADER_TIMEOUT_MS = 15_000
    private const val MAX_HEADER_BYTES = 64 * 1024
    private const val MAX_BODY_BYTES = 32 * 1024 * 1024

    private var instanceRef: WeakReference<LocalServerModule>? = null

    /** Forwards a notification button tap to JS. Returns false without a module. */
    fun dispatchNotificationAction(action: String): Boolean {
      val module = instanceRef?.get() ?: return false
      module.emitNotificationAction(action)
      return true
    }
  }
}
