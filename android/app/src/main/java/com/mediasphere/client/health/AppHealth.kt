package com.mediasphere.client.health

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.HardwarePropertiesManager
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONObject

private const val TAG = "[Health]"
private const val PREFS = "app_health"
private const val KEY_INTENT_KIND = "intentionalKind"
private const val KEY_INTENT_AT = "intentionalAt"
private const val KEY_SNAPSHOT = "lastSnapshot"
private const val KEY_LAST_EXIT = "lastExit"
private const val KEY_LAST_EXIT_AT = "lastExitAt"
// 일부러 종료(원격 재시작/재부팅/OTA)를 표시한 시각과 실제 종료 시각이 이 안에 있으면 의도한 종료로 본다.
private const val INTENTIONAL_WINDOW_MS = 3 * 60_000L
// HardwarePropertiesManager가 값을 모를 때 돌려주는 값 등 말이 안 되는 온도는 버린다.
private const val MIN_VALID_TEMP = -40f
private const val MAX_VALID_TEMP = 150f

// 지금 온도 상태 - heartbeat에 싣고, 주기적으로 저장해 뒀다가 앱이 죽은 뒤 "죽기 직전 상태"로 보고한다.
data class ThermalSnapshot(
    val thermalStatus: Int,
    val batteryTemp: Double?,
    val cpuTemp: Double?,
    val skinTemp: Double?,
) {
    fun putTo(json: JSONObject) {
        json.put("thermalStatus", thermalStatus)
        batteryTemp?.let { json.put("batteryTemp", it) }
        cpuTemp?.let { json.put("cpuTemp", it) }
        skinTemp?.let { json.put("skinTemp", it) }
    }
}

/**
 * 앱이 왜 죽었는지(종료 사유)와 발열 상태를 서버에 알리기 위한 도구.
 *
 * 앱이 죽어 있는 동안엔 아무것도 보낼 수 없으므로, 다시 켜졌을 때 안드로이드에 "지난번에 왜
 * 종료됐는지"(ApplicationExitInfo, Android 11+)를 물어 보고한다. 여기에 30초마다 저장해 둔
 * 온도를 "종료 직전 상태"로 함께 붙인다. 현장에서 발열로 앱이 죽어 사람이 직접 폰을 만져야
 * 했던 문제의 원인 파악용(2026-10).
 */
object AppHealth {

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // 원격 재시작/재부팅/OTA처럼 일부러 프로세스를 끝내기 직전에 부른다 - 다음 실행 때 이 종료를
    // "의도한 종료"로 표시해서 대시보드의 "최근 재시작" 알림에서 뺀다. 바로 뒤에 프로세스가
    // 죽으므로 apply()가 아니라 commit()으로 즉시 디스크에 쓴다.
    fun markIntentionalExit(context: Context, kind: String) {
        prefs(context).edit()
            .putString(KEY_INTENT_KIND, kind)
            .putLong(KEY_INTENT_AT, System.currentTimeMillis())
            .commit()
    }

    // 일부러 끝내려다 실패했을 때(재부팅 거부 등) - 표시를 지워서 이후의 진짜 종료를 의도한 것으로 오해하지 않게.
    fun clearIntentionalExit(context: Context) {
        prefs(context).edit().remove(KEY_INTENT_KIND).remove(KEY_INTENT_AT).apply()
    }

    // heartbeat 주기마다 부른다 - 앱이 갑자기 죽었을 때 "그 직전 온도"로 쓰인다.
    fun saveSnapshot(context: Context, snapshot: ThermalSnapshot) {
        val json = JSONObject().put("at", System.currentTimeMillis())
        snapshot.putTo(json)
        prefs(context).edit().putString(KEY_SNAPSHOT, json.toString()).apply()
    }

