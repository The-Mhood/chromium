package com.chromiumcore.tv.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PointerMathTest {
    // A 1000x600 viewport (roughly a 720p TV's web area). At these densities the default
    // first press steps 20px (10dp x 2) and a fully held key caps at 60px.
    private val bounds = PointerBounds(0f, 0f, 1000f, 600f)
    private val firstStep = PointerMath.step(PointerMath.BASE_STEP_DP * 2f, 0, PointerMath.speedFactor(1))

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

    // The D-pad is the page's SCROLL WHEEL (PointerMath.scrollDecision). The cases below use
    // the pointer's first-press step (20px at the test density) — the pointer can reach the
    // very top in one press whenever it is within 20px of it.

    @Test
    fun downScrollsThePageFromAnywhereWhileItCanScrollDown() {
        // Mid-screen, screen quarter, bottom: DOWN scrolls. No travel to an edge needed —
        // this is the "TV doesn't scroll down" fix: from the middle of YouTube, one press
        // scrolls.
        assertEquals(PointerAction.SCROLL_DOWN, PointerMath.scrollDecision(300f, Direction.DOWN, bounds, firstStep, false, true))
        assertEquals(PointerAction.SCROLL_DOWN, PointerMath.scrollDecision(75f, Direction.DOWN, bounds, firstStep, false, true))
        assertEquals(PointerAction.SCROLL_DOWN, PointerMath.scrollDecision(590f, Direction.DOWN, bounds, firstStep, false, true))
    }

    @Test
    fun upScrollsThePageFromAnywhereWhileItCanScrollUp() {
        // The "get back up YouTube" path: held UP anywhere scrolls the page up.
        assertEquals(PointerAction.SCROLL_UP, PointerMath.scrollDecision(300f, Direction.UP, bounds, firstStep, true, true))
        assertEquals(PointerAction.SCROLL_UP, PointerMath.scrollDecision(590f, Direction.UP, bounds, firstStep, true, false))
    }

    @Test
    fun whenThePageCannotScrollTheArrowsMoveThePointer() {
        // At the bottom of the page, DOWN cannot scroll — the press must move the pointer
        // (it is never swallowed); UP still scrolls the page back up.
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(590f, Direction.DOWN, bounds, firstStep, true, false))
        assertEquals(PointerAction.SCROLL_UP, PointerMath.scrollDecision(590f, Direction.UP, bounds, firstStep, true, false))
        // Page at the very top, pointer mid-screen: DOWN moves the pointer into the page,
        // UP pulls the pointer up toward the site header (it stops on any header link,
        // where OK clicks).
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(300f, Direction.DOWN, bounds, firstStep, false, true))
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(300f, Direction.UP, bounds, firstStep, false, true))
        // Pointer 20px below the top — one press reaches it, landing EXACTLY on the top edge
        // (y - step == top): UP must move the pointer there — the site header gets its hover —
        // not jump straight to the toolbar.
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(20f, Direction.UP, bounds, firstStep, false, true))
        // Pointer at the very top of the page with nothing above: the press is aimed at
        // the toolbar (the caller fires it only on a fresh press, not on repeats).
        assertEquals(PointerAction.FOCUS_TOOLBAR, PointerMath.scrollDecision(0f, Direction.UP, bounds, firstStep, false, true))
        assertEquals(PointerAction.FOCUS_TOOLBAR, PointerMath.scrollDecision(10f, Direction.UP, bounds, firstStep, false, false))
        // ...but the toolbar press must NOT fire while the page still has content above,
        // even with the pointer at the top — that press scrolls up instead.
        assertEquals(PointerAction.SCROLL_UP, PointerMath.scrollDecision(0f, Direction.UP, bounds, firstStep, true, false))
        // A tiny page that fits the viewport (cannot scroll either way): arrows are pure
        // pointer movement, with the toolbar reachable from the top.
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(300f, Direction.DOWN, bounds, firstStep, false, false))
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(300f, Direction.UP, bounds, firstStep, false, false))
        assertEquals(PointerAction.FOCUS_TOOLBAR, PointerMath.scrollDecision(0f, Direction.UP, bounds, firstStep, false, false))
    }

    @Test
    fun sidewaysKeysNeverScroll() {
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(590f, Direction.LEFT, bounds, firstStep, true, true))
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(0f, Direction.RIGHT, bounds, firstStep, false, false))
    }

    @Test
    fun anUnlaidOutAreaCannotBePushedIntoTheToolbar() {
        // Before the WebView has its first layout, pointerBounds() returns an inverted area
        // (right < left, bottom < top). The "pointer at the very top" test must not fire on
        // such an area, so an early press moves the pointer (which clamps) instead of jumping
        // to the toolbar.
        val inverted = PointerBounds(0f, 0f, -1f, -1f)
        assertEquals(PointerAction.MOVE_POINTER, PointerMath.scrollDecision(0f, Direction.UP, inverted, firstStep, false, false))
        // And on a laid-out page the same press at the top of the page aims at the toolbar.
        assertEquals(PointerAction.FOCUS_TOOLBAR, PointerMath.scrollDecision(0f, Direction.UP, bounds, firstStep, false, false))
    }

    @Test
    fun clampingSurvivesAnEmptyOrInvertedArea() {
        val empty = PointerBounds(10f, 10f, 0f, 0f)
        assertEquals(10f, empty.clampX(500f), 0.001f)
        assertEquals(10f, empty.clampY(-50f), 0.001f)
    }
}
