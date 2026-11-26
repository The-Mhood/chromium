package com.chromiumcore.tv.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlInputTest {
    private val google = SearchEngine.GOOGLE

    @Test
    fun keepsWebAddressesAsTyped() {
        assertEquals("https://example.com/a?b=1", UrlInput.resolve("  https://example.com/a?b=1 ", google))
        assertEquals("http://localhost:8080", UrlInput.resolve("http://localhost:8080", google))
    }

    @Test
    fun addsHttpsToBareDomainsAndAddresses() {
        assertEquals("https://example.com", UrlInput.resolve("example.com", google))
        assertEquals("https://sub.example.co.uk/path?q=1", UrlInput.resolve("sub.example.co.uk/path?q=1", google))
        assertEquals("https://localhost:3000", UrlInput.resolve("localhost:3000", google))
        assertEquals("https://192.168.1.10:8080/admin", UrlInput.resolve("192.168.1.10:8080/admin", google))
    }

    @Test
    fun turnsEverythingElseIntoASearch() {
        assertEquals("https://www.google.com/search?q=a+quiet+internet", UrlInput.resolve("a quiet internet", google))
        assertEquals("https://duckduckgo.com/?q=tv+browser", UrlInput.resolve("tv browser", SearchEngine.DUCKDUCKGO))
    }

    @Test
    fun neverNavigatesToPrivilegedSchemes() {
        for (value in listOf("javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "intent://scan/#Intent;end")) {
            val result = UrlInput.resolve(value, google)!!
            assertTrue("$value should be searched, not opened", result.startsWith("https://www.google.com/search?q="))
        }
    }

    @Test
    fun rejectsEmptyInputAndBrokenWebAddresses() {
        assertNull(UrlInput.resolve("   ", google))
        assertTrue(UrlInput.resolve("https://exa mple.com", google)!!.contains("/search?q="))
        assertTrue(UrlInput.resolve("https://", google)!!.contains("/search?q="))
    }
}

class CosmeticsTest {
    @Test
    fun scriptIsOmittedWhenNothingShouldBeHidden() {
        assertNull(Cosmetics.script(BrowserSettings(protection = false)))
        assertNull(Cosmetics.script(BrowserSettings(cosmetic = false)))
    }

    @Test
    fun scriptCarriesTheAllowlistAndRules() {
        val script = Cosmetics.script(BrowserSettings(allowlist = setOf("example.com", "news.org")))
        assertNotNull(script)
        assertTrue(script!!.contains("[\"example.com\",\"news.org\"]"))
        assertTrue(script.contains("adsbygoogle"))
        assertFalse(script.contains("</script"))
    }

    @Test
    fun jsStringEscapesDangerousCharacters() {
        assertEquals("\"a\\\"b\\\\c\\nd\"", Cosmetics.jsString("a\"b\\c\nd"))
        assertEquals("\"\\u003c/script\\u003e\"", Cosmetics.jsString("</script>"))
        assertEquals("\"\\u2028\"", Cosmetics.jsString("\u2028"))
    }
}

class YoutubeShieldTest {
    private val template = "start /*__CC_ALLOW__*/[] end"

    @Test
    fun isOffWhenProtectionOrYoutubeProtectionIsOffOrTheTemplateIsUnusable() {
        assertNull(YoutubeShield.script(template, BrowserSettings(protection = false)))
        assertNull(YoutubeShield.script(template, BrowserSettings(youtube = false)))
        assertNull(YoutubeShield.script(null, BrowserSettings()))
        assertNull(YoutubeShield.script("no placeholder here", BrowserSettings()))
    }

    @Test
    fun embedsTheAllowlistAndDropsInvalidEntries() {
        val script = YoutubeShield.script(template, BrowserSettings(allowlist = setOf("News.org", "example.com", "\";alert(1)//")))!!
        assertEquals("start [\"example.com\",\"news.org\"] end", script)
    }

    @Test
    fun sharedScriptKeepsItsPlaceholderAndCoversTheKnownAdFields() {
        val shared = java.io.File("../../shared/youtube-shield.js")
        assertTrue("shared/youtube-shield.js must be reachable from the Android module", shared.exists())
        val source = shared.readText()
        assertTrue(source.contains(YoutubeShield.PLACEHOLDER))
        for (field in listOf("adPlacements", "adSlots", "playerAds")) assertTrue(source.contains(field))
        val script = YoutubeShield.script(source, BrowserSettings())!!
        assertFalse(script.contains(YoutubeShield.PLACEHOLDER))
    }
}

class UserAgentsTest {
    @Test
    fun desktopAgentKeepsTheWebViewChromiumVersion() {
        val agent = UserAgents.desktop("Mozilla/5.0 (Linux; Android 13; Chromecast) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36")
        assertTrue(agent.contains("Chrome/126.0.6478.71 Safari/537.36"))
        assertFalse(agent.contains("Android"))
        assertFalse(agent.contains("Mobile"))
    }

    @Test
    fun fallsBackWhenTheVersionIsMissing() {
        assertTrue(UserAgents.desktop("unknown").contains("Chrome/124.0.0.0"))
    }
}

class HtmlAndSettingsTest {
    @Test
    fun escapesMarkupInErrorPages() {
        assertEquals("&lt;b&gt;&amp;&quot;&#39;", Html.escape("<b>&\"'"))
    }

    @Test
    fun textZoomCyclesThroughTheAvailableSizes() {
        assertEquals(125, BrowserSettings.nextTextZoom(100))
        assertEquals(100, BrowserSettings.nextTextZoom(175))
        assertEquals(100, BrowserSettings.nextTextZoom(999))
    }

    @Test
    fun searchEnginesCycleAndFallBackToGoogle() {
        assertEquals(SearchEngine.DUCKDUCKGO, SearchEngine.GOOGLE.next())
        assertEquals(SearchEngine.GOOGLE, SearchEngine.BING.next())
        assertEquals(SearchEngine.GOOGLE, SearchEngine.fromId("nonsense"))
    }
}
