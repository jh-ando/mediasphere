package com.mediasphere.client.sync

import android.util.Log
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import kotlin.math.abs

private const val TAG = "Player"
private const val DRIFT_IGNORE_MS = 16L
private const val DRIFT_TIER1_MS = 50L // 16~50ms
private const val DRIFT_TIER2_MS = 100L // 50~100ms
private const val DRIFT_TIER3_MS = 200L // 100~200ms - 이후는 seek
private const val SPEED_RATIO_TIER1 = 0.015f // ±1.5%
private const val SPEED_RATIO_TIER2 = 0.03f // ±3%
private const val SPEED_RATIO_TIER3 = 0.05f // ±5%
private const val SPEED_NORMAL = 1.0f
private const val LOOP_BOUNDARY_RATIO = 0.5 // 이전 targetPos와의 차이가 duration의 50% 이상이면 루프 경계로 판단
private const val SUMMARY_INTERVAL_MS = 5000L

/**
 * 루프 재생 중인 플레이어 위치를 서버 타임코드(elapsedMs)에 맞춰 보정한다.
 * 영상이 루프 재생되므로 targetPos는 elapsedMs를 영상 길이로 나눈 나머지로 계산한다.
 */
object DriftCorrector {

    private var lastSummaryAt = 0L
    private var sampleCount = 0
    private var driftSum = 0L
    private var maxAbsDrift = 0L

    // 직전 호출의 targetPos - 루프 경계(모듈로 wrap) 감지에 사용한다.
    private var lastTargetPos = -1L

    fun correct(player: Player, elapsedMs: Long, masterMs: Long) {
        val duration = player.duration
        if (duration <= 0) return // 아직 미디어 길이를 알 수 없음 (준비 전)

        // TimeSyncManager로 보정된 현재 시각 기준, 패킷 전송 이후 흐른 시간만큼 elapsedMs를 보정한다.
        // (동기화된 시계가 없으면 네트워크 전송 지연만큼 drift가 한쪽으로 계속 치우친다)
        val adjustedElapsedMs = elapsedMs + (TimeSyncManager.now() - masterMs)
        val targetPos = ((adjustedElapsedMs % duration) + duration) % duration

        // 루프 경계 감지: targetPos가 직전 호출 대비 duration의 50% 이상 점프했다면
        // 모듈로 wrap이 막 일어난 순간이다 (예: 5900ms -> 100ms). currentPosition의 wrap
        // 시점과 어긋나 drift가 순간적으로 크게 튀므로 이번 프레임은 보정을 건너뛴다.
        if (lastTargetPos >= 0 && abs(targetPos - lastTargetPos) > duration * LOOP_BOUNDARY_RATIO) {
            Log.d(TAG, "루프 경계 감지 - targetPos ${lastTargetPos}ms → ${targetPos}ms, 보정 스킵")
            lastTargetPos = targetPos
            return
        }
        lastTargetPos = targetPos

        val drift = player.currentPosition - targetPos
        val absDrift = abs(drift)
        val driftStr = if (drift >= 0) "+${drift}ms" else "${drift}ms"

        when {
            absDrift < DRIFT_IGNORE_MS -> {
                // 정상 범위 - 이전에 속도 보정이 걸려있었을 수 있으니 정상 속도로 복원한다
                player.playbackParameters = PlaybackParameters(SPEED_NORMAL)
            }
            absDrift <= DRIFT_TIER1_MS -> applySpeedCorrection(player, drift, SPEED_RATIO_TIER1, driftStr)
            absDrift <= DRIFT_TIER2_MS -> applySpeedCorrection(player, drift, SPEED_RATIO_TIER2, driftStr)
            absDrift <= DRIFT_TIER3_MS -> applySpeedCorrection(player, drift, SPEED_RATIO_TIER3, driftStr)
            else -> {
                // 오차가 너무 커서 속도 보정으로는 부족함 - targetPos로 직접 이동
                player.seekTo(targetPos)
                player.setPlaybackSpeed(SPEED_NORMAL)
                Log.d(TAG, "drift=$driftStr → seek (즉시 이동)")
            }
        }

        recordSample(drift)
    }

    // drift 크기에 비례한 속도(ratio)만큼 재생 속도를 가감한다.
    // drift > 0 (서버보다 빠름) -> 감속, drift < 0 (서버보다 느림) -> 가속
    private fun applySpeedCorrection(player: Player, drift: Long, ratio: Float, driftStr: String) {
        val speed = if (drift > 0) SPEED_NORMAL - ratio else SPEED_NORMAL + ratio
        player.setPlaybackSpeed(speed)
        Log.d(TAG, "drift=$driftStr speed=${"%.3f".format(speed)} (속도 조정)")
    }

    // 5초마다 한 번씩 drift 평균/최대치를 요약해서 출력한다.
    private fun recordSample(drift: Long) {
        sampleCount += 1
        driftSum += drift
        if (abs(drift) > maxAbsDrift) maxAbsDrift = abs(drift)

        val now = System.currentTimeMillis()
        if (lastSummaryAt == 0L) lastSummaryAt = now

        if (now - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
            val avgDrift = if (sampleCount > 0) driftSum / sampleCount else 0L
            Log.d(TAG, "drift 요약(5s): avg=${avgDrift}ms, max=${maxAbsDrift}ms, samples=$sampleCount")

            lastSummaryAt = now
            sampleCount = 0
            driftSum = 0L
            maxAbsDrift = 0L
        }
    }
}
