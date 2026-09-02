package com.mediasphere.client

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
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
import android.widget.TextView
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
import com.mediasphere.client.pattern.TextPatternAnimator
import com.mediasphere.client.sync.DriftCorrector
import com.mediasphere.client.sync.TimeSyncManager
import com.mediasphere.client.text.TextScrollView
import com.mediasphere.client.update.UpdateManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

private const val TAG = "[Player]"
private const val PATTERN_TAG = "[Pattern]"
private const val SYNC_TAG = "[FileSync]"
// config.json 읽기 실패 등으로 videoPath/currentVideo를 못 구했을 때만 쓰는 최후 fallback
private const val DEFAULT_VIDEO_PATH = "/sdcard/mediasphere/videos/test.mp4"
private const val START_DELAY_MS = 1000L // 시작 신호 수신 후 재생 전 대기 시간 - 초기 drift가 크게 나는 것을 방지
// TimeSyncManager 재동기화 주기. 영상 모드는 DriftCorrector가 초당 30회 오는 UDP
// 타임코드로 계속 보정하지만, 텍스트/패턴 모드는 UDP 타임코드를 안 받아서 이 재동기화가
// 유일한 기준이다 - 주기가 길수록 그 사이 폰 시계 편차가 그대로 누적된다(1분일 때 특정
// 폰에서 텍스트 스크롤 위치가 눈에 띄게 계속 앞서가는 문제 확인됨). 폐쇄망 로컬 요청이라
// 부담이 거의 없어 짧게 잡는다.
private const val TIME_SYNC_INTERVAL_MS = 5_000L // TimeSyncManager 재동기화 주기 (5초)
private const val CONFIG_PATH = "/sdcard/mediasphere/config.json"
private const val DEFAULT_COLOR_OVERLAY_ALPHA = 0.35f
private const val DEFAULT_TEXT_PATTERN_FADE_MS = 400L // 서버가 fadeInMs/fadeOutMs를 안 보낸 경우 fallback
private const val COLOR_BLINK_CYCLE_MS = 1000L // 페이드인+페이드아웃 한 사이클 길이
private const val COLOR_BLINK_REPEAT_COUNT = 9 // repeatCount는 "추가 반복 횟수"라 9를 주면 총 10회 재생된다
private const val SERVER_PORT = 3000
private const val DOWNLOAD_TIMEOUT_MS = 15000
private const val DOWNLOAD_BUFFER_SIZE = 64 * 1024
private const val AUTO_ID_DISPLAY_MS = 5000L // 앱 실행 직후 자동으로 ID를 보여주는 시간

// 영상 모드 / 패턴 모드는 상호 배타적으로 동작한다.
enum class Mode { VIDEO, PATTERN, TEXT_SCROLL }

class MainActivity : ComponentActivity() {

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var patternView: View
    private lateinit var colorOverlayView: View
    private lateinit var idView: TextView
    private lateinit var textScrollView: TextScrollView
    private lateinit var timecodeReceiver: TimecodeReceiver
    private lateinit var mqttManager: MqttManager
    private lateinit var updateManager: UpdateManager

    // 키오스크 스트레스 컬러 오버레이 설정/상태
    private var colorOverlayAlpha: Float = DEFAULT_COLOR_OVERLAY_ALPHA
    private var currentOverlayColor: Int = Color.BLACK
    private var colorAnimator: ValueAnimator? = null

    // COLOR_CHANGE/COLOR_CLEAR의 startAt까지 대기하는 코루틴 - 새 명령이 오면 이전 대기를 취소한다
    private var pendingColorJob: Job? = null

    // ID 오버레이를 durationMs 뒤에 숨기는 코루틴 - 새 SHOW_ID가 오면 이전 타이머를 취소하고 다시 잰다
    private var idHideJob: Job? = null

    // 실제로 play()가 호출되었는지 여부 - true가 되기 전까지는 드리프트 보정을 하지 않는다
    private var playbackStarted = false

