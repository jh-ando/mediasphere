package com.mediasphere.client.network

import android.Manifest
import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import com.mediasphere.client.DeviceAdminReceiver
import com.mediasphere.client.isKioskMaintenanceActive
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

private const val TAG = "[WiFi]"
private const val CONFIG_PATH = "/sdcard/mediasphere/config.json"
private const val PREFS = "wifi_watchdog"
private const val KEY_LAST_SSID = "lastSsid"
private const val KEY_LAST_NETWORK_ID = "lastNetworkId"
private const val KEY_DOWN_SINCE = "downSince"
private const val KEY_LAST_DROP = "lastDrop"

// 연결 상태를 확인하는 주기
private const val CHECK_INTERVAL_MS = 15_000L
// 끊긴 뒤 이 시간 동안은 안드로이드가 스스로 다시 붙게 둔다(보통 몇 초 안에 붙는다)
private const val DISCONNECT_GRACE_MS = 60_000L
// 다시 붙이기 시도 간격 - 1분, 2분, 그 뒤로는 5분마다 계속(포기하지 않음)
private val RETRY_DELAYS_MS = longArrayOf(60_000L, 120_000L, 300_000L)
// 같은 AP의 폰들이 동시에 접속하지 않도록 deviceId로 0~29초 시차를 둔다
private const val JITTER_SLOTS = 30
private const val JITTER_STEP_MS = 1_000L
private const val UNKNOWN_SSID = "<unknown ssid>"
// 위치 권한이 없어 저장 목록·네트워크 번호를 못 읽을 때 다시 켜 볼 번호 범위(0부터). 번호는 저장할
// 때마다 1씩 늘어나는 작은 정수라, 처음 세팅 때 한두 번 저장한 폰은 0~2번 안에 있다.
private const val MAX_PROBE_NETWORK_ID = 32

/**
 * Wi-Fi 감시 - 끊긴 채로 1분이 지나면 저장된 Wi-Fi를 다시 "사용함"으로 바꾸고 연결을 지시한다.
 *
 * 현장에서 비밀번호가 맞는데도 Wi-Fi 목록에 "비밀번호가 잘못되었습니다"가 뜨고 끊겨 있던 폰이
 * 있었다(2026-10) - 다시 탭하니 바로 붙었다. AP가 붐비거나 재시작될 때 접속 인증(4-way
 * handshake)이 몇 번 연속으로 시간 초과되면 안드로이드가 비밀번호 오류로 판단해 그 네트워크의
 * 자동 연결을 멈추고, 사람이 다시 탭하기 전엔 풀지 않는다. 이 상태에선 네트워크가 없어서
 * MQTT 재연결·원격 재시작/재부팅·생존 알람이 다 소용없다. 사람이 다시 탭하는 것과 같은 일
 * (enableNetwork + reconnect)을 앱이 대신 한다.
 *
 * 일반 앱은 Android 10부터 Wi-Fi 설정을 못 바꾸지만 Device Owner 앱은 예외다. 다만 저장 목록·
 * SSID·네트워크 번호를 "읽는" 데엔 위치 권한이 필요한데, adb(dpm set-device-owner)로 등록한
 * Device Owner는 Android 12부터 위치 권한을 스스로 허용할 수 없다(에뮬레이터에서 확인 -
 * "Admin can grant sensors permission: false", 2026-10). 그래서 위치 권한이 없으면 번호를 모르는
 * 채로 0~31번을 차례로 두드려 실제로 저장된 번호를 찾고 그 번호로 연결을 지시한다(이 명령들은
 * 위치 권한이 필요 없다). 폰마다 Wi-Fi를 하나만 저장해 둔 현장 구성에선 그 하나에 다시 붙는다.
 * 누가 adb로 위치 권한을 주면(pm grant) 저장 목록을 읽어 정확히 그 네트워크만 다시 켠다.
 * Device Owner가 아닌 개발용 폰에서는 개발자의 Wi-Fi 조작과 부딪히지 않게 아예 동작하지 않는다.
 * 현장 정비(키오스크 해제) 중에도 손대지 않는다.
 *
 * 비밀번호는 다루지 않는다 - 저장된 네트워크의 비밀번호는 그대로 있고 "자동 연결 금지" 표시만
 * 붙은 상태라 다시 켜기만 하면 된다. One UI가 이 표시를 따로 관리해 enableNetwork로 안 풀리면
 * config에 비밀번호를 넣고 지웠다 다시 추가하는 방식을 검토한다(실기기 확인 대기).
 *
 * 끊겼다 다시 붙으면 그 기록(lastDrop)을 heartbeat로 다음 끊김 전까지 계속 보고한다(서버가
 * at으로 중복 제거) - 끊긴 동안엔 보낼 수 없으므로 사후 보고다.
 */
