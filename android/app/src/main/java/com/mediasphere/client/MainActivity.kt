package com.mediasphere.client

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.mediasphere.client.network.TimecodeReceiver
import com.mediasphere.client.network.Timecode
import com.mediasphere.client.sync.DriftCorrector
import com.mediasphere.client.sync.TimeSyncManager
import com.mediasphere.client.ui.theme.MediaSphereTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

private const val TAG = "[Player]"
private const val VIDEO_PATH = "/sdcard/mediasphere/videos/test.mp4"
private const val START_DELAY_MS = 1000L // 시작 신호 수신 후 재생 전 대기 시간 - 초기 drift가 크게 나는 것을 방지

class MainActivity : ComponentActivity() {

    private lateinit var player: ExoPlayer
    private lateinit var timecodeReceiver: TimecodeReceiver

    // 서버가 보낸 마지막 startAt - 값이 바뀌면 새로운 PLAY 명령으로 간주한다
    private var lastStartAt: Long? = null

    // 실제로 play()가 호출되었는지 여부 - true가 되기 전까지는 드리프트 보정을 하지 않는다
    private var playbackStarted = false

    // startAt 시각까지 대기하는 코루틴 - 새 PLAY 명령이 오면 이전 대기를 취소한다
    private var pendingPlayJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 설치 환경에서 화면이 꺼지지 않도록 유지
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Scoped Storage 우회 권한(MANAGE_EXTERNAL_STORAGE) 확인 - 없으면 설정 화면으로 이동
        checkManageExternalStoragePermission()

        // 서버-폰 시간 오프셋 측정 (앱 시작 시 1회, /api/time을 5회 호출해 중간값 사용)
        lifecycleScope.launch {
            TimeSyncManager.sync()
        }

        player = ExoPlayer.Builder(this).build().apply {
            setMediaItem(MediaItem.fromUri(Uri.fromFile(File(VIDEO_PATH))))
            repeatMode = Player.REPEAT_MODE_ONE
            prepare() // prepare()만 호출 - play()는 서버 PLAY 명령이 올 때까지 호출하지 않는다
        }
        Log.d(TAG, "ExoPlayer 초기화 완료 - $VIDEO_PATH 준비 완료")
        Log.d(TAG, "재생 대기 중")

        // UDP 멀티캐스트 타임코드 수신 시작
        timecodeReceiver = TimecodeReceiver(this) { timecode ->
            // ExoPlayer 제어는 메인 스레드에서만 호출 가능
            runOnUiThread {
                handleTimecode(timecode)
            }
        }
        timecodeReceiver.start()

        setContent {
            MediaSphereTheme {
                PlayerScreen(player = player, modifier = Modifier.fillMaxSize())
            }
        }
    }

    override fun onDestroy() {
        timecodeReceiver.stop()
        player.release()
        super.onDestroy()
    }

    // isPlaying이 false면 STOP 명령으로 보고 즉시 일시정지한다.
    // isPlaying이 true일 때만 startAt/드리프트 보정 로직을 수행한다.
    // startAt이 바뀌면 새 PLAY 명령으로 보고 재생 시각을 다시 계산한다.
    // 이미 재생 중이면(startAt 동일) 기존 드리프트 보정만 계속 수행한다.
    private fun handleTimecode(timecode: Timecode) {
        if (!timecode.isPlaying) {
            pendingPlayJob?.cancel()
            playbackStarted = false
            player.pause()
            Log.d(TAG, "재생 정지: STOP 수신")
            return
        }

        if (timecode.startAt != lastStartAt) {
            lastStartAt = timecode.startAt
            playbackStarted = false
            pendingPlayJob?.cancel()
            pendingPlayJob = lifecycleScope.launch {
                scheduleStart(timecode)
            }
        }

        if (playbackStarted) {
            DriftCorrector.correct(player, timecode.elapsedMs, timecode.masterMs)
        }
    }

    // startAt이 미래 시각이면 그 시각까지 대기하고, 그렇지 않더라도 최소 START_DELAY_MS만큼은
    // 대기한 뒤 재생한다 (초기 버퍼링/드리프트 보정이 안정되기 전에 바로 재생을 시작하면
    // drift가 크게 튀는 문제를 완화하기 위함).
    private suspend fun scheduleStart(timecode: Timecode) {
        val delayMs = maxOf(START_DELAY_MS, timecode.startAt - System.currentTimeMillis())
        Log.d(TAG, "재생 대기 중")
        delay(delayMs)
        startPlayback(timecode.startAt)
    }

    // play() 호출 직전에 targetPos로 seekTo()해서 처음부터 올바른 위치에서 시작한다.
    // 대기하는 동안(START_DELAY_MS 등) 흐른 시간을 반영하기 위해 elapsedMs를 미리 계산해두지 않고,
    // seek 직전 TimeSyncManager로 보정된 현재 시각을 기준으로 targetPos를 다시 계산한다.
    private fun startPlayback(startAt: Long) {
        val duration = player.duration
        if (duration > 0) {
            val targetPos = ((TimeSyncManager.now() - startAt) % duration + duration) % duration
            player.seekTo(targetPos)
            Log.d(TAG, "시작 위치 seek - targetPos=${targetPos}ms")
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

@Composable
fun PlayerScreen(player: ExoPlayer, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            PlayerView(context).apply {
                this.player = player
                useController = false
            }
        },
    )
}
