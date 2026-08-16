package com.mediasphere.client.pattern

import android.animation.ValueAnimator
import android.view.View
import com.mediasphere.client.sync.TimeSyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 텍스트 패턴에서 이 폰이 맡은 셀(전경/글자) 하나를 담당 - 지정된 절대 시각까지 기다렸다가
 * 알파를 0→1로 페이드인하고, 다음 절대 시각까지 유지한 뒤 1→0으로 페이드아웃한다.
 *
 * PATTERN_START/SEQUENCE_START와 같은 이유로 TimeSyncManager.now()는 각 단계 시작 전
 * 딱 한 번만 참조하고 그 뒤론 로컬 딜레이+ValueAnimator로 돈다 - 정해진 길이의 1회성
 * 애니메이션이라 텍스트 스크롤처럼 매 프레임 다시 계산할 필요가 없고, 그래서 TimeSync
 * 재동기화 타이밍 문제에서도 자유롭다.
 */
object TextPatternAnimator {

    private var job: Job? = null
    private var animator: ValueAnimator? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun animate(view: View, color: Int, fadeInAt: Long, fadeInMs: Long, fadeOutAt: Long, fadeOutMs: Long) {
        stop()

        view.setBackgroundColor(color)
        view.alpha = 0f

        job = scope.launch {
            val delayIn = fadeInAt - TimeSyncManager.now()
            if (delayIn > 0) delay(delayIn)
            runFade(view, from = 0f, to = 1f, duration = fadeInMs)

            // 페이드인 도중 시간이 흘렀을 수 있으니 fadeOutAt까지 남은 시간을 다시 잰다.
            val delayOut = fadeOutAt - TimeSyncManager.now()
            if (delayOut > 0) delay(delayOut)
            runFade(view, from = 1f, to = 0f, duration = fadeOutMs)
        }
    }

    // ValueAnimator로 알파를 부드럽게 바꾸면서, 코루틴은 그 길이만큼만 delay로 대기했다가
    // 다음 단계로 넘어간다 - PatternAnimator의 stopTimeoutJob과 같은 방식.
    private suspend fun runFade(view: View, from: Float, to: Float, duration: Long) {
        val valueAnimator = ValueAnimator.ofFloat(from, to)
        valueAnimator.duration = duration
        valueAnimator.addUpdateListener { anim -> view.alpha = anim.animatedValue as Float }
        animator = valueAnimator
        valueAnimator.start()
        delay(duration)
    }

    // 진행 중인 페이드를 취소한다. PatternAnimator.stop()과 마찬가지로 마지막 알파값을
    // 그대로 유지한다(TEXT_PATTERN_STOP = "정지 시 마지막 상태 유지" 관례를 따름).
    fun stop() {
        job?.cancel()
        job = null
        animator?.cancel()
        animator = null
    }
}
