package app.branchloom.mobile

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // The navigation drawer adds a same-page entry so Back closes it first.
  override val handleBackNavigation: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    applySystemBarStyle()
    super.onCreate(savedInstanceState)
  }

  override fun onResume() {
    super.onResume()
    applySystemBarStyle()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applySystemBarStyle()
  }

  private fun applySystemBarStyle() {
    // The web UI uses a light paper palette, including when Android is in dark mode.
    // SystemBarStyle.light keeps the clock and system icons dark on that background.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.BLACK),
      navigationBarStyle = SystemBarStyle.light(Color.rgb(255, 253, 248), Color.BLACK),
    )
    WindowCompat.getInsetsController(window, window.decorView)
      .show(WindowInsetsCompat.Type.statusBars())
  }
}
