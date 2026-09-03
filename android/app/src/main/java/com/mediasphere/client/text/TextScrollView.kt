package com.mediasphere.client.text

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import com.mediasphere.client.sync.TimeSyncManager
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * 전체 폰 그리드를 하나의 배너로 보고, 이 폰이 맡은 부분만 그리는 텍스트 스크롤 뷰.
 *
 * ValueAnimator를 쓰지 않는다 - 여러 폰이 하나로 이어져 보이려면 "지금 이 순간" 배너의
 * 어느 위치를 보여줘야 하는지 전부 똑같이 계산해야 하는데, ValueAnimator는 명령을 받은
 * 시점부터 자체 상대시간으로 돌아서 MQTT 전파 지연만큼 폰마다 어긋난다. 대신 매 프레임
 * (postOnAnimation으로 재귀 예약) TimeSyncManager.now() - startAt으로 절대 위치를
 * 다시 계산한다 - DriftCorrector와 같은 이유/방식.
 *
 * 단, TimeSyncManager.now()를 매 프레임 그대로 쓰지 않고 smoothedOffsetMs로 완충한다.
 * TimeSyncManager는 1분마다 백그라운드에서 재동기화하며 offsetMs를 갱신하는데:
 *   - 처음엔(구현 v1) 이 값을 매 프레임 그대로 읽었더니, 재동기화 순간 offsetMs가 조금만
 *     바뀌어도 위치가 즉시 픽셀 단위로 점프했다(네트워크 RTT가 불안정한 폰일수록 크게 튐).
 *   - 그다음(구현 v2) start() 시점의 offsetMs를 한 번 캡처해 세션 내내 고정값으로 썼더니,
 *     점프는 없어졌지만 그 폰의 하드웨어 시계 자체가 다른 폰보다 빠르게/느리게 도는 경우
 *     (오차가 분당 1ms 미만일 거라 가정했던 게 실제로는 틀렸음 - 실기기 편차가 더 컸다)
 *     보정을 아예 못 받아서 세션이 길어질수록 계속 앞서가거나 뒤처지는 문제가 생겼다.
 * 그래서 DriftCorrector(영상)가 쓰는 것과 같은 원리로 절충한다 - 실시간 offsetMs를 목표값
 * 삼아 매 프레임 조금씩(최대 MAX_OFFSET_CATCHUP_RATIO 비율로) 쫓아가고, 그 폭을 벗어나는
 * 큰 변화(OFFSET_SNAP_THRESHOLD_MS 초과 - 수동 시각 변경 등)만 즉시 반영한다. 재동기화로
 * 인한 순간 점프도 없고, 하드웨어 시계 편차로 인한 지속적 어긋남도 계속 보정된다.
 *
 * 전체 그리드를 하나의 큰 캔버스로 보고, 텍스트 블록을 그 위에 "한 번만" 배치한 뒤 각 폰이
 * 자기 몫만 잘라서 보여준다 - 행마다 반복해서 그리는 게 아니라, 여러 폰에 걸쳐 하나로 이어진
 * 한 덩어리가 흐르는 것처럼 보이게 하기 위함이다.
 *
 * 가로 위치 계산은 flat/sphere가 서로 달라 config의 lon 유무로 분기한다(myLon이 null이면
 * flat, 값이 있으면 sphere):
 *   - flat: myCol(열 인덱스) / gridCols(행 최대 열 수) - 100대처럼 모든 행의 대수가 같은
 *     균일 격자를 전제로 한다.
 *   - sphere: myLon(경도, 0~360도) / 360도 - 439대는 위도별로 9~50대까지 행마다 대수가
 *     달라서 "열 인덱스"라는 개념 자체가 성립하지 않는다(20대짜리 행의 5번째와 50대짜리
 *     행의 5번째는 실제 각도가 전혀 다름). 대신 연속된 경도 비율을 쓰면 행 대수와
 *     무관하게 항상 같은 각도 기준으로 정렬된다. 세로(위도/row)는 439대 배치가 위도
 *     간격 12.857도로 균일해서 flat과 같은 방식(myRow/totalRows)을 그대로 쓴다.
 *
 * gapRatioX/gapRatioY: 폰 화면(width/height)은 실제 물리적 간격(피치)보다 작다 -
 * 베젤+거치대 때문에 폰 사이에 화면이 아닌 빈 공간이 있다(gen_tiles.py --pitch 실측
 * 기준 현재 가로 37%, 세로 25% 정도). 이 비율만큼 폰 폭/높이를 늘려 잡은 값("pitch")을
 * 폰 1대의 실제 간격으로 써야 그리드를 가로지르는 글자가 압축되지 않고 실제 간격만큼
 * 벌어져 보인다. 0이면 기존처럼 폰이 빈틈없이 붙어있는 것으로 취급(구체 등 미지원 레이아웃).
 */
