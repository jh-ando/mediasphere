package com.mediasphere.client.pattern

import android.animation.ValueAnimator
import android.util.Log
import android.view.View
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

    // duration이 0이면 무한 반복, 0보다 크면 그 시간 뒤 자동으로 stop()되며 마지막 상태를 유지한다.
    fun startBlink(color: Int, interval: Long, duration: Long) {
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

        Log.d(TAG, "점멸 시작 - color=#${Integer.toHexString(color)}, interval=${interval}ms, duration=${duration}ms")

        if (duration > 0) {
            stopTimeoutJob = scope.launch {
                delay(duration)
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