    // startAt 시각까지 대기하는 코루틴 - 새 PLAY 명령이 오면 이전 대기를 취소한다
    private var pendingPlayJob: Job? = null

    private var currentMode = Mode.VIDEO

    // PATTERN_START의 startAt까지 대기하는 코루틴 - 새 명령이 오면 이전 대기를 취소한다
    private var pendingPatternJob: Job? = null

    // SEQUENCE_START의 내 시작 시각까지 대기하는 코루틴 - 새 명령이 오면 이전 대기를 취소한다
    private var pendingSequenceJob: Job? = null

    // wall/device/{deviceId}로 마지막으로 받은 config - CHECK_UPDATE 재검증 시 재사용한다
    private var lastDeviceConfig: MqttControlMessage.DeviceConfig? = null

    // 지금 ExoPlayer에 실제로 로드돼 있는 파일 - 동기화 결과가 이미 적용된 파일과 같으면
    // 재로드(위치 초기화)를 건너뛰기 위한 기준값. onCreate에서 초기 재생 파일로 세팅된다.
    private lateinit var currentVideoFile: File

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
        colorOverlayView = findViewById(R.id.colorOverlayView)
        idView = findViewById(R.id.idView)
        textScrollView = findViewById(R.id.textScrollView)
        PatternAnimator.attach(patternView)
        colorOverlayAlpha = readColorOverlayAlpha()

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

        currentVideoFile = File(readInitialVideoPath())
        player = ExoPlayer.Builder(this).build().apply {
            setMediaItem(MediaItem.fromUri(Uri.fromFile(currentVideoFile)))
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
        Log.d(TAG, "ExoPlayer 초기화 완료 - 재생 대기 중")

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
        updateManager = UpdateManager(this, mqttManager)
        mqttManager.connect()

        // 앱을 켜자마자 몇 초간 deviceId를 보여준다 - MQTT/Wi-Fi 연결 전에도 동작해서
        // config.json을 방금 심은 폰을 물리적으로 바로 식별할 수 있다.
        showIdOverlay(AUTO_ID_DISPLAY_MS)
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
        TextPatternAnimator.stop()
        pendingColorJob?.cancel()
        colorAnimator?.cancel()
        unregisterReceiver(timeChangeReceiver)
        player.release()
        super.onDestroy()
    }

    // config.json에서 colorOverlayAlpha 값을 읽는다. 실패하면 기본값을 사용한다.
    private fun readColorOverlayAlpha(): Float {
        return try {
            val json = JSONObject(File(CONFIG_PATH).readText())
            json.optDouble("colorOverlayAlpha", DEFAULT_COLOR_OVERLAY_ALPHA.toDouble()).toFloat()
        } catch (e: Exception) {
            Log.e(TAG, "config.json 읽기 실패 - colorOverlayAlpha 기본값($DEFAULT_COLOR_OVERLAY_ALPHA) 사용", e)
            DEFAULT_COLOR_OVERLAY_ALPHA
        }
    }

    // config.json의 videoPath+currentVideo로 초기 재생 파일 경로를 구성한다. 읽기 실패 시에만
    // DEFAULT_VIDEO_PATH로 폴백한다 (최초 부팅 등 config.json이 아직 없는 경우 대비).
    private fun readInitialVideoPath(): String {
        return try {
            val json = JSONObject(File(CONFIG_PATH).readText())
            val videoPath = json.getString("videoPath")
            val currentVideo = json.getString("currentVideo")
            File(videoPath, "$currentVideo.mp4").path
        } catch (e: Exception) {
            Log.e(TAG, "config.json 읽기 실패 - 기본값($DEFAULT_VIDEO_PATH) 사용", e)
            DEFAULT_VIDEO_PATH
        }
    }

