package com.chromiumcore.tv.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DomainBlockerTest {
    private val blocker = DomainBlocker()

    @Test
    fun blocksKnownAdHostsAndTheirSubdomains() {
        assertEquals(BlockType.AD, blocker.classify("doubleclick.net", "example.com"))
        assertEquals(BlockType.AD, blocker.classify("ads.g.doubleclick.net", "example.com"))
    }

    @Test
    fun classifiesTrackersSeparately() {
        assertEquals(BlockType.TRACKER, blocker.classify("www.google-analytics.com", "example.com"))
    }

    @Test
    fun neverBlocksLookalikeHosts() {
        assertNull(blocker.classify("notdoubleclick.net", "example.com"))
        assertNull(blocker.classify("doubleclick.net.example.org", "example.com"))
        assertNull(blocker.classify("net", "example.com"))
    }

    @Test
    fun neverBlocksTheVisitedSiteItself() {
        assertNull(blocker.classify("doubleclick.net", "doubleclick.net"))
        assertNull(blocker.classify("static.doubleclick.net", "www.doubleclick.net"))
    }

    @Test
    fun ignoresMissingHosts() {
        assertNull(blocker.classify(null, "example.com"))
        assertNull(blocker.classify("", "example.com"))
    }

    @Test
    fun loadedListsIgnoreCommentsAndInvalidLines() {
        val custom = DomainBlocker()
        custom.load(
            listOf("# comment", "", "Ads.Example.com", "not a domain", "bad_domain.com?", "nodot"),
            listOf("t.example.org"),
        )
        assertEquals(BlockType.AD, custom.classify("x.ads.example.com", "site.org"))
        assertEquals(BlockType.TRACKER, custom.classify("t.example.org", "site.org"))
        assertNull(custom.classify("nodot", "site.org"))
        assertEquals("baseline rules remain after loading", BlockType.AD, custom.classify("doubleclick.net", "site.org"))
    }

    @Test
    fun emptyListsKeepTheCurrentRules() {
        val custom = DomainBlocker()
        custom.load(emptyList(), emptyList())
        assertEquals(BlockType.AD, custom.classify("doubleclick.net", "site.org"))
    }

    @Test
    fun registrableDomainsHandleCommonSuffixes() {
        assertEquals("example.co.uk", DomainBlocker.registrableDomain("shop.example.co.uk"))
        assertEquals("example.com", DomainBlocker.registrableDomain("a.b.example.com"))
        assertEquals("example.com", DomainBlocker.registrableDomain("example.com"))
        assertEquals("192.168.1.5", DomainBlocker.registrableDomain("192.168.1.5"))
    }

    @Test
    fun allowlistMatchesSubdomainsButNotLookalikes() {
        val allow = setOf("example.com")
        assertTrue(DomainBlocker.matchesAllowlist("www.news.example.com", allow))
        assertTrue(DomainBlocker.matchesAllowlist("example.com", allow))
        assertFalse(DomainBlocker.matchesAllowlist("badexample.com", allow))
        assertFalse(DomainBlocker.matchesAllowlist("example.com.evil.net", allow))
    }
}
