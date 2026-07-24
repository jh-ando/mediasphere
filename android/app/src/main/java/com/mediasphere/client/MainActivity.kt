package com.mediasphere.client

import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.mediasphere.client.mqtt.MqttControlMessage
import com.mediasphere.client.mqtt.MqttManager
import com.mediasphere.client.network.TimecodeReceiver
import com.mediasphere.client.pattern.PatternAnimator
import com.mediasphere.client.sync.DriftCorrector
import com.mediasphere.client.sync.TimeSyncManager
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

private const val TAG = "[Player]"
private const val PATTERN_TAG = "[Pattern]"
private const val VIDEO_PATH = "/sdcard/mediasphere/videos/test.mp4"
private const val START_DELAY_MS = 1000L // 시작 신호 수신 후 재생 전 대기 시간 - 초기 drift가 크게 나는 것을 방지
private const val TIME_SYNC_INTERVAL_MS = 60_000L // TimeSyncManager 재동기화 주기 (1분)

// 영상 모드 / 패턴 모드는 상호 배타적으로 동작한다.
enum class Mode { VIDEO, PATTERN }

class MainActivity : ComponentActivity() {

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var patternView: View
    private lateinit var timecodeReceiver: TimecodeReceiver
    private lateinit var mqttManager: MqttManager

    // 실제로 play()가 호출되었는지 여부 - true가 되기 전까지는 드리프트 보정을 하지 않는다
    private var playbackStarted = false

    // startAt 시각까지 대기하는 코루틴 - 새 PLAY 명령이 오면 이전 대기를 취소한다
    private var pendingPlayJob: Job? = null

    private var currentMode = Mode.VIDEO

    // PATTERN_START의 startAt까지 대기하는 코루틴 - 새 명령이 오면 이전 대기를 취소한다
    private var pendingPatternJob: Job? = null

    // SEQUENCE_START의 내 시작 시각까지 대기하는 코루틴 - 새 명령이 오면 이전 대기를 취소한다
    private var pendingSequenceJob: Job? = null

    // startPlayback() 시점에 player.duration이 아직 C.TIME_UNSET(-1)이라 seekTo를 못한 경우,
    // STATE_READY가 된 뒤 지연 seek를 수행하기 위해 startAt을 보관해둔다.
    private var pendingStartAt: Long? = null

