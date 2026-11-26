package com.chromiumcore.tv.core

enum class BlockType { AD, TRACKER }

/**
 * Domain-level request classifier used from WebView.shouldInterceptRequest.
 *
 * This is deliberately simpler than the desktop Ghostery engine: it matches a request host (and its
 * parent domains) against bundled EasyList/EasyPrivacy domains. It cannot match URL paths, so it
 * cannot remove ads served from the same host as the content, such as most YouTube video ads.
 */
class DomainBlocker(
    ads: Set<String> = BASELINE_ADS,
    trackers: Set<String> = BASELINE_TRACKERS,
) {
    @Volatile private var adDomains: Set<String> = ads
    @Volatile private var trackerDomains: Set<String> = trackers

    val size: Int get() = adDomains.size + trackerDomains.size

    /** Replaces the baseline with downloaded lists. Empty or unreadable lists keep the current rules. */
    fun load(adLines: Iterable<String>, trackerLines: Iterable<String>) {
        val parsedAds = parse(adLines)
        val parsedTrackers = parse(trackerLines)
        if (parsedAds.isNotEmpty()) adDomains = parsedAds + BASELINE_ADS
        if (parsedTrackers.isNotEmpty()) trackerDomains = parsedTrackers + BASELINE_TRACKERS
    }

    /** Returns the category to block, or null to allow. Requests to the page's own site are never blocked. */
    fun classify(requestHost: String?, pageHost: String?): BlockType? {
        val host = normalize(requestHost) ?: return null
        val page = normalize(pageHost)
        if (page != null && registrableDomain(host) == registrableDomain(page)) return null
        if (matches(adDomains, host)) return BlockType.AD
        if (matches(trackerDomains, host)) return BlockType.TRACKER
        return null
    }

    companion object {
        val BASELINE_ADS: Set<String> = setOf(
            "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adnxs.com", "adsrvr.org",
            "advertising.com", "taboola.com", "outbrain.com", "criteo.com", "pubmatic.com",
            "rubiconproject.com", "openx.net", "moatads.com", "amazon-adsystem.com", "adform.net",
            "smartadserver.com",
        )
        val BASELINE_TRACKERS: Set<String> = setOf(
            "google-analytics.com", "scorecardresearch.com", "hotjar.com", "mixpanel.com", "quantserve.com",
            "chartbeat.com", "connect.facebook.net", "pixel.facebook.com", "api.segment.io", "bat.bing.com",
        )

        private val VALID_DOMAIN = Regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")
        private val IPV4 = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
        private val MULTI_PART_SUFFIXES = setOf(
            "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "co.in",
            "com.br", "com.cn", "com.mx", "co.za", "com.tr", "com.sg", "com.hk", "com.tw", "co.kr", "com.ar",
        )

        fun normalize(host: String?): String? {
            val value = host?.trim()?.trimEnd('.')?.lowercase()
            return if (value.isNullOrEmpty()) null else value
        }

        fun parse(lines: Iterable<String>): Set<String> {
            val result = HashSet<String>()
            for (raw in lines) {
                val line = raw.trim().lowercase()
                if (line.isEmpty() || line.startsWith("#") || !line.contains('.') || !VALID_DOMAIN.matches(line)) continue
                result.add(line)
            }
            return result
        }

        /** True when the host, or any parent domain below the top-level domain, is in the set. */
        fun matches(domains: Set<String>, host: String): Boolean {
            var candidate = host
            while (true) {
                if (domains.contains(candidate)) return true
                val dot = candidate.indexOf('.')
                if (dot < 0 || dot == candidate.length - 1) return false
                candidate = candidate.substring(dot + 1)
                if (!candidate.contains('.')) return false
            }
        }

        fun registrableDomain(host: String): String {
            if (IPV4.matches(host) || host.contains(':')) return host
            val labels = host.split('.')
            if (labels.size <= 2) return host
            val lastTwo = labels.takeLast(2).joinToString(".")
            return if (lastTwo in MULTI_PART_SUFFIXES) labels.takeLast(3).joinToString(".") else lastTwo
        }

        fun matchesAllowlist(host: String, allowlist: Set<String>): Boolean {
            val normalized = normalize(host)?.removePrefix("www.") ?: return false
            return allowlist.any { normalized == it || normalized.endsWith(".$it") }
        }
    }
}
