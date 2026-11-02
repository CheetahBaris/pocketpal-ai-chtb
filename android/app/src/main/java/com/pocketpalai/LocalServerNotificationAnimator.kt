package com.pocketpal

import android.app.NotificationManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * Keeps the server notification in sync and animates the mascot while the model
 * is generating.
 *
 * Android cannot animate the status-bar icon, so the motion lives in the large
 * icon: a [Handler] re-posts the same notification with the next mascot frame.
 * JS rewrites the payload about once a second (traffic, token count); when the
 * payload says the model is idle the animation stops on the resting frame.
 *
 * Everything runs on the main thread; [update] hops there when JS calls in from
 * the bridge thread, so the payload and the frame counter never race.
 */
object LocalServerNotificationAnimator {

  private const val TAG = "LocalServer"
  private const val FRAME_DELAY_MS = 160L

  private val handler = Handler(Looper.getMainLooper())
  private var appContext: Context? = null
  private var notifier: LocalServerNotifications? = null
  private var payload: String = ""
  private var frame = 0
  private var animating = false

  private val frameLoop =
      object : Runnable {
        override fun run() {
          if (!animating) {
            return
          }
          frame = (frame + 1) % LocalServerNotifications.FRAME_COUNT
          render()
          handler.postDelayed(this, FRAME_DELAY_MS)
        }
      }

  /** Accepts a new payload and starts/stops the animation to match it. */
  fun update(context: Context, payloadJson: String) {
    val app = context.applicationContext
    handler.post {
      appContext = app
      notifier = LocalServerNotifications(app)
      payload = payloadJson
      if (isGenerating(payloadJson)) {
        if (!animating) {
          animating = true
          frame = 0
          render()
          handler.postDelayed(frameLoop, FRAME_DELAY_MS)
        }
      } else {
        animating = false
        handler.removeCallbacks(frameLoop)
        frame = 0
        render()
      }
    }
  }

  /** Stops the animation without touching the notification. */
  fun stop() {
    handler.post {
      animating = false
      handler.removeCallbacks(frameLoop)
    }
  }

  private fun isGenerating(payloadJson: String): Boolean =
      try {
        JSONObject(payloadJson).optBoolean("generating", false)
      } catch (_: Exception) {
        false
      }

  private fun render() {
    val context = appContext ?: return
    val notifications = notifier ?: return
    if (payload.isEmpty()) {
      return
    }
    try {
      val notification = notifications.build(payload, frame)
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.notify(LocalServerNotifications.NOTIFICATION_ID, notification)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to render the animated notification", e)
    }
  }
}
