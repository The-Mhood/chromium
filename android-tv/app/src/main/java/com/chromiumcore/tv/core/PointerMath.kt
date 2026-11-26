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
    const val BASE_STEP_DP = 7f
    const val MAX_RAMP_REPEATS = 16

    /** Holding a direction key speeds the pointer up gradually, from 1x to about 6.6x. */
    fun step(basePx: Float, repeatCount: Int, speed: Float): Float {
        val repeats = repeatCount.coerceIn(0, MAX_RAMP_REPEATS)
        return basePx * speed * (1f + repeats * 0.35f)
    }

    fun speedFactor(level: Int): Float = when (level) {
        0 -> 0.6f
        2 -> 1.7f
        else -> 1f
    }

    fun scrollSteps(repeatCount: Int): Int = 1 + (repeatCount / 4).coerceIn(0, 3)

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
