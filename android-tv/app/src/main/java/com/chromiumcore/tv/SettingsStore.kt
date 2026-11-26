package com.chromiumcore.tv

import android.content.Context
import com.chromiumcore.tv.core.BrowserSettings
import com.chromiumcore.tv.core.SearchEngine

data class Totals(val ads: Long, val trackers: Long, val popups: Long) {
    val all: Long get() = ads + trackers + popups
}

/** Persists preferences and lifetime protection counts on the device. Nothing is sent anywhere. */
class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("chromiumcore_tv", Context.MODE_PRIVATE)

    fun load(): BrowserSettings {
        val defaults = BrowserSettings()
        return BrowserSettings(
            protection = prefs.getBoolean("protection", defaults.protection),
            ads = prefs.getBoolean("ads", defaults.ads),
            trackers = prefs.getBoolean("trackers", defaults.trackers),
            cosmetic = prefs.getBoolean("cosmetic", defaults.cosmetic),
            popups = prefs.getBoolean("popups", defaults.popups),
            youtube = prefs.getBoolean("youtube", defaults.youtube),
            pointer = prefs.getBoolean("pointer", defaults.pointer),
            pointerSpeed = prefs.getInt("pointer_speed", defaults.pointerSpeed).coerceIn(0, 2),
            desktopSite = prefs.getBoolean("desktop", defaults.desktopSite),
            textZoom = prefs.getInt("text_zoom", defaults.textZoom),
            engine = SearchEngine.fromId(prefs.getString("engine", null)),
            allowlist = prefs.getStringSet("allowlist", emptySet())?.toSet() ?: emptySet(),
        )
    }

    fun save(settings: BrowserSettings) {
        prefs.edit()
            .putBoolean("protection", settings.protection)
            .putBoolean("ads", settings.ads)
            .putBoolean("trackers", settings.trackers)
            .putBoolean("cosmetic", settings.cosmetic)
            .putBoolean("popups", settings.popups)
            .putBoolean("youtube", settings.youtube)
            .putBoolean("pointer", settings.pointer)
            .putInt("pointer_speed", settings.pointerSpeed)
            .putBoolean("desktop", settings.desktopSite)
            .putInt("text_zoom", settings.textZoom)
            .putString("engine", settings.engine.id)
            .putStringSet("allowlist", HashSet(settings.allowlist))
            .apply()
    }

    fun totals(): Totals = Totals(prefs.getLong("total_ads", 0), prefs.getLong("total_trackers", 0), prefs.getLong("total_popups", 0))

    fun addTotals(ads: Int, trackers: Int, popups: Int) {
        if (ads == 0 && trackers == 0 && popups == 0) return
        val current = totals()
        prefs.edit()
            .putLong("total_ads", current.ads + ads)
            .putLong("total_trackers", current.trackers + trackers)
            .putLong("total_popups", current.popups + popups)
            .apply()
    }

    fun resetTotals() {
        prefs.edit().remove("total_ads").remove("total_trackers").remove("total_popups").apply()
    }
}
