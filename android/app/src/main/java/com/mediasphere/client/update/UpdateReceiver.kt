package com.mediasphere.client.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.mediasphere.client.MainActivity

private const val TAG = "[Update]"

/**
 * 앱이 OTA(또는 수동)로 업데이트된 직후 시스템이 보내는 MY_PACKAGE_REPLACED를 받아
 * MainActivity를 다시 띄운다. 이 브로드캐스트는 앱이 실행 중이 아니어도 시스템이
 * 매니페스트에 등록된 리시버를 깨워서 전달하는 특수 케이스라, 별도 Foreground Service
 * 없이도 수신할 수 있다 (킥오스크형으로 항상 켜져 있는 이 앱 특성상 무거운 백그라운드
 * 작업 없이 바로 Activity 재실행이면 충분하다고 판단).
 *
 * 재시작 후 재동기화(MQTT 재연결, TimeSyncManager 재동기화, wall/device·wall/state/color
 * retain 복구)는 MainActivity.onCreate()가 이미 매번 처리하므로 여기서 추가로 할 일은 없다.
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return

        Log.d(TAG, "MY_PACKAGE_REPLACED 수신 - MainActivity 재시작")
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        context.startActivity(launchIntent)
    }
}
