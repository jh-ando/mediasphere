package com.mediasphere.client

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log

private const val TAG = "[KeepAlive]"
// 생존 확인 주기 - 반복 알람은 시스템이 조금씩 몰아서 울리므로 실제로는 1~2분 간격이 된다.
private const val KEEP_ALIVE_INTERVAL_MS = 60_000L

/**
 * 앱 생존 확인 알람. 1분마다 시스템 알람으로 깨어나 MainActivity가 화면에 없으면 다시 띄운다.
 *
 * 앱이 죽으면 보통은 기본 홈 앱 고정 덕에 시스템이 바로(2초 안) 다시 띄운다. 하지만 뒤에 다른
 * 작업이 남아 있으면 시스템은 홈 대신 그걸 보여준다 - 현장 정비 때 열었던 설정 화면이나, 홈을
 * 처음 고정한 직후 남아 있는 원래 런처(에뮬레이터에서 확인, 2026-10). 이 알람이 그런 경우를
 * 1분 안에 메우는 안전망이다.
 *
 * 알람은 앱 프로세스가 아니라 시스템이 들고 있어서 앱이 죽어도 울린다(감시용 프로세스를 따로
 * 두면 발열 등으로 앱과 같이 정리되지만 알람은 남는다). 알람을 지우는 강제 중지는 Device Owner
 * 앱이라 막혀 있고, 화면을 백그라운드에서 띄우는 것도 Device Owner 앱은 허용된다. 개발용
 * 폰(Device Owner 아님)에서는 앱을 빠져나올 때마다 끌려오면 곤란하므로 켜지 않는다.
 */
class KeepAliveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // 화면에 떠 있거나, 현장 정비 중(설정 화면에 가 있음 - 10분 자동 복귀가 따로 있음)이면 그대로 둔다
        if (MainActivity.inForeground || isKioskMaintenanceActive()) return
        Log.d(TAG, "MainActivity가 화면에 없음 - 다시 실행")
        try {
            context.startActivity(AppLaunch.mainIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.e(TAG, "다시 실행 실패", e)
        }
    }

    companion object {
        // MainActivity.onCreate에서 매번 부른다 - 같은 PendingIntent라 다시 걸어도 하나만 남는다.
        fun schedule(context: Context) {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            if (!dpm.isDeviceOwnerApp(context.packageName)) return
            val pendingIntent = PendingIntent.getBroadcast(
                context, 0, Intent(context, KeepAliveReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val alarmManager = context.getSystemService(AlarmManager::class.java)
            alarmManager.setRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + KEEP_ALIVE_INTERVAL_MS,
                KEEP_ALIVE_INTERVAL_MS,
                pendingIntent,
            )
            Log.d(TAG, "생존 확인 알람 설정 - ${KEEP_ALIVE_INTERVAL_MS / 1000}초 주기")
        }
    }
}
