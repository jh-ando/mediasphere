package com.mediasphere.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

private const val TAG = "[Boot]"

/**
 * 기기가 재부팅되면 MainActivity를 자동으로 띄운다. Lock Task Mode(MainActivity.
 * enableKioskLockTask())는 앱이 죽었을 때 시스템이 재실행해주는 것뿐이라, 기기 자체가
 * 재부팅되면(정전, 강제 재부팅 등) 앱이 아예 처음부터 다시 시작해야 하는데 그건 이걸로
 * 못 막는다 - 재부팅 후 최소 한 번은 스스로 켜져야 그때 다시 Lock Task Mode에 들어갈 수
 * 있으므로, 이 리시버가 그 첫 실행을 담당한다(원격 ADB 없이도 무선디버깅 꺼진 439대가
 * 정전 등으로 재부팅돼도 스스로 복구되게 하려는 목적, 2026-09).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        Log.d(TAG, "BOOT_COMPLETED 수신 - MainActivity 실행")
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(launchIntent)
    }
}
