package com.pocketpal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/**
 * Builds the ongoing "server is running" notification with two actions.
 *
 * All user-visible labels arrive from JS as JSON, so the notification follows
 * the app language without duplicating strings in resources.
 */
class LocalServerNotifications(private val context: Context) {

  private val launchIntent: PendingIntent? =
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE)
      }

  private fun ensureChannel(name: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = context.getSystemService(NotificationManager::class.java)
    val existing = manager.getNotificationChannel(CHANNEL_ID)
    if (existing == null) {
      manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW))
    } else if (existing.name != name) {
      // The channel name is user-visible; keep it in sync with the language.
      existing.name = name
      manager.createNotificationChannel(existing)
    }
  }

  fun build(payloadJson: String): Notification {
    val payload =
        try {
          JSONObject(payloadJson)
        } catch (_: Exception) {
          JSONObject()
        }
    val title = payload.optString("title").ifEmpty { DEFAULT_TITLE }
    val model = payload.optString("model")
    val address = payload.optString("address")
    val requests = payload.optInt("requests", 0)
    val channelName =
        payload.optString("channelName").ifEmpty { DEFAULT_CHANNEL_NAME }
    val stopLabel = payload.optString("stopLabel").ifEmpty { DEFAULT_STOP }
    val unloadLabel = payload.optString("unloadLabel").ifEmpty { DEFAULT_UNLOAD }
    ensureChannel(channelName)

    val builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Notification.Builder(context, CHANNEL_ID)
        } else {
          @Suppress("DEPRECATION") Notification.Builder(context)
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
    if (requests > 0) {
      builder.setNumber(requests)
    }
    builder.addAction(action(stopLabel, ACTION_STOP_SERVER, 1))
    builder.addAction(action(unloadLabel, ACTION_STOP_AND_UNLOAD, 2))
    return builder.build()
  }

  private fun action(label: String, action: String, code: Int): Notification.Action {
    val intent = Intent(context, LocalServerService::class.java).setAction(action)
    val pending =
        PendingIntent.getService(
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
