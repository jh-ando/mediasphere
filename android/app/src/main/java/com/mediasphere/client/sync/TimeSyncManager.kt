package com.mediasphere.client.sync

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

private const val TAG = "[TimeSync]"
private const val CONFIG_PATH = "/sdcard/mediasphere/config.json"
private const val DEFAULT_SERVER_IP = "192.168.0.1"
private const val SERVER_PORT = 3000
private const val SAMPLE_COUNT = 5
private const val TIMEOUT_MS = 3000

/**
 * 서버와 폰 사이의 시간 오프셋(offsetMs)을 측정한다.
 * GET /api/time을 여러 번 호출해 RTT 기반으로 오프셋을 추정하고,
 * 중간값(median)을 사용해 네트워크 지연 튐(outlier)의 영향을 줄인다.
 *
 * offset = serverMs - (t1 + t2) / 2
 *   t1: 요청 전 로컬 시각, t2: 응답 후 로컬 시각
 */
object TimeSyncManager {

    @Volatile
    private var offsetMs: Long = 0L

    // 드리프트 계산 시 System.currentTimeMillis() 대신 이 값을 사용한다.
    fun now(): Long = System.currentTimeMillis() + offsetMs

    suspend fun sync() {
        withContext(Dispatchers.IO) {
            val serverIp = readServerIp()
            val offsets = mutableListOf<Long>()

            repeat(SAMPLE_COUNT) { attempt ->
                val offset = measureOffset(serverIp)
                if (offset != null) {
                    offsets.add(offset)
                    Log.d(TAG, "샘플 ${attempt + 1}/$SAMPLE_COUNT 측정 완료 - offset=${offset}ms")
                } else {
                    Log.e(TAG, "샘플 ${attempt + 1}/$SAMPLE_COUNT 측정 실패")
                }
            }

            if (offsets.isEmpty()) {
                Log.e(TAG, "시간 동기화 실패 - offsetMs=0 유지")
                return@withContext
            }

            offsetMs = median(offsets)
            Log.d(TAG, "시간 동기화 완료 - offsetMs=$offsetMs (샘플 ${offsets.size}개 중 중간값)")
        }
    }

    private fun measureOffset(serverIp: String): Long? {
        var connection: HttpURLConnection? = null
        return try {
            val url = URL("http://$serverIp:$SERVER_PORT/api/time")
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
            }

            val t1 = System.currentTimeMillis()
            val responseBody = connection.inputStream.bufferedReader().use { it.readText() }
            val t2 = System.currentTimeMillis()

            val serverMs = JSONObject(responseBody).getLong("serverMs")
            serverMs - (t1 + t2) / 2
        } catch (e: Exception) {
            Log.e(TAG, "/api/time 호출 실패 - $serverIp", e)
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun median(values: List<Long>): Long {
        val sorted = values.sorted()
        return sorted[sorted.size / 2]
    }

    // config.json에서 서버 IP를 읽는다. 실패하면 기본값을 사용한다.
    private fun readServerIp(): String {
        return try {
            val json = JSONObject(File(CONFIG_PATH).readText())
            json.getString("serverIp")
        } catch (e: Exception) {
            Log.e(TAG, "config.json 읽기 실패 - 기본값($DEFAULT_SERVER_IP) 사용", e)
            DEFAULT_SERVER_IP
        }
    }
}