object WifiWatchdog {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var started = false

    // 지난번 끊김 기록 - heartbeat의 lastWifiDrop
    @Volatile
    var lastDrop: JSONObject? = null
        private set

    // 지금 끊긴 상태의 진행 정보(감시 루프에서만 읽고 쓴다)
    private var downSince: Long? = null // 끊긴 시각(벽시계, 보고용)
    private var downSinceElapsed = 0L // 끊긴 시각(경과 시간, 타이머용)
    private var nextAttemptElapsed = 0L
    private var attempts = 0
    private var wifiWasOff = false
    private var lastError: String? = null
    // 앱이 켜진 뒤 아직 한 번도 연결된 걸 못 봤는지 - 부팅 직후 Wi-Fi가 붙기 전의 몇 초를
    // "끊김"으로 기록하지 않기 위함(재부팅할 때마다 끊김 기록이 남지 않게)
    private var sawConnected = false
    private var startupDown = false
    // 위치 권한이 없을 때 찾아 둔 저장 네트워크 번호 - 다음 시도 땐 이것부터 확인한다
    private var probedIds: List<Int> = emptyList()

    // MainActivity.onCreate에서 매번 부른다 - 프로세스당 한 번만 시작된다.
    @Synchronized
    fun start(context: Context, deviceId: Int) {
        if (started) return
        val appContext = context.applicationContext
        val dpm = appContext.getSystemService(DevicePolicyManager::class.java)
        if (dpm == null || !dpm.isDeviceOwnerApp(appContext.packageName)) {
            Log.d(TAG, "Device Owner 아님 - Wi-Fi 감시 건너뜀")
            return
        }
        started = true
        ensureLocationAccess(appContext, dpm)
        lastDrop = prefs(appContext).getString(KEY_LAST_DROP, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        // 앱이 끊긴 동안 다시 켜졌으면 끊긴 시각을 이어받는다
        prefs(appContext).getLong(KEY_DOWN_SINCE, 0L).takeIf { it > 0 }?.let { since ->
            downSince = since
            downSinceElapsed = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - since).coerceAtLeast(0)
        }
        val jitterMs = (Math.floorMod(deviceId, JITTER_SLOTS)) * JITTER_STEP_MS
        Log.d(TAG, "Wi-Fi 감시 시작 - 유예 ${DISCONNECT_GRACE_MS / 1000}초 + 시차 ${jitterMs / 1000}초")
        scope.launch {
            while (isActive) {
                try {
                    check(appContext, jitterMs)
                } catch (e: Exception) {
                    Log.e(TAG, "감시 중 오류", e)
                }
                delay(CHECK_INTERVAL_MS)
            }
        }
    }

    // heartbeat의 wifi - 지금 연결된 SSID와 신호 세기(dBm). 끊겨 있으면 null.
    @Suppress("DEPRECATION")
    fun currentInfo(context: Context): JSONObject? {
        if (!isWifiConnected(context)) return null
        val info = wifiManager(context)?.connectionInfo ?: return null
        return JSONObject().apply {
            put("rssi", info.rssi)
            readableSsid(info.ssid)?.let { put("ssid", it) }
        }
    }

    private fun check(context: Context, jitterMs: Long) {
        val now = System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtime()
        if (isWifiConnected(context)) {
            sawConnected = true
            rememberCurrentNetwork(context)
            downSince?.let { since -> onRecovered(context, since, now) }
            return
        }

        if (downSince == null) {
            startupDown = !sawConnected
            downSince = now
            downSinceElapsed = elapsed
            attempts = 0
            wifiWasOff = false
            lastError = null
            prefs(context).edit().putLong(KEY_DOWN_SINCE, now).apply()
            Log.w(TAG, "Wi-Fi 끊김 감지")
        }
        if (attempts == 0) nextAttemptElapsed = downSinceElapsed + DISCONNECT_GRACE_MS + jitterMs
        if (elapsed < nextAttemptElapsed) return
        // 현장 정비 중엔 기술자가 Wi-Fi 설정을 만지고 있을 수 있으므로 손대지 않는다
        if (isKioskMaintenanceActive()) return

        attempts += 1
        nextAttemptElapsed = elapsed + RETRY_DELAYS_MS[(attempts - 1).coerceAtMost(RETRY_DELAYS_MS.size - 1)]
        reconnect(context)
    }