    // config.json에서 serverIp 값을 읽는다 (영상 다운로드 URL 조립에 사용). 실패하면 null.
    private fun readServerIp(): String? {
        return try {
            JSONObject(File(CONFIG_PATH).readText()).getString("serverIp")
        } catch (e: Exception) {
            Log.e(SYNC_TAG, "config.json 읽기 실패 - serverIp 없음", e)
            null
        }
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
                clearColorOverlay()
                Log.d(TAG, "재생 정지: MQTT STOP 수신 (elapsedMs=${message.elapsedMs})")
            }
            is MqttControlMessage.Load -> {
                Log.d(TAG, "LOAD 수신 (video=${message.video}) - 아직 미구현")
            }
            MqttControlMessage.CheckUpdate -> handleCheckUpdate()
            is MqttControlMessage.RestartApp -> handleRestartApp(message)
            is MqttControlMessage.DeviceConfig -> handleDeviceConfig(message)
            is MqttControlMessage.UpdateApk -> updateManager.handleUpdate(message)
            MqttControlMessage.ModeVideo -> handleModeVideo()
            MqttControlMessage.ModePattern -> handleModePattern()
            MqttControlMessage.ModeText -> handleModeText()
            is MqttControlMessage.TextScroll -> handleTextScroll(message)
            MqttControlMessage.TextStop -> handleTextStop()
            is MqttControlMessage.TextPatternCell -> handleTextPatternCell(message)
            MqttControlMessage.TextPatternStop -> handleTextPatternStop()
            is MqttControlMessage.PatternStart -> handlePatternStart(message)
            MqttControlMessage.PatternStop -> handlePatternStop()
            is MqttControlMessage.SequenceStart -> handleSequenceStart(message)
            MqttControlMessage.SequenceStop -> handleSequenceStop()
            is MqttControlMessage.ShowId -> showIdOverlay(message.durationMs)
            MqttControlMessage.HideId -> hideIdOverlay()
            is MqttControlMessage.ColorChange -> handleColorChange(message)
            is MqttControlMessage.ColorClear -> handleColorClear(message)
            is MqttControlMessage.ColorState -> handleColorState(message)
            MqttControlMessage.ColorStateCleared -> handleColorStateCleared()
        }
    }

    // 영상 모드로 전환 - 패턴 리소스를 완전히 정리하고, 영상은 처음 위치로 리셋해 재생 대기 상태로 되돌린다.
    // (PLAY 명령을 새로 받기 전까지는 자동 재생하지 않는다)
    private fun handleModeVideo() {
        pendingPatternJob?.cancel()
        PatternAnimator.stop()
        TextPatternAnimator.stop()
        patternView.visibility = View.GONE
        patternView.alpha = 0f
        textScrollView.stop()
        textScrollView.visibility = View.GONE
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
        textScrollView.stop()
        textScrollView.visibility = View.GONE
        PatternAnimator.stop()
        TextPatternAnimator.stop()
        playbackStarted = false
        pendingStartAt = null
        currentMode = Mode.PATTERN
        clearColorOverlay()

        // 모드 전환은 뷰 visibility만 바꾸는 것이라 시스템 insets 콜백이 다시 불리지 않는다.
        // 그 사이 시스템 바가 떠 있었다면 패턴 뷰가 그 영역까지 못 채우므로 여기서 명시적으로 재적용한다.
        hideSystemBars()

        Log.d(PATTERN_TAG, "모드 전환: PATTERN")
    }

    // 텍스트 스크롤 모드로 전환 - 영상/패턴 리소스를 정리하고 textScrollView를 보여준다.
    // 실제 텍스트 내용은 이후 TEXT_SCROLL 명령으로 채워진다(PATTERN_START가 그러듯).
    private fun handleModeText() {
        player.seekTo(0)
        player.pause()
        playerView.visibility = View.GONE
        pendingPatternJob?.cancel()
        PatternAnimator.stop()
        TextPatternAnimator.stop()
        patternView.visibility = View.GONE
        patternView.alpha = 0f
        playbackStarted = false
        pendingStartAt = null
        currentMode = Mode.TEXT_SCROLL
        clearColorOverlay()
        textScrollView.visibility = View.VISIBLE

        hideSystemBars()

        Log.d(TAG, "모드 전환: TEXT_SCROLL")
    }

    // 현재 텍스트 모드일 때만 처리한다 (PATTERN_START가 패턴 모드를 확인하는 것과 동일한 이유).
    private fun handleTextScroll(message: MqttControlMessage.TextScroll) {
        if (currentMode != Mode.TEXT_SCROLL) {
            Log.d(TAG, "TEXT 모드가 아니어서 TEXT_SCROLL 무시")
            return
        }

        val config = lastDeviceConfig
        textScrollView.start(
            text = message.text,
            fontFamily = message.font,
            fontSize = message.fontSize,
            textColor = message.color,
            bgColor = message.bgColor,
            align = message.align,
            direction = message.direction,
            speedPxPerSec = message.speedPxPerSec,
            rowCounts = message.rowCounts,
            totalRows = message.totalRows,
            startAt = message.startAt,
            myRow = config?.row ?: 0,
            myCol = config?.col ?: 0,
            // null로 그대로 넘긴다(0.0으로 기본값 주지 않음) - TextScrollView가 이 null
            // 여부로 flat/sphere를 구분하므로, 여기서 defaulting하면 그 신호가 사라진다.
            myLon = config?.lon,
            gapRatioX = config?.gapRatioX ?: 0.0,
            gapRatioY = config?.gapRatioY ?: 0.0,
            refGapRatioX = message.refGapRatioX,
            centerRow = message.centerRow,
        )
        Log.d(TAG, "텍스트 스크롤 시작 - row=${config?.row} col=${config?.col} lat=${config?.lat} lon=${config?.lon} "
            + "gapRatioX=${config?.gapRatioX} gapRatioY=${config?.gapRatioY}")
    }

    private fun handleTextStop() {
        textScrollView.stop()
        Log.d(TAG, "텍스트 스크롤 정지")
    }

    // 텍스트 패턴에서 이 폰이 맡은 셀 하나 - 패턴 모드 내 기능이라 패턴 모드일 때만 처리한다
    // (PATTERN_START와 같은 이유). 진행 중인 점멸(PatternAnimator)이 있으면 먼저 정지한다 -
    // 패턴 모드 안에서 점멸과 텍스트 패턴은 동시에 쓰지 않는 상호 배타적 하위 기능이다.
    private fun handleTextPatternCell(message: MqttControlMessage.TextPatternCell) {
        if (currentMode != Mode.PATTERN) {
            Log.d(PATTERN_TAG, "PATTERN 모드가 아니어서 TEXT_PATTERN_CELL 무시")
            return
        }

        val color = try {
            Color.parseColor(message.color)
        } catch (e: IllegalArgumentException) {
            Log.e(PATTERN_TAG, "텍스트 패턴 색상 파싱 실패 - ${message.color}", e)
            return
        }

        PatternAnimator.stop()

        if (message.fadeInAt != null) {
            TextPatternAnimator.animate(
                view = patternView,
                color = color,
                fadeInAt = message.fadeInAt,
                fadeInMs = message.fadeInMs ?: DEFAULT_TEXT_PATTERN_FADE_MS,
                fadeOutAt = message.fadeOutAt ?: message.fadeInAt,
                fadeOutMs = message.fadeOutMs ?: DEFAULT_TEXT_PATTERN_FADE_MS,
            )
        } else {
            // 배경 셀 - 애니메이션 없이 즉시 고정
            TextPatternAnimator.stop()
            patternView.setBackgroundColor(color)
            patternView.alpha = 1f
        }
    }

    private fun handleTextPatternStop() {
        TextPatternAnimator.stop()
        Log.d(PATTERN_TAG, "텍스트 패턴 정지: 마지막 상태 유지")
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
            TextPatternAnimator.stop()
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
            TextPatternAnimator.stop()
            PatternAnimator.startBlink(color, message.interval, message.duration)
            Log.d(PATTERN_TAG, "순차 점멸 시작 - deviceId=$deviceId, myStartAt=$myStartAt")
        }
    }

    private fun handleSequenceStop() {
        pendingSequenceJob?.cancel()
        PatternAnimator.stop()
        Log.d(PATTERN_TAG, "순차 점멸 정지: 마지막 색상 유지")
    }

    // 키오스크 COLOR_CHANGE - startAt까지 대기한 뒤 해당 색으로 1초 주기 알파 페이드 인/아웃을
    // 10회 반복하고, 끝나면 오버레이를 완전히 끈다.
    private fun handleColorChange(message: MqttControlMessage.ColorChange) {
        val newColor = try {
            Color.parseColor(message.color)
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "컬러 파싱 실패 - ${message.color}", e)
            return
        }

        pendingColorJob?.cancel()
        pendingColorJob = lifecycleScope.launch {
            val delayMs = message.startAt - TimeSyncManager.now()
            if (delayMs > 0) delay(delayMs)
            animateColorOverlay(newColor)
        }
    }

    private fun animateColorOverlay(color: Int) {
        colorAnimator?.cancel()

        currentOverlayColor = color
        colorOverlayView.setBackgroundColor(color)
        colorOverlayView.visibility = View.VISIBLE

        // 한 사이클(0 -> colorOverlayAlpha -> 0)이 1초, repeatCount=9로 총 10회 반복한다.
        val animator = ValueAnimator.ofFloat(0f, colorOverlayAlpha, 0f)
        animator.duration = COLOR_BLINK_CYCLE_MS
        animator.repeatCount = COLOR_BLINK_REPEAT_COUNT
        animator.repeatMode = ValueAnimator.RESTART
        animator.addUpdateListener { anim ->
            colorOverlayView.alpha = anim.animatedValue as Float
        }
        animator.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                // cancel()도 onAnimationEnd를 호출하므로, 이 애니메이터가 여전히 최신인 경우에만
                // 정리한다 (새 COLOR_CHANGE로 교체된 뒤 이 콜백이 뒤늦게 와서 새 상태를 덮어쓰는 것 방지).
                if (colorAnimator !== animation) return
                colorOverlayView.alpha = 0f
                colorOverlayView.visibility = View.GONE
            }
        })
        colorAnimator = animator
        animator.start()
    }

    // 키오스크 COLOR_CLEAR - startAt까지 대기한 뒤 오버레이를 즉시 끈다 (애니메이션 없음).
    private fun handleColorClear(message: MqttControlMessage.ColorClear) {
        pendingColorJob?.cancel()
        pendingColorJob = lifecycleScope.launch {
            val delayMs = message.startAt - TimeSyncManager.now()
            if (delayMs > 0) delay(delayMs)
            clearColorOverlay()
        }
    }

    // wall/state/color(retain) - 재접속/재부팅으로 라이브 COLOR_CHANGE를 놓쳤을 때만 애니메이션 없이
    // 즉시 현재 색상을 반영한다. retain 플래그는 "나중에 구독하는 클라이언트"에만 의미가 있을 뿐,
    // 이미 연결돼 wall/control을 구독 중인 폰에도 이 메시지가 그대로 실시간으로 온다. COLOR_CHANGE를
    // 이미 정상 수신해 대기 중이거나 점멸 중이면 이 메시지는 그 명령의 부수 효과일 뿐이므로 무시해야
    // 점멸이 중간에 잘리고 색이 즉시 박히는 문제(pendingColorJob이 취소되는 문제)가 생기지 않는다.
    private fun handleColorState(message: MqttControlMessage.ColorState) {
        if (pendingColorJob?.isActive == true || colorAnimator?.isRunning == true) {
            Log.d(TAG, "라이브 COLOR_CHANGE 처리 중이라 wall/state/color 갱신 무시")
            return
        }

        val color = try {
            Color.parseColor(message.color)
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "컬러 파싱 실패 - ${message.color}", e)
            return
        }

        currentOverlayColor = color
        colorOverlayView.setBackgroundColor(color)
        colorOverlayView.alpha = colorOverlayAlpha
        colorOverlayView.visibility = View.VISIBLE
    }

    private fun handleColorStateCleared() {
        clearColorOverlay()
    }

    // COLOR_CHANGE 오버레이를 완전히 끈다 - 패턴 모드 진입, STOP, COLOR_CLEAR, retain 상태 삭제 시 공통으로 쓰인다.
    private fun clearColorOverlay() {
        pendingColorJob?.cancel()
        colorAnimator?.cancel()
        colorOverlayView.alpha = 0f
        colorOverlayView.visibility = View.GONE
    }

    // deviceId를 durationMs 동안 화면 맨 위에 덮어 보여준다. 영상/패턴 모드나 재생 상태를
    // 전혀 건드리지 않는 순수 오버레이라, 시간이 지나면 원래 화면이 그대로 이어서 보인다.
    // MQTT(SHOW_ID)와 앱 실행 직후 자동 호출 양쪽에서 공유한다 - 새로 호출되면 이전 타이머는 취소.
    // durationMs <= 0이면 PATTERN_START의 duration=0과 같은 관례로 자동으로 안 꺼지고
    // 계속 표시한다 - 끌 때는 hideIdOverlay()(HIDE_ID 명령)를 쓴다.
    private fun showIdOverlay(durationMs: Long) {
        idHideJob?.cancel()
        idView.text = mqttManager.deviceId().toString()
        idView.visibility = View.VISIBLE
        if (durationMs > 0) {
            idHideJob = lifecycleScope.launch {
                delay(durationMs)
                idView.visibility = View.GONE
            }
        }
    }

    private fun hideIdOverlay() {
        idHideJob?.cancel()
        idHideJob = null
        idView.visibility = View.GONE
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

    // wall/device/{deviceId}(retain)로 새 config를 받았을 때 - 배정된 영상 파일을 동기화한다.
    // retain 특성상 재접속마다 같은 내용이 다시 오고, 게다가 서버가 qos:1로 발행하기 때문에
    // MQTT 스펙상("적어도 한 번" 전달) 신호가 불안정한 폰은 완전히 동일한 메시지를 짧은
    // 간격으로 중복 수신할 수 있다(재전송 - 버그가 아니라 QoS 1의 정상 동작). syncVideoFile
    // 안에서도 체크섬이 같으면 재다운로드는 안 하지만, 그것만으로는 매번 영상 파일 전체를
    // 다시 해싱하는 비용은 못 피한다 - 그래서 여기서 직전과 완전히 동일한 내용이면 아예
    // syncVideoFile 호출 자체를 건너뛴다(실기기에서 특정 폰 몇 대가 몇 초 간격으로 같은
    // 체크섬을 계속 재발행하는 현상 확인 후 추가).
    private fun handleDeviceConfig(message: MqttControlMessage.DeviceConfig) {
        val previous = lastDeviceConfig
        lastDeviceConfig = message
        if (previous != null && previous.videoPath == message.videoPath &&
            previous.currentVideo == message.currentVideo && previous.checksum == message.checksum
        ) {
            Log.d(SYNC_TAG, "중복 config 수신(내용 동일) - 재검증 스킵")
            return
        }
        syncVideoFile(message.videoPath, message.currentVideo, message.checksum)
    }

    // CHECK_UPDATE - 서버가 "지금 파일 상태를 다시 확인해서 보고해줘"라고 요청할 때 수신.
    // 아직 DeviceConfig를 한 번도 못 받았으면(예: manifest 배치 전) 검증할 대상이 없어 무시한다.
    private fun handleCheckUpdate() {
        val config = lastDeviceConfig
        if (config == null) {
            Log.d(SYNC_TAG, "CHECK_UPDATE 수신 - 아직 배정된 config 없음, 스킵")
            return
        }
        syncVideoFile(config.videoPath, config.currentVideo, config.checksum)
    }

    // RESTART_APP - targetDeviceIds가 없으면(전체 대상) 무조건, 있으면 내 deviceId가
    // 포함된 경우에만 Activity를 재시작한다. onDestroy -> onCreate가 다시 돌면서
    // config.json 재읽기, ExoPlayer/MQTT 재생성이 전부 처음부터 다시 이뤄진다.
    private fun handleRestartApp(message: MqttControlMessage.RestartApp) {
        val targets = message.targetDeviceIds
        val myId = mqttManager.deviceId()
        if (targets != null && myId !in targets) {
            Log.d(TAG, "RESTART_APP 수신 - 대상 아님(내 deviceId=$myId)")
            return
        }
        Log.d(TAG, "RESTART_APP 수신 - 재시작 (대상=${targets ?: "전체"})")
        recreate()
    }

    // 대상 파일이 로컬에 없으면 서버 /clips/{currentVideo}.mp4에서 다운로드한다. 파일이 이미
    // 있어도 expectedChecksum이 주어졌는데 로컬 체크섬과 다르면(서버가 같은 파일명으로 다른
    // 영상을 재배포한 경우) 무조건 재다운로드한다 - expectedChecksum이 없으면(옛 manifest 등)
    // 예전처럼 "있으면 믿는다"로 동작한다. 결과를 wall/ready(성공) 또는 wall/error(실패)로 보고한다.
    private fun syncVideoFile(videoPath: String, currentVideo: String, expectedChecksum: String?) {
        lifecycleScope.launch(Dispatchers.IO) {
            val dest = File(videoPath, "$currentVideo.mp4")
            val serverIp = readServerIp()
            val expected = expectedChecksum?.removePrefix("sha256:")

            var checksum: String? = null
            if (dest.exists()) {
                val localChecksum = sha256Of(dest)
                if (expected == null || localChecksum == expected) {
                    checksum = localChecksum
                } else {
                    Log.d(SYNC_TAG, "로컬 파일 체크섬 불일치 - 재다운로드 - $currentVideo")
                }
            }

            // 실제로 새로 받았는지를 별도로 기억해둔다 - 같은 파일명이라도 서버가 내용을
            // 다시 배포한 경우(재인코딩 후 재배포 등)라 applyVideoFile()에서 "경로가 같으니
            // 이미 로드된 파일"이라고 오판해 재생 중인 옛 소스를 계속 쓰는 문제가 있었다.
            var didDownload = false
            if (checksum == null) {
                checksum = if (serverIp == null) {
                    Log.e(SYNC_TAG, "serverIp 없음 - $currentVideo 다운로드 불가")
                    null
                } else {
                    downloadAndVerify(serverIp, currentVideo, dest).also { didDownload = it != null }
                }
            }

            if (checksum != null) {
                persistLocalConfig(videoPath, currentVideo)
                mqttManager.publishReady("$currentVideo.mp4", "sha256:$checksum")
                Log.d(SYNC_TAG, "동기화 완료 - $currentVideo (checksum=$checksum)")
                withContext(Dispatchers.Main) { applyVideoFile(dest, forceReload = didDownload) }
            } else {
                mqttManager.publishError("DOWNLOAD_FAILED", "$currentVideo.mp4 다운로드/검증 실패")
            }
        }
    }

    // 로컬 /sdcard/mediasphere/config.json의 videoPath/currentVideo를 갱신한다 (다른 필드는 유지).
    // 이걸 안 하면 재부팅 시 readInitialVideoPath()가 여전히 예전 값을 읽어 검은 화면이 재발한다.
    private fun persistLocalConfig(videoPath: String, currentVideo: String) {
        try {
            val file = File(CONFIG_PATH)
            val json = JSONObject(file.readText())
            json.put("videoPath", videoPath)
            json.put("currentVideo", currentVideo)
            file.writeText(json.toString())
        } catch (e: Exception) {
            Log.e(SYNC_TAG, "로컬 config.json 갱신 실패", e)
        }
    }

    // 새로 동기화된 파일이 지금 로드된 것과 다르면 ExoPlayer의 소스를 교체한다.
    // forceReload=true(syncVideoFile()이 실제로 재다운로드한 경우)면 경로가 같아도 재로드한다 -
    // 서버가 같은 파일명으로 내용만 바꿔 재배포한 경우(재인코딩 후 재배포 등) ExoPlayer가 이미
    // 열어둔 옛 파일 핸들을 계속 쓰는 바람에 앱을 재시작해야만 새 영상이 반영되던 문제가 있었다.
    //
    // 재생 중이어도 곧바로 교체한다 - 예전엔 439대 동기화가 깨질까봐 STOP/모드전환 때까지
    // 보류했었는데, 이 설치는 사실상 24시간 연속 재생이라 STOP이 올 일이 없어 보류된 교체가
    // 영영 적용되지 못하고 앱 재시작이 강제되는 문제가 있었다. 실제로는 보류가 불필요하다 -
    // setMediaItem() 직후 currentPosition이 0으로 리셋돼도, DriftCorrector.kt가 매 UDP
    // 패킷(33ms 간격)마다 오차를 감지해서 200ms 초과 시 즉시 seekTo(targetPos)로 맞춰주므로
    // 다음 패킷 안에 자동으로 재동기화된다. 교체 순간 그 폰만 잠깐(길어야 수백ms) 멈칫할 수
    // 있지만, 폰마다 다운로드 완료 시점이 달라 이 멈칫함도 분산되고, 439대 동시 재시작(전체
    // 검은 화면)보다 훨씬 덜 disruptive하다. 반드시 메인 스레드에서 호출.
    private fun applyVideoFile(dest: File, forceReload: Boolean = false) {
        if (!forceReload && dest.path == currentVideoFile.path) return

        currentVideoFile = dest
        player.setMediaItem(MediaItem.fromUri(Uri.fromFile(dest)))
        player.prepare()
        if (playbackStarted) player.play()
        Log.d(SYNC_TAG, "재생 파일 교체 완료 - ${dest.path}")
    }

    // 서버에서 영상을 스트리밍 다운로드하며 SHA-256을 함께 계산한다. 임시 파일에 받은 뒤
    // 완료되면 최종 경로로 옮겨서, 다운로드 도중 실패해도 손상된 파일이 dest에 남지 않게 한다.
    private fun downloadAndVerify(serverIp: String, currentVideo: String, dest: File): String? {
        val tmpFile = File(dest.parentFile, "${dest.name}.download")
        var connection: HttpURLConnection? = null
        return try {
            val url = URL("http://$serverIp:$SERVER_PORT/clips/$currentVideo.mp4")
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = DOWNLOAD_TIMEOUT_MS
                readTimeout = DOWNLOAD_TIMEOUT_MS
            }

            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                Log.e(SYNC_TAG, "다운로드 실패 - HTTP ${connection.responseCode}: $url")
                return null
            }

            dest.parentFile?.mkdirs()
            val digest = MessageDigest.getInstance("SHA-256")
            connection.inputStream.use { input ->
                tmpFile.outputStream().use { output ->
                    val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                    }
                }
            }
            tmpFile.renameTo(dest)
            digest.digest().joinToString("") { "%02x".format(it) }
        } catch (e: Exception) {
            Log.e(SYNC_TAG, "다운로드 실패 - $currentVideo", e)
            tmpFile.delete()
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read == -1) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
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