    /**
     * 앱 시작 때 한 번 - 지난번 종료를 판정해 heartbeat에 실을 lastExit를 돌려준다.
     * 새 종료가 없으면 이전에 판정해 둔 것을 그대로 돌려준다(서버가 꺼져 있다가 나중에 받아도
     * 유실되지 않게 다음 종료 전까지 계속 싣는다. 서버는 at으로 중복을 거른다).
     */
    fun resolveLastExit(context: Context): JSONObject? {
        val p = prefs(context)
        val reportedAt = p.getLong(KEY_LAST_EXIT_AT, 0L)
        val snapshot = p.getString(KEY_SNAPSHOT, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        val bootAt = System.currentTimeMillis() - SystemClock.elapsedRealtime()

        var reason: String? = null
        var at = 0L
        var detail: String? = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val am = context.getSystemService(ActivityManager::class.java)
                val info = am.getHistoricalProcessExitReasons(context.packageName, 0, 10)
                    // 재시작 중계용 프로세스(:restart_bridge)는 빼고 본 프로세스만
                    .filter { it.processName == context.packageName && it.timestamp > reportedAt }
                    .maxByOrNull { it.timestamp }
                if (info != null) {
                    reason = reasonName(info.reason)
                    at = info.timestamp
                    detail = info.description?.take(200)
                }
            } catch (e: Exception) {
                Log.e(TAG, "종료 기록 조회 실패", e)
            }
        }
        // 종료 기록이 없는데 마지막 저장 이후 기기가 다시 켜졌으면(전원 차단, 발열로 꺼짐 등)
        // 기기 재부팅으로 앱이 끝난 것으로 본다.
        if (reason == null && snapshot != null) {
            val snapAt = snapshot.optLong("at")
            if (snapAt > reportedAt && snapAt < bootAt) {
                reason = "DEVICE_REBOOT"
                at = snapAt
            }
        }
        if (reason == null) {
            return p.getString(KEY_LAST_EXIT, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        }

        val intentKind = p.getString(KEY_INTENT_KIND, null)
        val intentAt = p.getLong(KEY_INTENT_AT, 0L)
        val intentional = when {
            intentKind != null && kotlin.math.abs(at - intentAt) <= INTENTIONAL_WINDOW_MS -> intentKind
            // 앱 업데이트로 인한 종료는 표시를 못 했어도(예전 버전에서 업데이트된 첫 실행) 의도한 종료다
            reason == "PACKAGE_UPDATED" -> "UPDATE"
            else -> null
        }
        val exit = JSONObject().apply {
            put("reason", reason)
            put("at", at)
            detail?.let { put("detail", it) }
            put("afterBoot", at < bootAt)
            intentional?.let { put("intentional", it) }
            // 죽기 직전 온도 - 저장 시각이 종료 시각보다 앞일 때만(종료 뒤 값이 섞이지 않게)
            snapshot?.takeIf { it.optLong("at") <= at }?.let { put("before", it) }
        }
        p.edit()
            .putString(KEY_LAST_EXIT, exit.toString())
            .putLong(KEY_LAST_EXIT_AT, at)
            .remove(KEY_INTENT_KIND)
            .remove(KEY_INTENT_AT)
            .apply()
        Log.d(TAG, "지난번 종료 - $exit")
        return exit
    }

    // 지금 온도 - 발열 단계(시스템이 앱 정리를 판단하는 값), 배터리 온도, CPU·표면 온도.
    // CPU·표면 온도는 Device Owner 앱만 읽을 수 있고(HardwarePropertiesManager), 기기가 값을
    // 안 주면 null이다.
    fun readThermal(context: Context): ThermalSnapshot {
        val pm = context.getSystemService(PowerManager::class.java)
        val battery = ContextCompat.registerReceiver(
            context, null, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        val batteryTenths = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        return ThermalSnapshot(
            thermalStatus = pm?.currentThermalStatus ?: 0,
            batteryTemp = if (batteryTenths == Int.MIN_VALUE) null else batteryTenths / 10.0,
            cpuTemp = readHardwareTemp(context, HardwarePropertiesManager.DEVICE_TEMPERATURE_CPU),
            skinTemp = readHardwareTemp(context, HardwarePropertiesManager.DEVICE_TEMPERATURE_SKIN),
        )
    }

    private fun readHardwareTemp(context: Context, type: Int): Double? = try {
        val hpm = context.getSystemService(HardwarePropertiesManager::class.java)
        hpm?.getDeviceTemperatures(type, HardwarePropertiesManager.TEMPERATURE_CURRENT)
            ?.filter { !it.isNaN() && it > MIN_VALID_TEMP && it < MAX_VALID_TEMP }
            ?.maxOrNull()
            ?.let { Math.round(it * 10) / 10.0 }
    } catch (e: SecurityException) {
        null // Device Owner가 아닌 개발용 폰
    } catch (e: Exception) {
        null
    }

    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_CRASH -> "CRASH"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
        ApplicationExitInfo.REASON_ANR -> "ANR"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
        ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
        ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
        ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
        ApplicationExitInfo.REASON_FREEZER -> "FREEZER"
        ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "PACKAGE_UPDATED"
        ApplicationExitInfo.REASON_OTHER -> "OTHER"
        else -> "UNKNOWN"
    }
}
