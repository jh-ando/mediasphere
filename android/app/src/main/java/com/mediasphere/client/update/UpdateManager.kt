package com.mediasphere.client.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.mediasphere.client.BuildConfig
import com.mediasphere.client.mqtt.MqttControlMessage
import com.mediasphere.client.mqtt.MqttManager
import com.mediasphere.client.sync.TimeSyncManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.coroutines.resume

private const val TAG = "[Update]"
private const val CONFIG_PATH = "/sdcard/mediasphere/config.json"
private const val APK_DOWNLOAD_DIR = "/sdcard/mediasphere/apk"
private const val DOWNLOAD_TIMEOUT_MS = 20000
private const val DOWNLOAD_BUFFER_SIZE = 64 * 1024
private const val MAX_DOWNLOAD_RETRIES = 4
private const val BASE_BACKOFF_MS = 2000L
private const val INSTALL_RESULT_ACTION = "com.mediasphere.client.OTA_INSTALL_RESULT"

/**
 * wall/ota(UpdateApk) 수신 시 다운로드+검증+무인 설치를 처리한다.
 * 모든 실패는 예외 없이 wall/ota/status로 보고하고 끝나며, 기존 앱은 항상 그대로 유지된다
 * (PackageInstaller 세션 기반 설치라 실패해도 이미 깔린 앱이 지워지지 않는다).
 *
 * 무인 설치(setRequireUserAction(false))는 Device Owner 상태에서만 실제로 동작한다 -
 * Device Owner가 아니면 session.commit()이 STATUS_PENDING_USER_ACTION을 돌려주는데,
 * 이 상태를 받으면 앱이 직접 EXTRA_INTENT를 startActivity()로 띄워야 시스템 설치 확인
 * 화면이 나타난다(자동으로 뜨지 않는다) - install()의 리시버가 이 상태를 처리한다.
 */
