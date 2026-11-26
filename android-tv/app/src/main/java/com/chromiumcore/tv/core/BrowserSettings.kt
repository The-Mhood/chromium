package com.chromiumcore.tv.core

enum class SearchEngine(val id: String, val label: String, val template: String) {
    GOOGLE("google", "Google", "https://www.google.com/search?q="),
    DUCKDUCKGO("duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q="),
    BING("bing", "Bing", "https://www.bing.com/search?q=");

    fun next(): SearchEngine = values()[(ordinal + 1) % values().size]

    companion object {
        fun fromId(id: String?): SearchEngine = values().firstOrNull { it.id == id } ?: GOOGLE
    }
}

/** Every user-adjustable option. Immutable so it can be read safely from WebView's request threads. */
data class BrowserSettings(
    val protection: Boolean = true,
    val ads: Boolean = true,
    val trackers: Boolean = true,
    val cosmetic: Boolean = true,
    val popups: Boolean = true,
    val youtube: Boolean = true,
    val pointer: Boolean = true,
    val pointerSpeed: Int = 1,
    val desktopSite: Boolean = true,
    val textZoom: Int = 125,
    val engine: SearchEngine = SearchEngine.GOOGLE,
    val allowlist: Set<String> = emptySet(),
) {
    fun isAllowlisted(host: String?): Boolean = host != null && DomainBlocker.matchesAllowlist(host, allowlist)

    companion object {
        val TEXT_ZOOMS = listOf(100, 125, 150, 175)

        fun nextTextZoom(current: Int): Int {
            val index = TEXT_ZOOMS.indexOf(current)
            return TEXT_ZOOMS[(index + 1) % TEXT_ZOOMS.size]
        }
    }
}
