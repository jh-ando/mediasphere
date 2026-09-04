package com.mediasphere.client.pattern

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
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

    // 지속시간이 끝났을 때(또는 영상 모드로 전환될 때) 즉시 멈추면 너무 갑작스러워서, 이
    // 시간만큼 서서히 어두워진 뒤에 멈춘다. MainActivity가 텍스트 스크롤→영상 전환의
    // 페이드아웃 시간도 이 값으로 맞춰서 쓴다(PatternAnimator.FADE_OUT_MS로 참조).
    // server.js의 같은 이름 상수(재생목록 큐 전환 대기시간 계산에 이만큼을 추가로 더함)와
    // 반드시 같은 값을 써야 한다. 1초로 잡은 이유: PLAY_TRIGGER로 패턴/텍스트→영상 전환 시
    // 이 페이드와 별개로 재생 시작 자체가 START_DELAY_MS(1초)만큼 대기하는데, 둘 다 MODE_VIDEO/
    // PLAY가 거의 동시에 도착하는 시점(t=0)에서 나란히 출발하므로 값을 맞추면 "페이드가
    // 걷히는 순간 = 재생이 시작되는 순간"이 되어 0번 프레임 정지화면이 잠깐 노출되는 구간이
    // 없어진다(2026-09).
    const val FADE_OUT_MS = 1000L

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
    //
    // colorProvider는 색을 값 하나가 아니라 "뽑는 방법"으로 받는다 - 고정 색상 모드는 매번
    // 같은 값을 반환하는 람다를 넘기면 되고, 랜덤 모드는 호출할 때마다 새 값을 뽑는 람다를
    // 넘기면 된다. 알파가 완전히 꺼진(0) 시점마다 다시 호출해서 배경색을 갈아끼운다 - 켜진
    // 상태에서 바꾸면 화면이 켜져 있는 도중 색이 툭 튀어 보이므로, 안 보일 때만 바꾼다
    // (패턴 모드 랜덤 컬러가 깜빡일 때마다 새로 뽑히게 하는 기능, 2026-09).
    fun startBlink(colorProvider: () -> Int, interval: Long, stopAtEpochMs: Long?) {
        stop()

        val view = viewRef?.get()
        if (view == null) {
            Log.e(TAG, "patternView 참조 없음 - startBlink 무시")
            return
        }

        view.setBackgroundColor(colorProvider())

        val valueAnimator = ValueAnimator.ofFloat(0f, 1f)
        valueAnimator.duration = interval / 2
        valueAnimator.repeatMode = ValueAnimator.REVERSE
        valueAnimator.repeatCount = ValueAnimator.INFINITE
        valueAnimator.addUpdateListener { anim ->
            view.alpha = anim.animatedValue as Float
        }
        valueAnimator.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationRepeat(animation: Animator) {
                if (view.alpha == 0f) view.setBackgroundColor(colorProvider())
            }
        })
        animator = valueAnimator
        valueAnimator.start()

        Log.d(TAG, "점멸 시작 - interval=${interval}ms, stopAt=$stopAtEpochMs")

        if (stopAtEpochMs != null) {
            val delayMs = stopAtEpochMs - TimeSyncManager.now()
            stopTimeoutJob = scope.launch {
                if (delayMs > 0) delay(delayMs)
                fadeOutThenStop()
                Log.d(TAG, "지속시간 종료 - ${FADE_OUT_MS}ms 페이드아웃 후 정지")
            }
        }
    }

    // 점멸을 즉시 끊지 않고 현재 alpha에서 0으로 서서히 낮춘 뒤 정지한다 - 재생목록 큐의
    // 지속시간이 자연스럽게 끝나 다음 큐로 넘어갈 때 쓴다(패턴/텍스트→영상 전환은 하드컷으로
    // 바뀌어서 이제 안 씀, 2026-09). 명시적 STOP 명령은 stop()으로 즉시 멈춘다.
    fun fadeOutThenStop() {
        val view = viewRef?.get() ?: return
        animator?.cancel() // 점멸 애니메이터 정지 - 지금 alpha 값에서 이어서 페이드아웃

        val fade = ValueAnimator.ofFloat(view.alpha, 0f)
        fade.duration = FADE_OUT_MS
        fade.addUpdateListener { anim -> view.alpha = anim.animatedValue as Float }
        animator = fade
        fade.start()
    }

    // ValueAnimator를 cancel하면 마지막으로 애니메이션되던 alpha 값이 그대로 유지된다.
    fun stop() {
        stopTimeoutJob?.cancel()
        stopTimeoutJob = null
        animator?.cancel()
        animator = null
    }
}