    // 시스템 시각이 NTP/NITZ로 자동 보정되거나 사용자가 수동으로 바꾸면 즉시 재동기화한다.
    private val timeChangeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_TIME_CHANGED) {
                Log.d("[TimeSync]", "시스템 시각 변경 감지 → 즉시 재동기화")
                lifecycleScope.launch {
                    TimeSyncManager.sync()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 설치 환경에서 화면이 꺼지지 않도록 유지
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // 전체화면 몰입형 모드 - 상태표시줄/네비게이션 바 숨김 (스와이프 시 일시적으로만 노출)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { view, insets ->
            hideSystemBars()
            ViewCompat.onApplyWindowInsets(view, insets)
        }

        // 일부 기기(One UI + 3버튼 내비게이션 등)는 WindowInsetsController.hide()만으로는
        // 상태표시줄이 제대로 안 사라지므로, 레거시 systemUiVisibility 플래그를 병행 적용한다.
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )

        // 상태바/내비게이션바를 투명하게 하고, 시스템이 대비를 위해 깔아두는 스크림도 끈다.
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        window.isStatusBarContrastEnforced = false
        window.isNavigationBarContrastEnforced = false

        // 디스플레이 컷아웃(펀치홀 카메라) 영역까지 콘텐츠를 그리도록 허용한다.
        // 이게 없으면 상태바를 완전히 숨기고 투명하게 만들어도 컷아웃 영역엔 그리지 않아
        // 상단이 잘려 보인다 (상태바 숨김/투명화와는 별개의 설정).
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        // Scoped Storage 우회 권한(MANAGE_EXTERNAL_STORAGE) 확인 - 없으면 설정 화면으로 이동
        checkManageExternalStoragePermission()

        setContentView(R.layout.activity_main)
        playerView = findViewById(R.id.playerView)
        patternView = findViewById(R.id.patternView)
        PatternAnimator.attach(patternView)

        // 서버-폰 시간 오프셋 측정 - 최초 1회 실행 후 1분마다 재동기화 (폰 시계 드리프트 누적 방지)
        lifecycleScope.launch {
            while (true) {
                TimeSyncManager.sync()
                Log.d("[TimeSync]", "재동기화 완료 - offsetMs=${TimeSyncManager.currentOffsetMs()}ms")
                delay(TIME_SYNC_INTERVAL_MS)
            }
        }

        // 시스템 시각 변경(NTP/NITZ 자동 보정, 사용자 수동 변경) 감지 시 즉시 재동기화
        // API 33+ 에서는 registerReceiver()에 EXPORTED 플래그를 명시하지 않으면 SecurityException이
        // 발생하므로 ContextCompat.registerReceiver를 사용한다 (시스템 브로드캐스트라 NOT_EXPORTED로 충분).
        ContextCompat.registerReceiver(
            this,
            timeChangeReceiver,
            IntentFilter(Intent.ACTION_TIME_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        player = ExoPlayer.Builder(this).build().apply {
            setMediaItem(MediaItem.fromUri(Uri.fromFile(File(VIDEO_PATH))))
            repeatMode = Player.REPEAT_MODE_ONE
            prepare() // prepare()만 호출 - play()는 서버 PLAY 명령이 올 때까지 호출하지 않는다
        }
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState != Player.STATE_READY) return

                val startAt = pendingStartAt ?: return
                val duration = player.duration
                if (duration <= 0) return

                val targetPos = ((TimeSyncManager.now() - startAt) % duration + duration) % duration
                player.seekTo(targetPos)
                Log.d(TAG, "지연 seek 완료 - targetPos=${targetPos}ms")
                pendingStartAt = null
            }
        })
        playerView.player = player
        playerView.useController = false
        Log.d(TAG, "ExoPlayer 초기화 완료 - $VIDEO_PATH 준비 완료")
        Log.d(TAG, "재생 대기 중")

        // UDP 멀티캐스트 타임코드 수신 시작 - 이제 드리프트 보정에만 사용한다
        timecodeReceiver = TimecodeReceiver(this) { timecode ->
            // ExoPlayer 제어는 메인 스레드에서만 호출 가능
            runOnUiThread {
                // 패턴 모드에서는 ExoPlayer가 멈춰있으므로 드리프트 보정을 하지 않는다
                if (playbackStarted && currentMode == Mode.VIDEO) {
                    DriftCorrector.correct(player, timecode.elapsedMs, timecode.masterMs)
                }
            }
        }
        timecodeReceiver.start()

        // MQTT(wall/control)로 PLAY/STOP/모드전환/패턴 명령 수신 시작
        mqttManager = MqttManager { message ->
            // MQTT 콜백에서 ExoPlayer/View 제어 시 runOnUiThread 필수
            runOnUiThread {
                handleControlMessage(message)
            }
        }
        mqttManager.connect()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            hideSystemBars()

            // WindowInsetsController.hide()만으로 상태표시줄이 안 사라지는 기기를 위한 병행 플래그
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
    }

    // 상태표시줄/네비게이션 바를 숨긴다. 포커스 변경이나 insets 재분배 시점에만 불리므로,
    // 그 사이에 프로그램적으로만 뷰 visibility를 바꾸는 모드 전환(패턴 모드 진입 등) 시점에도
    // 명시적으로 다시 호출해줘야 한다 (Android 14 일부 기기에서 시스템 바가 남아있는 현상 방지).
    private fun hideSystemBars() {
        val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
        windowInsetsController.hide(WindowInsetsCompat.Type.systemBars())
        windowInsetsController.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    override fun onDestroy() {
        timecodeReceiver.stop()
        mqttManager.disconnect()
        PatternAnimator.stop()
        unregisterReceiver(timeChangeReceiver)
        player.release()
        super.onDestroy()
    }

    // wall/control로 수신한 MQTT 명령을 처리한다.
    private fun handleControlMessage(message: MqttControlMessage) {
        when (message) {
            is MqttControlMessage.Play -> {
                playbackStarted = false
                pendingPlayJob?.cancel()
                pendingPlayJob = lifecycleScope.launch {
                    scheduleStart(message.startAt)
                }
            }
            is MqttControlMessage.Stop -> {
                pendingPlayJob?.cancel()
                playbackStarted = false
                pendingStartAt = null

                // retain된 STOP을 재접속 후에 받는 경우에도 다른 폰과 같은 프레임을 보여주도록
                // 정지된 위치(elapsedMs % duration)로 seek한 뒤 정지한다.
                val duration = player.duration
                if (duration > 0) {
                    val targetPos = ((message.elapsedMs % duration) + duration) % duration
                    player.seekTo(targetPos)
                }
                player.pause()
                Log.d(TAG, "재생 정지: MQTT STOP 수신 (elapsedMs=${message.elapsedMs})")
            }
            is MqttControlMessage.Load -> {
                Log.d(TAG, "LOAD 수신 (video=${message.video}) - 아직 미구현")
            }
            MqttControlMessage.CheckUpdate -> {
                Log.d(TAG, "CHECK_UPDATE 수신 - 아직 미구현")
            }
            MqttControlMessage.ModeVideo -> handleModeVideo()
            MqttControlMessage.ModePattern -> handleModePattern()
            is MqttControlMessage.PatternStart -> handlePatternStart(message)
            MqttControlMessage.PatternStop -> handlePatternStop()
            is MqttControlMessage.SequenceStart -> handleSequenceStart(message)
            MqttControlMessage.SequenceStop -> handleSequenceStop()
        }
    }

    // 영상 모드로 전환 - 패턴 리소스를 완전히 정리하고, 영상은 처음 위치로 리셋해 재생 대기 상태로 되돌린다.
    // (PLAY 명령을 새로 받기 전까지는 자동 재생하지 않는다)
    private fun handleModeVideo() {
        pendingPatternJob?.cancel()
        PatternAnimator.stop()
        patternView.visibility = View.GONE
        patternView.alpha = 0f
        playerView.visibility = View.VISIBLE
        player.seekTo(0)
        player.pause()
        playbackStarted = false
        pendingStartAt = null
        currentMode = Mode.VIDEO

        // 모드 전환은 뷰 visibility만 바꾸는 것이라 시스템 insets 콜백이 다시 불리지 않는다.
        // 그 사이 시스템 바가 떠 있었다면 영상 뷰가 그 영역까지 못 채우므로 여기서 명시적으로 재적용한다.
        hideSystemBars()

        Log.d(TAG, "모드 전환: VIDEO")
    }

    // 패턴 모드로 전환 - 영상은 처음 위치로 리셋 후 정지하고, 패턴 뷰도 이전 상태(색상/투명도)를 지우고 초기화한다.
    private fun handleModePattern() {
        player.seekTo(0)
        player.pause()
        playerView.visibility = View.GONE
        patternView.alpha = 0f
        patternView.setBackgroundColor(Color.BLACK)
        patternView.visibility = View.VISIBLE
        PatternAnimator.stop()
        playbackStarted = false
        pendingStartAt = null
        currentMode = Mode.PATTERN

        // 모드 전환은 뷰 visibility만 바꾸는 것이라 시스템 insets 콜백이 다시 불리지 않는다.
        // 그 사이 시스템 바가 떠 있었다면 패턴 뷰가 그 영역까지 못 채우므로 여기서 명시적으로 재적용한다.
        hideSystemBars()

        Log.d(PATTERN_TAG, "모드 전환: PATTERN")
    }

    // 현재 패턴 모드일 때만 처리한다. startAt까지 대기한 뒤에도 여전히 패턴 모드인지 다시 확인한다
    // (대기하는 동안 MODE_VIDEO로 바뀌었을 수 있기 때문).
    private fun handlePatternStart(message: MqttControlMessage.PatternStart) {
        if (currentMode != Mode.PATTERN) {
            Log.d(PATTERN_TAG, "PATTERN 모드가 아니어서 PATTERN_START 무시")
            return
        }

        pendingPatternJob?.cancel()
        pendingPatternJob = lifecycleScope.launch {
            val delayMs = message.startAt - TimeSyncManager.now()
            if (delayMs > 0) delay(delayMs)

            if (currentMode != Mode.PATTERN) {
                Log.d(PATTERN_TAG, "대기 중 모드가 바뀌어 PATTERN_START 취소")
                return@launch
            }

            val color = try {
                Color.parseColor(message.color)
            } catch (e: IllegalArgumentException) {
                Log.e(PATTERN_TAG, "색상 파싱 실패 - ${message.color}", e)
                return@launch
            }
            PatternAnimator.startBlink(color, message.interval, message.duration)
        }
    }

    private fun handlePatternStop() {
        pendingPatternJob?.cancel()
        PatternAnimator.stop()
        Log.d(PATTERN_TAG, "패턴 정지: 마지막 색상 유지")
    }

    // 순차 점멸 시작 - deviceId 순서대로 stepDelay만큼씩 늦게 시작해 물결처럼 점멸시킨다.
    // 현재 패턴 모드일 때만 처리하고, 내 시작 시각까지 대기한 뒤에도 여전히 패턴 모드인지 다시 확인한다
    // (대기하는 동안 MODE_VIDEO로 바뀌었을 수 있기 때문).
    private fun handleSequenceStart(message: MqttControlMessage.SequenceStart) {
        if (currentMode != Mode.PATTERN) {
            Log.d(PATTERN_TAG, "PATTERN 모드가 아니어서 SEQUENCE_START 무시")
            return
        }

        val deviceId = mqttManager.deviceId()
        val myStartAt = message.startAt + (deviceId - 1) * message.stepDelay

        pendingSequenceJob?.cancel()
        pendingSequenceJob = lifecycleScope.launch {
            val delayMs = myStartAt - TimeSyncManager.now()
            if (delayMs > 0) delay(delayMs)

            if (currentMode != Mode.PATTERN) {
                Log.d(PATTERN_TAG, "대기 중 모드가 바뀌어 SEQUENCE_START 취소")
                return@launch
            }

            val color = try {
                Color.parseColor(message.color)
            } catch (e: IllegalArgumentException) {
                Log.e(PATTERN_TAG, "색상 파싱 실패 - ${message.color}", e)
                return@launch
            }
            PatternAnimator.startBlink(color, message.interval, message.duration)
            Log.d(PATTERN_TAG, "순차 점멸 시작 - deviceId=$deviceId, myStartAt=$myStartAt")
        }
    }

    private fun handleSequenceStop() {
        pendingSequenceJob?.cancel()
        PatternAnimator.stop()
        Log.d(PATTERN_TAG, "순차 점멸 정지: 마지막 색상 유지")
    }

    // startAt이 미래 시각이면 그 시각까지 대기하고, 그렇지 않더라도 최소 START_DELAY_MS만큼은
    // 대기한 뒤 재생한다 (초기 버퍼링/드리프트 보정이 안정되기 전에 바로 재생을 시작하면
    // drift가 크게 튀는 문제를 완화하기 위함).
    private suspend fun scheduleStart(startAt: Long) {
        // System.currentTimeMillis()는 폰 로컬 시계라 서버와 어긋날 수 있으므로
        // TimeSyncManager로 보정된 현재 시각을 사용한다. 또한 delayMs 상한을 5초로 둬서
        // TimeSyncManager 동기화가 실패했을 때도 5초 안에는 재생이 시작되도록 한다.
        val now = TimeSyncManager.now()
        val delayMs = maxOf(START_DELAY_MS, minOf(startAt - now, 5000L))
        Log.d(TAG, "재생 대기 중 - delayMs=${delayMs}ms (now=$now startAt=$startAt)")
        delay(delayMs)
        startPlayback(startAt)
    }

    // play() 호출 직전에 targetPos로 seekTo()해서 처음부터 올바른 위치에서 시작한다.
    // 대기하는 동안(START_DELAY_MS 등) 흐른 시간을 반영하기 위해 elapsedMs를 미리 계산해두지 않고,
    // seek 직전 TimeSyncManager로 보정된 현재 시각을 기준으로 targetPos를 다시 계산한다.
    //
    // 일부 기기(Android 15 등)는 이 시점에 player.duration이 아직 C.TIME_UNSET(-1)일 수 있다.
    // 이 경우 seekTo를 스킵하고 pendingStartAt에 보관해뒀다가, STATE_READY가 된 뒤(위 리스너에서)
    // 지연 seek를 수행한다.
    private fun startPlayback(startAt: Long) {
        val duration = player.duration
        Log.d(TAG, "duration=$duration")

        if (duration > 0) {
            val targetPos = ((TimeSyncManager.now() - startAt) % duration + duration) % duration
            player.seekTo(targetPos)
            Log.d(TAG, "시작 위치 seek - targetPos=${targetPos}ms")
            pendingStartAt = null
        } else {
            Log.w(TAG, "duration 미준비 - STATE_READY에서 재시도")
            pendingStartAt = startAt
        }
        player.play()
        playbackStarted = true
        Log.d(TAG, "재생 시작: startAt=$startAt")
    }

    // MANAGE_EXTERNAL_STORAGE 권한(API 30+)이 없으면 설정 화면으로 이동해 요청한다.
    // 권한이 없어도 앱은 계속 실행되지만, 영상 파일 접근 시 Permission denied가 발생한다.
    private fun checkManageExternalStoragePermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (Environment.isExternalStorageManager()) return

        Log.d(TAG, "MANAGE_EXTERNAL_STORAGE 권한 없음 - 설정 화면으로 이동")
        try {
            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
    }
}