class UpdateManager(
    private val context: Context,
    private val mqttManager: MqttManager,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun handleUpdate(message: MqttControlMessage.UpdateApk) {
        scope.launch {
            try {
                process(message)
            } catch (e: Exception) {
                Log.e(TAG, "OTA 처리 중 예외", e)
                mqttManager.publishOtaStatus(message.versionCode, "failed", "UNEXPECTED_ERROR: ${e.message}")
            }
        }
    }

    private suspend fun process(message: MqttControlMessage.UpdateApk) {
        if (message.versionCode <= BuildConfig.VERSION_CODE) {
            Log.d(TAG, "다운그레이드/동일 버전 무시 - versionCode=${message.versionCode} (현재 ${BuildConfig.VERSION_CODE})")
            return
        }

        // 롤링 배포 - SEQUENCE_START와 동일하게 deviceId 순서대로 시차를 둔다
        val deviceId = mqttManager.deviceId()
        val myStartAt = message.startAt + (deviceId - 1) * message.stepDelayMs
        val delayMs = myStartAt - TimeSyncManager.now()
        if (delayMs > 0) delay(delayMs)

        // MQTT 인증이 없는 상태라, url이 내가 알고 있는 서버를 가리키는지는 최소한 확인한다.
        // (발행 권한을 가진 사람이 url+sha256을 자기 것끼리 짝지어 보내는 것까지는 못 막는다)
        val serverIp = readServerIp()
        if (serverIp == null || !isSameHost(message.url, serverIp)) {
            Log.e(TAG, "URL 검증 실패 - url=${message.url}, serverIp=$serverIp")
            mqttManager.publishOtaStatus(message.versionCode, "failed", "URL_HOST_MISMATCH")
            return
        }

        mqttManager.publishOtaStatus(message.versionCode, "downloading")
        val destFile = File(APK_DOWNLOAD_DIR, "mediasphere-v${message.versionCode}.apk")
        val downloaded = downloadWithRetry(message.url, destFile, message.sha256)
        if (!downloaded) {
            mqttManager.publishOtaStatus(message.versionCode, "failed", "DOWNLOAD_FAILED")
            return
        }

        mqttManager.publishOtaStatus(message.versionCode, "installing")
        val installed = install(destFile)
        mqttManager.publishOtaStatus(message.versionCode, if (installed) "done" else "failed",
            if (installed) null else "INSTALL_FAILED")
    }

    private fun isSameHost(urlString: String, expectedHost: String): Boolean {
        return try {
            URL(urlString).host == expectedHost
        } catch (e: Exception) {
            false
        }
    }

    // 실패(네트워크 오류 또는 체크섬 불일치) 시 지수 백오프로 재시도한다.
    private suspend fun downloadWithRetry(url: String, dest: File, expectedSha256: String): Boolean {
        val expected = expectedSha256.removePrefix("sha256:")
        repeat(MAX_DOWNLOAD_RETRIES) { attempt ->
            val checksum = downloadOnce(url, dest)
            if (checksum == expected) return true

            if (checksum != null) {
                Log.e(TAG, "체크섬 불일치 - expected=$expected actual=$checksum "
                    + "(시도 ${attempt + 1}/$MAX_DOWNLOAD_RETRIES)")
            }
            dest.delete()

            if (attempt < MAX_DOWNLOAD_RETRIES - 1) {
                val backoffMs = BASE_BACKOFF_MS * (1L shl attempt)
                Log.d(TAG, "다운로드 재시도 대기 - ${backoffMs}ms")
                delay(backoffMs)
            }
        }
        return false
    }

    // 임시 파일에 스트리밍 다운로드하며 SHA-256을 함께 계산하고, 성공 시에만 최종 경로로 옮긴다.
    private fun downloadOnce(urlString: String, dest: File): String? {
        val tmpFile = File(dest.parentFile, "${dest.name}.download")
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(urlString).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = DOWNLOAD_TIMEOUT_MS
                readTimeout = DOWNLOAD_TIMEOUT_MS
            }

            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                Log.e(TAG, "다운로드 실패 - HTTP ${connection.responseCode}: $urlString")
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
            Log.e(TAG, "다운로드 실패 - $urlString", e)
            tmpFile.delete()
            null
        } finally {
            connection?.disconnect()
        }
    }

    // PackageInstaller 세션을 만들어 무인 설치를 시도한다. 세션 자체가 실패해도(서명 불일치,
    // 손상된 APK 등) 예외 없이 false만 반환한다 - 기존 앱은 세션 방식이라 절대 지워지지 않는다.
    private suspend fun install(apkFile: File): Boolean = suspendCancellableCoroutine { cont ->
        val packageInstaller = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }

        val sessionId = try {
            packageInstaller.createSession(params)
        } catch (e: Exception) {
            Log.e(TAG, "설치 세션 생성 실패", e)
            cont.resume(false)
            return@suspendCancellableCoroutine
        }

        try {
            packageInstaller.openSession(sessionId).use { session ->
                session.openWrite("mediasphere", 0, apkFile.length()).use { out ->
                    apkFile.inputStream().use { input -> input.copyTo(out) }
                    session.fsync(out)
                }

                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(receiverContext: Context, intent: Intent) {
                        val status = intent.getIntExtra(
                            PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE,
                        )

                        // Device Owner가 아니면 여기로 온다 - 최종 결과가 아니라 "사용자 확인이
                        // 필요하다"는 중간 상태라, 리시버를 해제하지 않고 확인 화면을 직접 띄운 뒤
                        // 사용자가 응답하면(수락/거부) 같은 리시버에 최종 상태가 다시 도착한다.
                        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                            val confirmIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                            } else {
                                @Suppress("DEPRECATION")
                                intent.getParcelableExtra(Intent.EXTRA_INTENT)
                            }
                            if (confirmIntent == null) {
                                Log.e(TAG, "STATUS_PENDING_USER_ACTION인데 확인 Intent가 없음")
                                context.unregisterReceiver(this)
                                if (cont.isActive) cont.resume(false)
                                return
                            }
                            try {
                                confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                context.startActivity(confirmIntent)
                                Log.d(TAG, "설치 확인 화면 요청 (Device Owner 아님 - 사용자 승인 필요)")
                            } catch (e: Exception) {
                                Log.e(TAG, "설치 확인 화면 실행 실패", e)
                                context.unregisterReceiver(this)
                                if (cont.isActive) cont.resume(false)
                            }
                            return
                        }

                        context.unregisterReceiver(this)
                        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                        if (status == PackageInstaller.STATUS_SUCCESS) {
                            Log.d(TAG, "설치 성공")
                            if (cont.isActive) cont.resume(true)
                        } else {
                            Log.e(TAG, "설치 실패 - status=$status message=$message")
                            if (cont.isActive) cont.resume(false)
                        }
                    }
                }
                ContextCompat.registerReceiver(
                    context, receiver, IntentFilter(INSTALL_RESULT_ACTION),
                    ContextCompat.RECEIVER_NOT_EXPORTED,
                )

                val intent = Intent(INSTALL_RESULT_ACTION).setPackage(context.packageName)
                val pendingIntent = PendingIntent.getBroadcast(
                    context, sessionId, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(pendingIntent.intentSender)
            }
        } catch (e: Exception) {
            Log.e(TAG, "설치 세션 커밋 실패 - 서명 불일치 등 확인 필요", e)
            try {
                packageInstaller.abandonSession(sessionId)
            } catch (abandonErr: Exception) {
                Log.e(TAG, "세션 정리 실패", abandonErr)
            }
            cont.resume(false)
        }
    }

    // config.json에서 serverIp 값을 읽는다. 실패하면 null.
    private fun readServerIp(): String? {
        return try {
            JSONObject(File(CONFIG_PATH).readText()).getString("serverIp")
        } catch (e: Exception) {
            Log.e(TAG, "config.json 읽기 실패 - serverIp 없음", e)
            null
        }
    }
}
