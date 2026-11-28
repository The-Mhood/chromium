package com.chromiumcore.tv.core

import kotlin.math.max

enum class Direction { UP, DOWN, LEFT, RIGHT }

enum class Edge { NONE, TOP, BOTTOM, LEFT, RIGHT }

/** What one direction-key press should do at the pointer's current position. */
enum class PointerAction { MOVE_POINTER, SCROLL_UP, SCROLL_DOWN, FOCUS_TOOLBAR }

/** The rectangle, in overlay coordinates, that the pointer may move inside. */
data class PointerBounds(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    fun clampX(value: Float): Float = value.coerceIn(left, max(left, right))
    fun clampY(value: Float): Float = value.coerceIn(top, max(top, bottom))
}

/**
 * Result of one D-pad press. [overflow] is how far the pointer tried to travel past [edge], and
 * [wasAtEdge] tells whether it was already resting on that edge before the press.
 */
data class PointerMove(val x: Float, val y: Float, val edge: Edge, val overflow: Float, val wasAtEdge: Boolean)

/** Pure pointer movement rules, kept free of Android types so they can be unit-tested on the JVM. */
object PointerMath {
    /** One press of a direction key. 10dp is comfortably "normal" on a TV screen; the old
     *  7dp felt like crawling before the ramp kicked in. */
    const val BASE_STEP_DP = 10f
    const val MAX_RAMP_REPEATS = 12
    const val MAX_RAMP_FACTOR = 3.0f
    /** Lines of scroll per press. Deliberately CONSTANT: the OS repeats a held key faster and
     *  faster, so a per-press amount that grew with the repeat count made the page crawl at
     *  first and then zoom out of control. One line per press = steady speed. */
    const val EDGE_SCROLL_LINES = 1

    /** Holding a direction key speeds the pointer up gradually, from 1x to a capped 3x. The cap
     *  (old: about 6.6x) keeps a held key from zooming across the screen — the ramp should feel
     *  like momentum, not a launch. */
    fun step(basePx: Float, repeatCount: Int, speed: Float): Float {
        val repeats = repeatCount.coerceIn(0, MAX_RAMP_REPEATS)
        val ramp = (1f + repeats * 0.18f).coerceAtMost(MAX_RAMP_FACTOR)
        return basePx * speed * ramp
    }

    fun speedFactor(level: Int): Float = when (level) {
        0 -> 0.6f
        2 -> 1.7f
        else -> 1f
    }

    /**
     * Decide what ONE direction-key press does at the pointer's position.
     *
     * The D-pad is the page's SCROLL WHEEL first: UP/DOWN scroll the page from ANYWHERE on
     * screen while the page can scroll that way, and the pointer stays where it is — exactly
     * like a mouse wheel. (The previous model required the pointer to travel into a top/bottom
     * quarter of the screen before scrolling began: from the middle of a TV that was a quarter
     * screen of arrow presses, and in the top quarter UP scrolled instead of moving, so the
     * pointer could never reach a site's header. "Couldn't scroll down", "can't get to the
     * header", "can't even reach YouTube".)
     *
     * When the page CANNOT scroll in the pressed direction, the key moves the pointer instead,
     * so at the top of a page UP pulls the pointer up into the site header (stopping on any
     * header link, where OK clicks). With the pointer at the very top of the page, the press is
     * aimed at the browser toolbar instead — the caller fires that only on a fresh press, not
     * on repeats. LEFT/RIGHT always move the pointer (horizontal pages are rare on a TV).
     */
    fun scrollDecision(
        y: Float,
        direction: Direction,
        bounds: PointerBounds,
        stepPx: Float,
        canScrollUp: Boolean,
        canScrollDown: Boolean
    ): PointerAction {
        return when (direction) {
            Direction.DOWN -> if (canScrollDown) PointerAction.SCROLL_DOWN else PointerAction.MOVE_POINTER
            Direction.UP -> when {
                canScrollUp -> PointerAction.SCROLL_UP
                // Page at the top: if the pointer can still climb the page, let it reach the
                // site header; only when it is at the very top does the press aim at the
                // toolbar. (The bounds guard keeps a not-yet-laid-out, empty area benign.)
                bounds.bottom >= bounds.top && y - stepPx <= bounds.top -> PointerAction.FOCUS_TOOLBAR
                else -> PointerAction.MOVE_POINTER
            }
            Direction.LEFT, Direction.RIGHT -> PointerAction.MOVE_POINTER
        }
    }

    fun move(x: Float, y: Float, direction: Direction, step: Float, bounds: PointerBounds): PointerMove {
        val wasAtEdge = when (direction) {
            Direction.UP -> y <= bounds.top
            Direction.DOWN -> y >= bounds.bottom
            Direction.LEFT -> x <= bounds.left
            Direction.RIGHT -> x >= bounds.right
        }
        var nx = x
        var ny = y
        when (direction) {
            Direction.UP -> ny -= step
            Direction.DOWN -> ny += step
            Direction.LEFT -> nx -= step
            Direction.RIGHT -> nx += step
        }
        var edge = Edge.NONE
        var overflow = 0f
        when {
            ny < bounds.top -> { edge = Edge.TOP; overflow = bounds.top - ny }
            ny > bounds.bottom -> { edge = Edge.BOTTOM; overflow = ny - bounds.bottom }
            nx < bounds.left -> { edge = Edge.LEFT; overflow = bounds.left - nx }
            nx > bounds.right -> { edge = Edge.RIGHT; overflow = nx - bounds.right }
        }
        return PointerMove(bounds.clampX(nx), bounds.clampY(ny), edge, overflow, wasAtEdge)
    }
}
