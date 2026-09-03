package com.mediasphere.client.pattern

import android.animation.ValueAnimator
import android.util.Log
import android.view.View
import com.mediasphere.client.sync.TimeSyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference

private const val TAG = "[Pattern]"

/**
 * 패턴 모드에서 patternView를 점멸시킨다.
 * interval을 점멸 한 주기(on+off)로 보고, ValueAnimator 한 번의 재생 시간은 interval의 절반씩 사용한다.
 */
object PatternAnimator {

    private var viewRef: WeakReference<View>? = null
    private var animator: ValueAnimator? = null
    private var stopTimeoutJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun attach(view: View) {
        viewRef = WeakReference(view)
    }

    // stopAtEpochMs가 null이면 무한 반복, 값이 있으면 그 절대 시각(TimeSyncManager 기준)에
    // 자동으로 stop()되며 마지막 상태를 유지한다. 상대 시간(duration)이 아니라 절대 시각을
    // 받는 이유 - 순차 점멸처럼 폰마다 시작 시각이 다른 경우, "내가 시작한 뒤로 얼마나"가
    // 아니라 "다 같이 언제 끝나는지"를 기준으로 삼아야 먼저 시작한 폰이 큐가 끝나기도 전에
    // 먼저 꺼지는 문제가 없다(순차 점멸 지속시간 의미 수정, 2026-09).
    fun startBlink(color: Int, interval: Long, stopAtEpochMs: Long?) {
        stop()

        val view = viewRef?.get()
        if (view == null) {
            Log.e(TAG, "patternView 참조 없음 - startBlink 무시")
            return
        }

        view.setBackgroundColor(color)

        val valueAnimator = ValueAnimator.ofFloat(0f, 1f)
        valueAnimator.duration = interval / 2
        valueAnimator.repeatMode = ValueAnimator.REVERSE
        valueAnimator.repeatCount = ValueAnimator.INFINITE
        valueAnimator.addUpdateListener { anim ->
            view.alpha = anim.animatedValue as Float
        }
        animator = valueAnimator
        valueAnimator.start()

        Log.d(TAG, "점멸 시작 - color=#${Integer.toHexString(color)}, interval=${interval}ms, stopAt=$stopAtEpochMs")

        if (stopAtEpochMs != null) {
            val delayMs = stopAtEpochMs - TimeSyncManager.now()
            stopTimeoutJob = scope.launch {
                if (delayMs > 0) delay(delayMs)
                stop()
                Log.d(TAG, "지속시간 종료로 점멸 자동 정지")
            }
        }
    }

    // ValueAnimator를 cancel하면 마지막으로 애니메이션되던 alpha 값이 그대로 유지된다.
    fun stop() {
        stopTimeoutJob?.cancel()
        stopTimeoutJob = null
        animator?.cancel()
        animator = null
    }
}