    // 사람이 Wi-Fi 목록에서 그 네트워크를 다시 탭하는 것과 같은 일을 한다.
    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private fun reconnect(context: Context) {
        val wm = wifiManager(context) ?: return
        val downFor = (System.currentTimeMillis() - (downSince ?: 0L)) / 1000
        if (!wm.isWifiEnabled) {
            wifiWasOff = true
            val ok = wm.setWifiEnabled(true)
            Log.w(TAG, "Wi-Fi가 꺼져 있음 - 켜기 ${if (ok) "요청" else "실패"} (시도 ${attempts}회, ${downFor}초째 끊김)")
            if (!ok) lastError = "WIFI_ENABLE_FAILED"
            // 켜지면 안드로이드가 저장된 네트워크로 알아서 붙는다 - 다음 시도 때 아직이면 아래로 진행
            return
        }

        val target = findTarget(context, wm)
        if (target == null) {
            // 위치 권한이 없어 어느 번호인지 모른다 - 번호를 차례로 두드려 실제로 있는 번호를 찾는다
            // (없는 번호는 false). "다시 사용함"으로만 바꾸고 재연결을 요청하면 안드로이드가 막아 둔
            // 네트워크(사용자 연결 해제 등)는 그대로 안 붙어서(에뮬레이터 확인), 찾은 첫 번호로 연결까지
            // 지시한다 - 사람이 목록에서 그 네트워크를 탭하는 것과 같다. 폰마다 하나만 저장해 둔 구성.
            val known = probedIds.filter { wm.enableNetwork(it, false) }
            val existing = known.ifEmpty { (0 until MAX_PROBE_NETWORK_ID).filter { wm.enableNetwork(it, false) } }
            probedIds = existing
            if (existing.isEmpty()) {
                lastError = "NO_SAVED_NETWORK"
                Log.e(TAG, "저장된 Wi-Fi가 없음(0~${MAX_PROBE_NETWORK_ID - 1}번) - reconnect만 요청 (시도 ${attempts}회, ${downFor}초째 끊김)")
                wm.reconnect()
                return
            }
            val connecting = wm.enableNetwork(existing.first(), true)
            if (!connecting) lastError = "ENABLE_NETWORK_FAILED"
            Log.w(
                TAG,
                "저장된 Wi-Fi 다시 연결(번호 모름) - 저장된 번호=$existing, ${existing.first()}번 연결 지시=$connecting " +
                    "(시도 ${attempts}회, ${downFor}초째 끊김)",
            )
            return
        }
        val enabled = wm.enableNetwork(target.first, true)
        val reconnecting = wm.reconnect()
        if (!enabled) lastError = "ENABLE_NETWORK_FAILED"
        Log.w(
            TAG,
            "저장된 Wi-Fi 다시 연결 - ${target.second ?: "networkId=${target.first}"} " +
                "enableNetwork=$enabled reconnect=$reconnecting (시도 ${attempts}회, ${downFor}초째 끊김)",
        )
    }

    // 다시 붙을 네트워크(networkId, SSID). 우선순위: 마지막으로 연결됐던 SSID → 저장된 네트워크가
    // 하나뿐이면 그것 → config.json의 ssid와 같은 이름 → 저장 목록을 못 읽으면 마지막 networkId.
    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private fun findTarget(context: Context, wm: WifiManager): Pair<Int, String?>? {
        val p = prefs(context)
        val lastSsid = p.getString(KEY_LAST_SSID, null)
        val saved: List<WifiConfiguration> = try {
            wm.configuredNetworks ?: emptyList()
        } catch (e: SecurityException) {
            Log.e(TAG, "저장된 Wi-Fi 목록을 못 읽음(위치 권한/설정 확인)", e)
            emptyList()
        }
        if (saved.isNotEmpty()) {
            val configSsid = readConfigSsid()
            val pick = saved.firstOrNull { lastSsid != null && unquote(it.SSID) == lastSsid }
                ?: saved.singleOrNull()
                ?: saved.firstOrNull { configSsid != null && unquote(it.SSID) == configSsid }
            if (pick != null) return pick.networkId to unquote(pick.SSID)
            Log.e(TAG, "저장된 Wi-Fi ${saved.size}개 중 대상을 정하지 못함 - 마지막 SSID=$lastSsid")
        }
        val lastId = p.getInt(KEY_LAST_NETWORK_ID, -1)
        return if (lastId >= 0) lastId to lastSsid else null
    }

