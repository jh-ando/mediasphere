package com.mediasphere.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

private const val TAG = "[Boot]"

/**
 * 기기가 재부팅되면 MainActivity를 자동으로 띄운다. 앱이 이미 기본 홈 앱으로 고정돼 있으면
 * (MainActivity.enableKioskLockTask()) 부팅 후 시스템이 홈으로 이 앱을 띄우지만, 고정 전
 * (첫 설치 직후 등)이거나 홈 실행이 늦는 경우를 위해 이 리시버가 첫 실행을 확실히 맡는다
 * (원격 ADB 없이도 무선디버깅 꺼진 439대가 정전 등으로 재부팅돼도 스스로 복구되게 하려는
 * 목적, 2026-09). singleTask라 홈 실행과 겹쳐도 화면은 하나만 뜬다.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        Log.d(TAG, "BOOT_COMPLETED 수신 - MainActivity 실행")
        val launchIntent = AppLaunch.mainIntent(context).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(launchIntent)
    }
}
