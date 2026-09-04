package com.mediasphere.client

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log

private const val TAG = "[RestartBridge]"
private const val RELAUNCH_DELAY_MS = 500L

/**
 * MainActivity.restartProcess()가 "진짜 새 프로세스로 재시작"하기 위해 거치는 중계
 * 액티비티 - 매니페스트에 별도 프로세스(android:process=":restart_bridge")로 선언되어
 * 있어서 MainActivity의 프로세스가 죽어도 영향을 안 받는다.
 *
 * 순서: (1) 지금 포그라운드인 MainActivity가 이 액티비티를 시작한다(포그라운드에서
 * 시작하는 거라 백그라운드 액티비티 실행 제한에 안 걸림) → (2) MainActivity의 원래
 * 프로세스는 죽는다 → (3) 별도 프로세스에서 살아남은 이 액티비티가, 자신도 방금 막
 * 시작되어 포그라운드 상태이므로 제한 없이 MainActivity를 다시 띄운다 → (4) 자기
 * 프로세스도 종료한다.
 */
class RestartBridgeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // MainActivity의 원래 프로세스가 완전히 종료될 시간을 잠깐 준다.
        Handler(Looper.getMainLooper()).postDelayed({
            Log.d(TAG, "MainActivity 재실행")
            val intent = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
            startActivity(intent)
            finish()
            Runtime.getRuntime().exit(0)
        }, RELAUNCH_DELAY_MS)
    }
}
