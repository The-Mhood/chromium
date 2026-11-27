package com.chromiumcore.tv.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PointerMathTest {
    private val bounds = PointerBounds(0f, 0f, 1000f, 600f)

    @Test
    fun movesInTheRequestedDirection() {
        val move = PointerMath.move(500f, 300f, Direction.RIGHT, 20f, bounds)
        assertEquals(520f, move.x, 0.001f)
        assertEquals(300f, move.y, 0.001f)
        assertEquals(Edge.NONE, move.edge)
    }

    @Test
    fun clampsAtTheBottomEdgeAndReportsOverflow() {
        val move = PointerMath.move(500f, 590f, Direction.DOWN, 30f, bounds)
        assertEquals(600f, move.y, 0.001f)
        assertEquals(Edge.BOTTOM, move.edge)
        assertEquals(20f, move.overflow, 0.001f)
        assertFalse("arriving at an edge is not pushing against it", move.wasAtEdge)
    }

    @Test
    fun detectsPushingAgainstTheTopEdge() {
        val move = PointerMath.move(500f, 0f, Direction.UP, 10f, bounds)
        assertEquals(Edge.TOP, move.edge)
        assertTrue(move.wasAtEdge)
        assertEquals(0f, move.y, 0.001f)
    }

    @Test
    fun horizontalEdgesAreReportedToo() {
        assertEquals(Edge.LEFT, PointerMath.move(5f, 100f, Direction.LEFT, 30f, bounds).edge)
        assertEquals(Edge.RIGHT, PointerMath.move(995f, 100f, Direction.RIGHT, 30f, bounds).edge)
    }

    @Test
    fun holdingAKeyAcceleratesUpToAFixedCap() {
        val first = PointerMath.step(10f, 0, 1f)
        val held = PointerMath.step(10f, 8, 1f)
        val capped = PointerMath.step(10f, PointerMath.MAX_RAMP_REPEATS, 1f)
        assertTrue(held > first)
        assertEquals(capped, PointerMath.step(10f, 500, 1f), 0.001f)
        assertEquals(10f, first, 0.001f)
        // The cap is 3x the base step: a held key gains momentum but never zooms
        // across the screen (the old ramp reached about 6.6x).
        assertEquals(30f, capped, 0.001f)
    }

    @Test
    fun theDefaultStepStartsNormalAndHeldCapsAtThreeTimes() {
        // 10dp base at density 2, speed level 1 (Normal): one press moves 20px,
        // a held key tops out at 60px/press.
        val base = PointerMath.step(PointerMath.BASE_STEP_DP * 2f, 0, PointerMath.speedFactor(1))
        assertEquals(20f, base, 0.001f)
        val held = PointerMath.step(PointerMath.BASE_STEP_DP * 2f, PointerMath.MAX_RAMP_REPEATS, PointerMath.speedFactor(1))
        assertEquals(60f, held, 0.001f)
    }

    @Test
    fun speedSettingsAreOrdered() {
        assertTrue(PointerMath.speedFactor(0) < PointerMath.speedFactor(1))
        assertTrue(PointerMath.speedFactor(1) < PointerMath.speedFactor(2))
        assertEquals(PointerMath.speedFactor(1), PointerMath.speedFactor(99), 0.001f)
    }

    @Test
    fun edgeScrollIsConstantSoAHeldKeyNeverAcceleratesOutOfControl() {
        // The OS repeats a held key faster and faster; if the per-press scroll
        // amount also grew with the repeat count, the page first crawled and
        // then zoomed. One line per press keeps the speed steady.
        assertEquals(1, PointerMath.EDGE_SCROLL_LINES)
    }

    @Test
    fun theScrollBandStartsBeforeTheEdge() {
        val zone = 48f
        // Bottom band: the band starts 48px above the bottom (600 - 48 = 552).
        assertTrue(PointerMath.inScrollBand(500f, 560f, Direction.DOWN, bounds, zone))
        assertTrue(PointerMath.inScrollBand(500f, 552f, Direction.DOWN, bounds, zone))
        assertFalse(PointerMath.inScrollBand(500f, 551f, Direction.DOWN, bounds, zone))
        // Top band: it ends 48px below the top (48).
        assertTrue(PointerMath.inScrollBand(500f, 40f, Direction.UP, bounds, zone))
        assertTrue(PointerMath.inScrollBand(500f, 0f, Direction.UP, bounds, zone))
        assertFalse(PointerMath.inScrollBand(500f, 49f, Direction.UP, bounds, zone))
        // Mid-screen is never in a band, and sideways keys never scroll.
        assertFalse(PointerMath.inScrollBand(500f, 300f, Direction.DOWN, bounds, zone))
        assertFalse(PointerMath.inScrollBand(500f, 300f, Direction.UP, bounds, zone))
        assertFalse(PointerMath.inScrollBand(40f, 300f, Direction.LEFT, bounds, zone))
        assertFalse(PointerMath.inScrollBand(960f, 300f, Direction.RIGHT, bounds, zone))
    }

    @Test
    fun clampingSurvivesAnEmptyOrInvertedArea() {
        val empty = PointerBounds(10f, 10f, 0f, 0f)
        assertEquals(10f, empty.clampX(500f), 0.001f)
        assertEquals(10f, empty.clampY(-50f), 0.001f)
    }
}
