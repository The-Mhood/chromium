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
    }

    @Test
    fun speedSettingsAreOrdered() {
        assertTrue(PointerMath.speedFactor(0) < PointerMath.speedFactor(1))
        assertTrue(PointerMath.speedFactor(1) < PointerMath.speedFactor(2))
        assertEquals(PointerMath.speedFactor(1), PointerMath.speedFactor(99), 0.001f)
    }

    @Test
    fun scrollStepsGrowWithRepeatsButStayBounded() {
        assertEquals(1, PointerMath.scrollSteps(0))
        assertTrue(PointerMath.scrollSteps(8) > PointerMath.scrollSteps(0))
        assertEquals(4, PointerMath.scrollSteps(400))
    }

    @Test
    fun clampingSurvivesAnEmptyOrInvertedArea() {
        val empty = PointerBounds(10f, 10f, 0f, 0f)
        assertEquals(10f, empty.clampX(500f), 0.001f)
        assertEquals(10f, empty.clampY(-50f), 0.001f)
    }
}