    // 연결돼 있을 때 그 네트워크를 기억해 둔다 - 끊겼을 때 다시 붙을 대상
    @Suppress("DEPRECATION")
    private fun rememberCurrentNetwork(context: Context) {
        val info = wifiManager(context)?.connectionInfo ?: return
        val ssid = readableSsid(info.ssid)
        val p = prefs(context)
        val edit = p.edit()
        var changed = false
        if (ssid != null && ssid != p.getString(KEY_LAST_SSID, null)) {
            edit.putString(KEY_LAST_SSID, ssid)
            changed = true
        }
        if (info.networkId >= 0 && info.networkId != p.getInt(KEY_LAST_NETWORK_ID, -1)) {
            edit.putInt(KEY_LAST_NETWORK_ID, info.networkId)
            changed = true
        }
        if (changed) {
            edit.apply()
            Log.d(TAG, "연결된 Wi-Fi 기억 - ssid=$ssid networkId=${info.networkId}")
        }
    }

    private fun onRecovered(context: Context, since: Long, now: Long) {
        if (startupDown && attempts == 0) {
            // 앱 시작(부팅) 직후 Wi-Fi가 붙기 전이었을 뿐 - 기록하지 않는다
            prefs(context).edit().remove(KEY_DOWN_SINCE).apply()
            downSince = null
            startupDown = false
            return
        }
        val drop = JSONObject().apply {
            put("at", since)
            put("durationMs", now - since)
            put("attempts", attempts) // 0이면 안드로이드가 유예 시간 안에 스스로 다시 붙은 것
            if (wifiWasOff) put("wifiWasOff", true)
            lastError?.let { put("error", it) }
        }
        lastDrop = drop
        prefs(context).edit().putString(KEY_LAST_DROP, drop.toString()).remove(KEY_DOWN_SINCE).apply()
        Log.w(TAG, "Wi-Fi 다시 연결됨 - ${(now - since) / 1000}초 끊김, 앱 재연결 시도 ${attempts}회")
        downSince = null
        startupDown = false
        attempts = 0
        wifiWasOff = false
        lastError = null
    }

    // 저장 목록·SSID를 읽으려면 위치 권한과 위치 설정이 필요하다. Device Owner가 위치 권한을 스스로
    // 허용할 수 있는 기기(QR/NFC 등으로 등록)에선 허용하고, adb로 등록한 기기(Android 12+)는 허용이
    // 막혀 있으므로 그냥 넘어간다 - 그때는 번호를 모르는 방식으로 동작한다(reconnect 참고). 위치
    // 설정은 권한이 있을 때만 켠다(권한 없이 켜 봐야 쓸모가 없음).
    private fun ensureLocationAccess(context: Context, dpm: DevicePolicyManager) {
        val admin = ComponentName(context, DeviceAdminReceiver::class.java)
        val canGrant = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || dpm.canAdminGrantSensorsPermissions()
        if (canGrant) {
            try {
                dpm.setPermissionGrantState(
                    admin,
                    context.packageName,
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                )
            } catch (e: Exception) {
                Log.e(TAG, "위치 권한 자동 허용 실패", e)
            }
        }
        val hasLocation = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (hasLocation && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                dpm.setLocationEnabled(admin, true)
            } catch (e: Exception) {
                Log.e(TAG, "위치 설정 켜기 실패", e)
            }
        }
        Log.d(
            TAG,
            if (hasLocation) "위치 권한 있음 - 저장된 Wi-Fi를 정확히 골라 다시 연결"
            else "위치 권한 없음(adb 등록 기기는 자동 허용 불가) - 저장된 Wi-Fi 번호를 찾아 다시 연결",
        )
    }

    private fun isWifiConnected(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        @Suppress("DEPRECATION")
        return cm.allNetworks.any { network ->
            cm.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        }
    }

    private fun wifiManager(context: Context): WifiManager? =
        context.applicationContext.getSystemService(WifiManager::class.java)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun readConfigSsid(): String? = try {
        JSONObject(File(CONFIG_PATH).readText()).optString("ssid").takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        null
    }

    private fun unquote(ssid: String?): String? = ssid?.removeSurrounding("\"")

    // 위치 권한이 없으면 SSID 대신 "<unknown ssid>"가 온다
    private fun readableSsid(ssid: String?): String? = unquote(ssid)?.takeIf { it.isNotBlank() && it != UNKNOWN_SSID }
}
