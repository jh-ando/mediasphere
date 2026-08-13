package com.mediasphere.client.text

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import com.mediasphere.client.sync.TimeSyncManager

/**
 * 전체 폰 그리드를 하나의 배너로 보고, 이 폰이 맡은 부분만 그리는 텍스트 스크롤 뷰.
 *
 * ValueAnimator를 쓰지 않는다 - 여러 폰이 하나로 이어져 보이려면 "지금 이 순간" 배너의
 * 어느 위치를 보여줘야 하는지 전부 똑같이 계산해야 하는데, ValueAnimator는 명령을 받은
 * 시점부터 자체 상대시간으로 돌아서 MQTT 전파 지연만큼 폰마다 어긋난다. 대신 매 프레임
 * (postOnAnimation으로 재귀 예약) TimeSyncManager.now() - startAt으로 절대 위치를
 * 다시 계산한다 - DriftCorrector와 같은 이유/방식.
 *
 * 좌우 스크롤은 내 row 안에서, 상하 스크롤은 전체 그리드(모든 row)에 걸쳐 진행된다.
 * 상하 스크롤은 각 열(col)이 독립적으로 동일한 내용을 보여준다(100대 균일 그리드 전제 -
 * 구체처럼 행마다 폭이 다르면 "같은 열"이 물리적으로 다른 위치를 의미하게 되므로 별도 설계 필요).
 */
class TextScrollView(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    private data class Params(
        val lines: List<String>,
        val paint: Paint,
        val bgColor: Int,
        val align: String,
        val direction: String,
        val speedPxPerSec: Float,
        val rowCounts: List<Int>,
        val totalRows: Int,
        val startAt: Long,
        val myRow: Int,
        val myCol: Int,
    )

    private var params: Params? = null

    private val drawLoop = object : Runnable {
        override fun run() {
            if (params == null) return
            invalidate()
            postOnAnimation(this)
        }
    }

    fun start(
        text: String,
        fontFamily: String,
        fontSize: Int,
        textColor: String,
        bgColor: String,
        align: String,
        direction: String,
        speedPxPerSec: Float,
        rowCounts: List<Int>,
        totalRows: Int,
        startAt: Long,
        myRow: Int,
        myCol: Int,
    ) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.create(fontFamily, Typeface.NORMAL)
            textSize = fontSize.toFloat()
            color = parseColorOrDefault(textColor, Color.WHITE)
        }

        params = Params(
            lines = text.split("\n"),
            paint = paint,
            bgColor = parseColorOrDefault(bgColor, Color.BLACK),
            align = align,
            direction = direction,
            speedPxPerSec = speedPxPerSec,
            rowCounts = rowCounts,
            totalRows = totalRows,
            startAt = startAt,
            // row/col을 못 받은 폰(sphere 등)은 0으로 취급 - 자기 몫 계산이 틀어질 뿐 크래시는 안 남
            myRow = myRow.coerceAtLeast(0),
            myCol = myCol.coerceAtLeast(0),
        )

        removeCallbacks(drawLoop)
        post(drawLoop)
    }

    fun stop() {
        params = null
        removeCallbacks(drawLoop)
    }

    private fun parseColorOrDefault(value: String, default: Int): Int {
        return try {
            Color.parseColor(value)
        } catch (e: IllegalArgumentException) {
            default
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val p = params ?: return
        if (width == 0 || height == 0) return

        canvas.drawColor(p.bgColor)

        val fm = p.paint.fontMetrics
        val lineHeight = fm.descent - fm.ascent
        val blockWidth = p.lines.maxOf { p.paint.measureText(it) }
        val blockHeight = lineHeight * p.lines.size

        val elapsedSec = (TimeSyncManager.now() - p.startAt).coerceAtLeast(0) / 1000f
        val distance = elapsedSec * p.speedPxPerSec

        when (p.direction) {
            "left", "right" -> drawHorizontal(canvas, p, distance, blockWidth, blockHeight, lineHeight, fm.ascent)
            else -> drawVertical(canvas, p, distance, blockHeight, lineHeight, fm.ascent)
        }
    }

    // 내 row 안에서 좌우로 흐른다 - rowCounts[myRow]가 그 row의 전체 폭(폰 대수)을 알려준다.
    private fun drawHorizontal(
        canvas: Canvas,
        p: Params,
        distance: Float,
        blockWidth: Float,
        blockHeight: Float,
        lineHeight: Float,
        ascent: Float,
    ) {
        val myRowCount = p.rowCounts.getOrElse(p.myRow) { 1 }.coerceAtLeast(1)
        val rowWidthPx = myRowCount * width
        val loopLength = blockWidth + rowWidthPx
        val progress = distance % loopLength

        // "left": 오른쪽 끝에서 등장해 왼쪽으로 진행. "right": 왼쪽 끝에서 등장해 오른쪽으로 진행.
        val blockStartX = if (p.direction == "left") rowWidthPx - progress else -blockWidth + progress
        val localX = blockStartX - (p.myCol * width)
        val top = (height - blockHeight) / 2f

        p.lines.forEachIndexed { i, line ->
            val lineWidth = p.paint.measureText(line)
            val alignOffset = when (p.align) {
                "left" -> 0f
                "right" -> blockWidth - lineWidth
                else -> (blockWidth - lineWidth) / 2f
            }
            val baseline = top + i * lineHeight - ascent
            canvas.drawText(line, localX + alignOffset, baseline, p.paint)
        }
    }

    // 전체 그리드(모든 row)에 걸쳐 상하로 흐른다 - 각 열은 독립적으로 동일한 내용을 보여준다.
    private fun drawVertical(canvas: Canvas, p: Params, distance: Float, blockHeight: Float, lineHeight: Float, ascent: Float) {
        val gridHeightPx = p.totalRows.coerceAtLeast(1) * height
        val loopLength = blockHeight + gridHeightPx
        val progress = distance % loopLength

        // "up": 아래에서 등장해 위로 진행. "down": 위에서 등장해 아래로 진행.
        val blockStartY = if (p.direction == "up") gridHeightPx - progress else -blockHeight + progress
        val localY = blockStartY - (p.myRow * height)

        p.lines.forEachIndexed { i, line ->
            val lineWidth = p.paint.measureText(line)
            val alignOffset = when (p.align) {
                "left" -> 0f
                "right" -> width - lineWidth
                else -> (width - lineWidth) / 2f
            }
            val baseline = localY + i * lineHeight - ascent
            canvas.drawText(line, alignOffset, baseline, p.paint)
        }
    }
}
