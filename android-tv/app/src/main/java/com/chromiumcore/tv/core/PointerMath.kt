package com.chromiumcore.tv.core

import kotlin.math.max

enum class Direction { UP, DOWN, LEFT, RIGHT }

enum class Edge { NONE, TOP, BOTTOM, LEFT, RIGHT }

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
    /** Width of the top/bottom band where arrow presses scroll the page instead of moving the
     *  pointer. Without a band, scrolling only started at the very edge — half a screen away on
     *  a TV — which made long pages (YouTube first of all) feel impossible to scroll. */
    const val SCROLL_ZONE_DP = 48f
    /** Lines of scroll per press at the edge band. Deliberately CONSTANT: the OS repeats a held
     *  key faster and faster, so a per-press amount that grew with repeat count made the page
     *  crawl at first and then zoom out of control. One line per press = steady speed. */
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

    /** True when the pointer sits inside the scroll band on the side being pressed, so scrolling
     *  starts before the pointer has to travel all the way to the edge. LEFT/RIGHT never scroll
     *  (horizontal pages are rare on a TV, and sideways pointer travel must stay pointer travel). */
    fun inScrollBand(x: Float, y: Float, direction: Direction, bounds: PointerBounds, zonePx: Float): Boolean = when (direction) {
        Direction.DOWN -> bounds.bottom >= bounds.top && y >= bounds.bottom - zonePx
        Direction.UP -> bounds.bottom >= bounds.top && y <= bounds.top + zonePx
        Direction.LEFT, Direction.RIGHT -> false
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
