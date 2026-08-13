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
 * 전체 그리드(모든 row x col)를 하나의 큰 캔버스로 보고, 텍스트 블록을 그 위에 "한 번만"
 * 배치한 뒤 각 폰이 자기 row/col 오프셋만큼 잘라서 보여준다 - 행마다 반복해서 그리는 게
 * 아니라, 여러 폰에 걸쳐 하나로 이어진 한 덩어리가 흐르는 것처럼 보이게 하기 위함이다.
 * (100대 균일 그리드 전제 - 구체처럼 행마다 폭이 다르면 "같은 열"이 물리적으로 다른 위치를
 * 의미하게 되므로 별도 설계 필요).
 *
 * gapRatioX/gapRatioY: 폰 화면(width/height)은 실제 물리적 간격(피치)보다 작다 -
 * 베젤+거치대 때문에 폰 사이에 화면이 아닌 빈 공간이 있다(gen_tiles.py --pitch 실측
 * 기준 현재 가로 37%, 세로 25% 정도). 이 비율만큼 폰 폭/높이를 늘려 잡은 값("pitch")을
 * 폰 1대의 실제 간격으로 써야 그리드를 가로지르는 글자가 압축되지 않고 실제 간격만큼
 * 벌어져 보인다. 0이면 기존처럼 폰이 빈틈없이 붙어있는 것으로 취급(구체 등 미지원 레이아웃).
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
        val gapRatioX: Double,
        val gapRatioY: Double,
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
        gapRatioX: Double = 0.0,
        gapRatioY: Double = 0.0,
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
            // 0.9 상한 - 혹시 잘못된 값이 와도 pitch가 폭발적으로 커지는 걸 막는 안전장치
            gapRatioX = gapRatioX.coerceIn(0.0, 0.9),
            gapRatioY = gapRatioY.coerceIn(0.0, 0.9),
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

        // 폰 화면(width/height)이 아니라 폰 간 실제 간격(pitch)을 그리드의 한 칸으로 쓴다 -
        // gapRatio만큼 화면보다 넓게 잡아야 폰 사이 베젤/거치대 여백이 반영된다.
        val pitchW = width / (1.0 - p.gapRatioX).toFloat()
        val pitchH = height / (1.0 - p.gapRatioY).toFloat()

        // 그리드 전체를 하나의 캔버스로 본다 - 열 수는 rowCounts 중 가장 넓은 행 기준
        // (100대 균일 그리드는 전부 같은 값이라 문제 없음, 구체는 범위 밖).
        val gridCols = (p.rowCounts.maxOrNull() ?: 1).coerceAtLeast(1)
        val gridWidthPx = gridCols * pitchW
        val gridHeightPx = p.totalRows.coerceAtLeast(1) * pitchH

        val elapsedSec = (TimeSyncManager.now() - p.startAt).coerceAtLeast(0) / 1000f
        val distance = elapsedSec * p.speedPxPerSec

        // 스크롤 축은 흐르고, 반대 축은 캔버스 전체 기준으로 가운데 고정된다.
        val originX: Float
        val originY: Float
        if (p.direction == "left" || p.direction == "right") {
            val loopLength = blockWidth + gridWidthPx
            val progress = distance % loopLength
            // "left": 오른쪽 끝에서 등장해 왼쪽으로 진행. "right": 왼쪽 끝에서 등장해 오른쪽으로 진행.
            originX = if (p.direction == "left") gridWidthPx - progress else -blockWidth + progress
            originY = (gridHeightPx - blockHeight) / 2f
        } else {
            val loopLength = blockHeight + gridHeightPx
            val progress = distance % loopLength
            // "up": 아래에서 등장해 위로 진행. "down": 위에서 등장해 아래로 진행.
            originY = if (p.direction == "up") gridHeightPx - progress else -blockHeight + progress
            originX = (gridWidthPx - blockWidth) / 2f
        }

        // 캔버스 좌표에서 내 폰의 row/col 오프셋(pitch 기준)만큼 빼면, 캔버스 중 내가
        // 맡은 조각만 화면 안에 들어오고 나머지는 Canvas가 알아서 잘라낸다. 내 화면은
        // 자기 pitch 칸 안에서 가운데 정렬돼 있다고 본다(gen_tiles.py가 crop을 pitch
        // 칸 중앙에 놓는 것과 동일한 규칙) - 그래서 (pitch - 화면크기)/2 만큼 더 뺀다.
        val localOriginX = originX - (p.myCol * pitchW) - (pitchW - width) / 2f
        val localOriginY = originY - (p.myRow * pitchH) - (pitchH - height) / 2f

        p.lines.forEachIndexed { i, line ->
            val lineWidth = p.paint.measureText(line)
            val alignOffset = when (p.align) {
                "left" -> 0f
                "right" -> blockWidth - lineWidth
                else -> (blockWidth - lineWidth) / 2f
            }
            val baseline = localOriginY + i * lineHeight - fm.ascent
            canvas.drawText(line, localOriginX + alignOffset, baseline, p.paint)
        }
    }
}
