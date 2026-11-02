package com.pocketpal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import org.json.JSONObject

/**
 * Builds the ongoing "server is running" notification with two actions.
 *
 * All user-visible labels arrive from JS as JSON, so the notification follows
 * the app language without duplicating strings in resources.
 *
 * The icon is the Pal mascot. The status-bar icon has to be a monochrome
 * silhouette (Android requirement), so it is a static drawable; the large icon
 * uses the colour animation frames, which
 * [LocalServerNotificationAnimator] cycles through while the model generates.
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
    // Called on every animation frame, so skip the binder round-trip when the
    // channel already carries this name.
    if (appliedChannelName == name) {
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
    appliedChannelName = name
  }

  fun build(payloadJson: String, frame: Int = 0): Notification {
    val payload =
        try {
          JSONObject(payloadJson)
        } catch (_: Exception) {
          JSONObject()
        }
    val title = payload.optString("title").ifEmpty { DEFAULT_TITLE }
    val model = payload.optString("model")
    val address = payload.optString("address")
    val status = payload.optString("status")
    val traffic = payload.optString("traffic")
    val resources = payload.optString("resources")
    val bigText = payload.optString("bigText")
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
        .setSmallIcon(R.drawable.ic_stat_pocketpal)
        .setLargeIcon(mascotFrame(frame))
        .setContentTitle(title)
        .setContentText(status.ifEmpty { model })
        .setSubText(if (resources.isNotEmpty()) resources else traffic.ifEmpty { address })
        .setWhen(0)
        .setShowWhen(false)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .setContentIntent(launchIntent)
    if (bigText.isNotEmpty()) {
      builder.setStyle(Notification.BigTextStyle().bigText(bigText))
    }
    if (requests > 0) {
      builder.setNumber(requests)
    }
    builder.addAction(action(stopLabel, ACTION_STOP_SERVER, 1))
    builder.addAction(action(unloadLabel, ACTION_STOP_AND_UNLOAD, 2))
    return builder.build()
  }

  /** One animation frame, decoded once and kept for the process lifetime. */
  private fun mascotFrame(frame: Int): Bitmap? {
    val index = ((frame % FRAME_IDS.size) + FRAME_IDS.size) % FRAME_IDS.size
    return FRAME_CACHE.getOrPut(index) {
      BitmapFactory.decodeResource(context.resources, FRAME_IDS[index])
    }
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
    const val NOTIFICATION_ID = 0x5E7A

    /** Mascot frames used for the animated large icon. */
    val FRAME_IDS =
        intArrayOf(
            R.drawable.ic_mascot_00,
            R.drawable.ic_mascot_01,
            R.drawable.ic_mascot_02,
            R.drawable.ic_mascot_03,
            R.drawable.ic_mascot_04,
            R.drawable.ic_mascot_05,
            R.drawable.ic_mascot_06,
            R.drawable.ic_mascot_07,
            R.drawable.ic_mascot_08,
            R.drawable.ic_mascot_09,
            R.drawable.ic_mascot_10,
            R.drawable.ic_mascot_11,
        )
    const val FRAME_COUNT = 12

    private val FRAME_CACHE = HashMap<Int, Bitmap>()

    /** Last channel name pushed to the system, to avoid per-frame IPC. */
    private var appliedChannelName: String? = null
  }
}
