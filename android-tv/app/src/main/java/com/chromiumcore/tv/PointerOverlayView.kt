package com.chromiumcore.tv

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View

/**
 * Draws the remote-controlled pointer above the page. It never takes focus or touches, so real
 * touch and mouse input still reaches the WebView underneath it.
 */
class PointerOverlayView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    var pointerX = 0f
        private set
    var pointerY = 0f
        private set

    /** Overall pointer size relative to a standard desktop cursor. TVs are viewed from across a room. */
    var sizeScale = 1.7f

    private val density = resources.displayMetrics.density
    private val arrow = Path()
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
    private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF1B1F24.toInt(); style = Paint.Style.STROKE; strokeWidth = 1.6f; strokeJoin = Paint.Join.ROUND
    }
    private val shadow = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x66000000; style = Paint.Style.FILL }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFED7545.toInt(); style = Paint.Style.STROKE }
    private var pulseProgress = -1f
    private var animator: ValueAnimator? = null

    init {
        isFocusable = false
        isClickable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        arrow.moveTo(0f, 0f)
        arrow.lineTo(0f, 17f)
        arrow.lineTo(4.2f, 13.3f)
        arrow.lineTo(7f, 19.5f)
        arrow.lineTo(9.8f, 18.3f)
        arrow.lineTo(7.1f, 12.3f)
        arrow.lineTo(12.4f, 12.3f)
        arrow.close()
    }

    fun moveTo(x: Float, y: Float) {
        pointerX = x
        pointerY = y
        invalidate()
    }

    /** A short expanding ring that confirms a click. */
    fun pulse() {
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 340
            addUpdateListener {
                pulseProgress = it.animatedValue as Float
                invalidate()
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    pulseProgress = -1f
                    invalidate()
                }
            })
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        val scale = density * sizeScale
        canvas.save()
        canvas.translate(pointerX, pointerY)
        canvas.scale(scale, scale)
        canvas.save()
        canvas.translate(1.4f, 1.8f)
        canvas.drawPath(arrow, shadow)
        canvas.restore()
        canvas.drawPath(arrow, fill)
        canvas.drawPath(arrow, outline)
        canvas.restore()
        if (pulseProgress in 0f..1f) {
            ring.strokeWidth = 3f * density
            ring.alpha = ((1f - pulseProgress) * 255).toInt()
            canvas.drawCircle(pointerX, pointerY, (8f + 26f * pulseProgress) * density * sizeScale, ring)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean = false

    override fun onDetachedFromWindow() {
        animator?.cancel()
        super.onDetachedFromWindow()
    }
}
