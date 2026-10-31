package com.pocketpal

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat

/**
 * Foreground service that owns the ongoing notification and its actions.
 *
 * The socket itself lives in [LocalServerModule]; this service only keeps the
 * process alive while the server is running and forwards button taps back to
 * JS through [LocalServerModule.dispatchNotificationAction].
 */
class LocalServerService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_SHOW -> {
        payloadJson = intent.getStringExtra(EXTRA_PAYLOAD) ?: payloadJson
        // Must happen within 5 s of startForegroundService, so build it here
        // instead of waiting for another JS round-trip.
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
      @Suppress("DEPRECATION") stopForeground(true)
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
      val intent =
          Intent(context, LocalServerService::class.java)
              .setAction(ACTION_SHOW)
              .putExtra(EXTRA_PAYLOAD, payload)
      ContextCompat.startForegroundService(context, intent)
    }

    fun hide(context: Context) {
      context.stopService(Intent(context, LocalServerService::class.java))
    }
  }
}
