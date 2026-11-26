package com.chromiumcore.tv.core

import java.net.URI
import java.net.URLEncoder

/** Turns what the user types into a navigable address, mirroring the web workspace's address bar. */
object UrlInput {
    private val DOMAIN_LIKE = Regex(
        "^(?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3}|(?:[\\w-]+\\.)+[a-zA-Z0-9-]{2,})(?::\\d{1,5})?(?:[/?#]\\S*)?$",
    )

    fun resolve(raw: String, engine: SearchEngine): String? {
        val input = raw.trim()
        if (input.isEmpty()) return null
        val lower = input.lowercase()
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            return if (input.none { it.isWhitespace() } && hasHost(input)) input else search(input, engine)
        }
        if (DOMAIN_LIKE.matches(input)) return "https://$input"
        // Anything else, including javascript:, file:, data: and intent: text, becomes a plain search.
        return search(input, engine)
    }

    fun search(text: String, engine: SearchEngine): String = engine.template + URLEncoder.encode(text, "UTF-8")

    private fun hasHost(url: String): Boolean = try {
        !URI(url).host.isNullOrEmpty()
    } catch (e: Exception) {
        false
    }
}

/** Generic ad-slot hiding and the document-start script that applies it. YouTube has its own shield below. */
object Cosmetics {
    const val GENERIC_CSS = ".ad-banner,.adsbygoogle,ins.adsbygoogle,[data-ad-slot],[id^=\"google_ads_\"],[id^=\"div-gpt-ad\"],.advertisement-container,.sidebar-ad,.promo-banner{display:none!important}"

    /** Returns null when no element hiding should happen. The script is idempotent and skips allowlisted sites. */
    fun script(settings: BrowserSettings): String? {
        if (!settings.protection || !settings.cosmetic) return null
        val allow = settings.allowlist.sorted().joinToString(",", "[", "]") { jsString(it) }
        return buildString {
            append("(function(){try{")
            append("var h=location.hostname.replace(/^www\\./,'').toLowerCase();")
            append("var a=").append(allow).append(";")
            append("for(var i=0;i<a.length;i++){if(h===a[i]||h.endsWith('.'+a[i]))return}")
            append("var c=").append(jsString(GENERIC_CSS)).append(";")
            append("function add(){if(document.querySelector('style[data-chromiumcore]'))return true;")
            append("var r=document.head||document.documentElement;if(!r)return false;")
            append("var s=document.createElement('style');s.setAttribute('data-chromiumcore','1');s.textContent=c;r.appendChild(s);return true}")
            append("if(!add()){var o=new MutationObserver(function(){if(add())o.disconnect()});o.observe(document,{childList:true,subtree:true})}")
            append("}catch(e){}})();")
        }
    }

    /** Quotes a value as a JavaScript string literal that is also safe to embed in HTML. */
    fun jsString(value: String): String {
        val out = StringBuilder("\"")
        for (ch in value) {
            when (ch) {
                '\\' -> out.append("\\\\")
                '"' -> out.append("\\\"")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '<' -> out.append("\\u003c")
                '>' -> out.append("\\u003e")
                '\u2028' -> out.append("\\u2028")
                '\u2029' -> out.append("\\u2029")
                else -> if (ch < ' ') out.append(String.format("\\u%04x", ch.code)) else out.append(ch)
            }
        }
        return out.append('"').toString()
    }
}

/**
 * YouTube ads are scheduled inside the video data itself, so request blocking cannot see them. The shared
 * shield script (shared/youtube-shield.js, also used by the desktop app) removes that data before the player
 * reads it and skips any ad that still starts. This object only prepares the script for injection.
 */
object YoutubeShield {
    const val PLACEHOLDER = "/*__CC_ALLOW__*/[]"
    private val HOSTNAME = Regex("^[a-z0-9.-]+$")

    /** Returns the script for this settings snapshot, or null when YouTube protection is off or the template is unusable. */
    fun script(template: String?, settings: BrowserSettings): String? {
        if (template == null || !template.contains(PLACEHOLDER)) return null
        if (!settings.protection || !settings.youtube) return null
        val allow = settings.allowlist
            .map { it.lowercase() }
            .filter { HOSTNAME.matches(it) }
            .sorted()
            .joinToString(",", "[", "]") { Cosmetics.jsString(it) }
        return template.replace(PLACEHOLDER, allow)
    }
}

object UserAgents {
    private val CHROME_VERSION = Regex("Chrome/([\\d.]+)")

    /**
     * A desktop Chrome user agent built from the WebView's own Chromium version. Desktop layouts
     * suit a TV with a pointer far better than the phone layouts served to an Android user agent.
     */
    fun desktop(defaultUserAgent: String): String {
        val version = CHROME_VERSION.find(defaultUserAgent)?.groupValues?.get(1) ?: "124.0.0.0"
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$version Safari/537.36"
    }
}

object Html {
    fun escape(value: String): String = buildString {
        for (ch in value) {
            when (ch) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '"' -> append("&quot;")
                '\'' -> append("&#39;")
                else -> append(ch)
            }
        }
    }
}