class TextScrollView(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    companion object {
        // 1프레임에 최대 이만큼 비율(실제 경과 시간 대비)까지만 목표 offset을 쫓아간다 -
        // DriftCorrector의 최대 속도 보정폭(±5%)과 같은 값.
        private const val MAX_OFFSET_CATCHUP_RATIO = 0.05
        // 이 값을 넘는 offset 변화(수동 시각 변경 등 드문 경우)는 서서히 쫓아가지 않고 즉시 반영한다.
        private const val OFFSET_SNAP_THRESHOLD_MS = 500L

        // Paint.textSize를 이 값보다 크게 직접 주지 않는다 - fontSize를 수만 px(예: 25000)로
        // 직접 넣으면 Skia가 내부적으로 글리프 위치를 계산할 때 좌표 정밀도 한계를 넘어서
        // 뒤쪽 글자일수록 위치가 어긋나거나 아예 안 그려지는 문제가 실기기에서 확인됐다
        // ("ANDO" 4글자 중 앞의 두 글자만 정상, 나머지는 깨짐 - fontSize=25000일 때).
        // 실제 텍스트 크기는 Paint 자체가 아니라 onDraw()에서 canvas.scale()로 키운다 -
        // 텍스트는 폰트 파일의 벡터 윤곽선을 매 프레임 다시 그리는 방식이라(비트맵이 아님)
        // scale로 키워도 화질 손실이 없다. Paint.measureText로 재는 폭/높이는 이 작은
        // 크기 기준이라 renderScale을 곱해야 실제(world) 크기가 나온다.
        private const val SAFE_TEXT_SIZE_PX = 300f
    }

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
        val myLon: Double?,
        val gapRatioX: Double,
        val gapRatioY: Double,
        val refGapRatioX: Double,
        val centerRow: Int?,
        // fontSize가 SAFE_TEXT_SIZE_PX보다 크면 1.0보다 커진다 - onDraw()가 이 배율만큼
        // Paint의 측정값(폭/높이)과 canvas.scale()을 같이 키워서 실제 fontSize와 맞춘다.
        val renderScale: Float,
    )

    private var params: Params? = null

    // TimeSyncManager.now()를 매 프레임 완충 없이 그대로 쓰지 않기 위한 상태 - start()마다
    // 초기화되고, onDraw()가 매 프레임 조금씩 목표(실시간 offsetMs)로 쫓아가며 갱신한다.
    private var smoothedOffsetMs: Double = 0.0
    private var lastFrameRealtimeMs: Long = 0L

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
        myLon: Double? = null,
        gapRatioX: Double = 0.0,
        gapRatioY: Double = 0.0,
        refGapRatioX: Double = 0.0,
        centerRow: Int? = null,
    ) {
        // fontSize가 SAFE_TEXT_SIZE_PX 이하면 renderScale=1(기존과 완전히 동일한 동작) -
        // 이 값을 넘을 때만 Paint에는 작게 주고 onDraw()에서 canvas.scale()로 키운다.
        val renderScale = if (fontSize > SAFE_TEXT_SIZE_PX) fontSize / SAFE_TEXT_SIZE_PX else 1f
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = Typeface.create(fontFamily, Typeface.NORMAL)
            textSize = fontSize / renderScale
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
            // null이면 flat(myCol 기반), 값이 있으면 sphere(경도 기반) - onDraw()에서 분기
            myLon = myLon,
            // 0.9 상한 - 혹시 잘못된 값이 와도 pitch가 폭발적으로 커지는 걸 막는 안전장치
            gapRatioX = gapRatioX.coerceIn(0.0, 0.9),
            gapRatioY = gapRatioY.coerceIn(0.0, 0.9),
            refGapRatioX = refGapRatioX.coerceIn(0.0, 0.9),
            // null이면 flat(totalRows 기준 기하학적 중앙), 값이 있으면 sphere(그 행에 정렬)
            centerRow = centerRow,
            renderScale = renderScale,
        )

        // 새 세션 시작 - 목표(실시간 offsetMs)와 완전히 일치한 상태로 초기화한다.
        smoothedOffsetMs = TimeSyncManager.currentOffsetMs().toDouble()
        lastFrameRealtimeMs = SystemClock.elapsedRealtime()

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

        // p.paint는 SAFE_TEXT_SIZE_PX 이하 크기로 만들어져 있으므로(companion object 주석
        // 참고), 여기서 재는 폭/높이도 그만큼 작다 - renderScale을 곱해서 실제(world) 크기로
        // 바꿔야 아래 캔버스 배치 계산(루프 길이, 그리드 중앙 정렬 등)이 맞는다.
        val fm = p.paint.fontMetrics
        val lineHeight = (fm.descent - fm.ascent) * p.renderScale
        val blockWidth = p.lines.maxOf { p.paint.measureText(it) } * p.renderScale
        val blockHeight = lineHeight * p.lines.size

        // 폰 화면(width/height)이 아니라 폰 간 실제 간격(pitch)을 그리드의 한 칸으로 쓴다 -
        // gapRatio만큼 화면보다 넓게 잡아야 폰 사이 베젤/거치대 여백이 반영된다.
        val pitchW = width / (1.0 - p.gapRatioX).toFloat()
        val pitchH = height / (1.0 - p.gapRatioY).toFloat()

        // 그리드 전체를 하나의 캔버스로 본다 - 열 수는 rowCounts 중 가장 넓은 행 기준
        // (100대 균일 그리드는 전부 같은 값이라 문제 없음, 구체는 범위 밖).
        val gridCols = (p.rowCounts.maxOrNull() ?: 1).coerceAtLeast(1)
        // gridWidthPx는 모든 폰이 똑같이 계산해야 같은 캔버스를 공유한다. flat은 gapRatioX가
        // 매니페스트 전체 공통값이라 pitchW가 이미 전 폰 동일해서 문제없지만, sphere는
        // gapRatioX가 위도(행)마다 다르게 설계돼 있어(적도 ~0.39, 극지방 ~0.55) 자기
        // pitchW를 쓰면 폰마다 gridWidthPx가 달라지고, 그 결과 loopLength(=blockWidth+
        // gridWidthPx)도 폰마다 달라져 위도가 극지방에 가까울수록 스크롤 진행률이 어긋나며
        // 속도가 달라 보이는 문제가 있었다(sphere 텍스트 스크롤 싱크 깨짐, 2026-09).
        // 처음엔 sphere에서 gap 보정을 아예 빼고 원래 화면 폭만 썼는데(간격 미반영이라
        // 글자가 압축돼 보임), 지금은 서버가 방송하는 refGapRatioX(가장 넓은 행 하나의
        // 대표값, TEXT_SCROLL 메시지에 포함)로 통일해서 쓴다 - 전 폰이 같은 값을 받으므로
        // gridWidthPx가 다시 전 폰 동일해지면서(싱크 유지) 간격 보정도 살아난다. 다른
        // 행은 실제 gapRatioX와 약간 다를 수 있지만(적도~극지방 0.39~0.55 편차) 0으로
        // 두는 것보다는 훨씬 자연스럽다.
        val refPitchW = width / (1.0 - p.refGapRatioX).toFloat()
        val gridWidthPx = gridCols * (if (p.myLon != null) refPitchW else pitchW)
        val gridHeightPx = p.totalRows.coerceAtLeast(1) * pitchH

        // smoothedOffsetMs를 실시간 목표(TimeSyncManager.currentOffsetMs())로 조금씩 쫓아간다
        // - 클래스 상단 주석 참고. 급격한 변화만 즉시 반영하고, 그 외엔 이번 프레임 실제 경과
        // 시간의 MAX_OFFSET_CATCHUP_RATIO만큼만 좁힌다.
        val nowRealtime = SystemClock.elapsedRealtime()
        val frameDeltaMs = (nowRealtime - lastFrameRealtimeMs).coerceAtLeast(0)
        lastFrameRealtimeMs = nowRealtime

        val targetOffsetMs = TimeSyncManager.currentOffsetMs()
        val offsetDrift = targetOffsetMs - smoothedOffsetMs
        smoothedOffsetMs += if (abs(offsetDrift) > OFFSET_SNAP_THRESHOLD_MS) {
            offsetDrift
        } else {
            val maxStepMs = frameDeltaMs * MAX_OFFSET_CATCHUP_RATIO
            offsetDrift.coerceIn(-maxStepMs, maxStepMs)
        }

        val smoothedNow = System.currentTimeMillis() + smoothedOffsetMs.roundToLong()
        val elapsedSec = (smoothedNow - p.startAt).coerceAtLeast(0) / 1000f
        val distance = elapsedSec * p.speedPxPerSec

        // 스크롤 축은 흐르고, 반대 축은 캔버스 전체 기준으로 가운데 고정된다.
        val originX: Float
        val originY: Float
        if (p.direction == "left" || p.direction == "right") {
            if (p.myLon != null) {
                // sphere: 경도가 이미 360도로 닫힌 원이라 진입/퇴장 여백(blockWidth)이
                // 필요 없다 - 오히려 그 여백 동안 화면 어디에도 텍스트가 없어서 "한 바퀴
                // 돌고 사라진 것처럼" 보였다. loopLength를 gridWidthPx만으로 잡으면
                // progress가 0으로 wrap되는 순간(originX 기준 gridWidthPx<->0)이 물리적으로
                // 같은 지점(경도 0도=360도)이라 끊김 없이 계속 도는 것처럼 보인다.
                val loopLength = gridWidthPx
                val progress = distance % loopLength
                originX = if (p.direction == "left") gridWidthPx - progress else progress
            } else {
                // flat: 평면 벽은 닫힌 원이 아니므로(왼쪽 끝과 오른쪽 끝이 다른 물리적
                // 위치) 기존처럼 진입/퇴장 여백이 있는 티커 방식을 그대로 쓴다.
                val loopLength = blockWidth + gridWidthPx
                val progress = distance % loopLength
                // "left": 오른쪽 끝에서 등장해 왼쪽으로 진행. "right": 왼쪽 끝에서 등장해 오른쪽으로 진행.
                originX = if (p.direction == "left") gridWidthPx - progress else -blockWidth + progress
            }
            // flat은 totalRows 기준 기하학적 중앙(기존 방식). sphere는 439대 남/북
            // 비대칭 배치(북 5행+남 6행) 탓에 그 중앙이 적도보다 살짝 남쪽으로 치우쳐서
            // (row 5/6 경계) 서버가 알려준 centerRow(적도 행)에 직접 맞춘다.
            originY = if (p.centerRow != null) {
                (p.centerRow + 0.5f) * pitchH - blockHeight / 2f
            } else {
                (gridHeightPx - blockHeight) / 2f
            }
        } else {
            val loopLength = blockHeight + gridHeightPx
            val progress = distance % loopLength
            // "up": 아래에서 등장해 위로 진행. "down": 위에서 등장해 아래로 진행.
            originY = if (p.direction == "up") gridHeightPx - progress else -blockHeight + progress
            originX = (gridWidthPx - blockWidth) / 2f
        }

        // 캔버스 좌표에서 내 폰의 오프셋(pitch 기준)만큼 빼면, 캔버스 중 내가 맡은 조각만
        // 화면 안에 들어오고 나머지는 Canvas가 알아서 잘라낸다. 내 화면은 자기 pitch 칸
        // 안에서 가운데 정렬돼 있다고 본다(gen_tiles.py가 crop을 pitch 칸 중앙에 놓는 것과
        // 동일한 규칙) - 그래서 (pitch - 화면크기)/2 만큼 더 뺀다.
        //
        // 가로축만 flat(myCol)/sphere(myLon) 분기 - 클래스 상단 주석 참고. 세로축은 위도
        // 간격이 균일해서 flat과 동일하게 myRow 기반으로 계산한다.
        val localOriginX = if (p.myLon != null) {
            // 경도가 이미 360도로 닫힌 원이라 originX(캔버스 좌표)와 내 위치(devicePos)를
            // 그냥 빼면 안 된다 - 예를 들어 경도 350도 폰의 devicePos는 gridWidthPx 근처인데
            // 텍스트가 막 이음매(0도=360도)를 넘어 originX가 0 근처로 넘어간 순간, 단순
            // 뺄셈으로는 "아주 멀리 있다"(거의 -gridWidthPx)로 계산돼 화면에 안 그려진다 -
            // 실제로는 바로 옆인데도 그렇게 되어 이음매를 지날 때마다 화면이 비어보였다
            // (연속 회전 버그, 2026-09). gridWidthPx를 기준으로 순환 정규화해서 "원 위의
            // 최단 거리"로 바꾸면 이음매 양쪽 폰이 항상 정확히 가까운 쪽으로 계산된다.
            //
            // 대표값을 고르는 경계선은 gridWidthPx/2(원둘레 절반) 고정이 아니라 blockWidth
            // 기준으로 잡아야 한다 - 텍스트 블록 폭이 원둘레의 절반을 넘어가면(긴 텍스트를
            // 크게 표시할 때), 그 절반을 넘어서는 뒷부분을 보여줘야 하는 폰들의 정답 위치가
            // (-gridWidthPx/2, gridWidthPx/2] 범위 밖에 있는데 고정 경계선이 그걸 억지로
            // 범위 안의 엉뚱한 값으로 바꿔버려서, 블록 뒷부분이 그 어떤 폰에서도 절대 안
            // 그려지는 문제가 있었다(예: "ANDO" 5글자 확대 시 뒤쪽 글자가 통째로 안 보임,
            // 2026-09). 경계선을 "텍스트가 절대 안 보이는 위치"(블록 반대편)로 옮기면
            // 해결된다 - blockWidth+화면폭이 원둘레보다 훨씬 작다는 전제 하에 안전하다.
            val devicePos = (p.myLon / 360.0) * gridWidthPx
            val raw = originX - devicePos
            var wrapped = (raw % gridWidthPx + gridWidthPx) % gridWidthPx // [0, gridWidthPx)
            if (wrapped >= gridWidthPx - blockWidth - width) wrapped -= gridWidthPx
            wrapped.toFloat()
        } else {
            originX - (p.myCol * pitchW) - (pitchW - width) / 2f
        }
        val localOriginY = originY - (p.myRow * pitchH) - (pitchH - height) / 2f

        p.lines.forEachIndexed { i, line ->
            val lineWidth = p.paint.measureText(line) * p.renderScale
            val alignOffset = when (p.align) {
                "left" -> 0f
                "right" -> blockWidth - lineWidth
                else -> (blockWidth - lineWidth) / 2f
            }
            val baseline = localOriginY + i * lineHeight - fm.ascent * p.renderScale
            // world 좌표(localOriginX/baseline)로 translate한 뒤 scale을 걸고, drawText 자체는
            // (0,0) 기준 SAFE_TEXT_SIZE_PX 크기로 그린다 - 벡터 윤곽선이라 scale로 키워도
            // 화질 손실 없이 실제 fontSize 크기로 렌더링된다(companion object 주석 참고).
            canvas.save()
            canvas.translate(localOriginX + alignOffset, baseline)
            canvas.scale(p.renderScale, p.renderScale)
            canvas.drawText(line, 0f, 0f, p.paint)
            canvas.restore()
        }
    }
}
