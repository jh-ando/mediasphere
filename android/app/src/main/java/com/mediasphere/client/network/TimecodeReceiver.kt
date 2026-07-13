package com.mediasphere.client.network

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket

private const val TAG = "[UDP]"
private const val MULTICAST_ADDR = "239.0.0.1"
private const val MULTICAST_PORT = 5000
private const val RECEIVE_BUFFER_SIZE = 512

// 서버가 브로드캐스트하는 타임코드 패킷 { type, masterMs, elapsedMs, startAt }
// PLAY/STOP 제어는 더 이상 이 패킷에 실리지 않는다 - MqttManager가 wall/control로 별도 수신한다.
data class Timecode(
    val type: String,
    val masterMs: Long,
    val elapsedMs: Long,
    val startAt: Long,
)

/**
 * 마스터 서버가 239.0.0.1:5000 으로 보내는 타임코드를 수신한다.
 * WifiManager.MulticastLock을 획득하지 않으면 패킷이 조용히 버려지고
 * 에러도 발생하지 않으므로 반드시 start() 시점에 락을 잡아야 한다.
 */
class TimecodeReceiver(
    context: Context,
    private val onTimecode: (Timecode) -> Unit,
) {
    private val appContext = context.applicationContext
    private var multicastLock: WifiManager.MulticastLock? = null
    private var socket: MulticastSocket? = null
    private var job: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    fun start() {
        // 1단계: MulticastLock 획득 (없으면 패킷이 조용히 버려지고 에러도 안 남)
        Log.e(TAG, "[1/5] MulticastLock 획득 시도")
        try {
            val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifiManager.createMulticastLock("mediasphere-multicast-lock").apply {
                setReferenceCounted(true)
                acquire()
            }
            Log.e(TAG, "[1/5] MulticastLock 획득 성공 - isHeld=${multicastLock?.isHeld}")
        } catch (e: Exception) {
            Log.e(TAG, "[1/5] MulticastLock 획득 실패", e)
            return
        }

        job = scope.launch {
            var multicastSocket: MulticastSocket? = null
            try {
                // 2단계: 멀티캐스트 그룹 주소 확인
                Log.e(TAG, "[2/5] 그룹 주소 확인 시도 - $MULTICAST_ADDR")
                val group = InetAddress.getByName(MULTICAST_ADDR)
                Log.e(TAG, "[2/5] 그룹 주소 확인 성공 - $group")

                // 3단계: MulticastSocket 생성 (포트 바인딩)
                Log.e(TAG, "[3/5] MulticastSocket 생성 시도 - port=$MULTICAST_PORT")
                multicastSocket = MulticastSocket(MULTICAST_PORT)
                Log.e(
                    TAG,
                    "[3/5] MulticastSocket 생성 성공 - localAddress=${multicastSocket.localAddress}, " +
                        "localPort=${multicastSocket.localPort}, networkInterface=${multicastSocket.networkInterface}",
                )

                // 4단계: 그룹 참가
                Log.e(TAG, "[4/5] joinGroup 시도 - $group")
                multicastSocket.joinGroup(group)
                socket = multicastSocket
                Log.e(TAG, "[4/5] joinGroup 성공 ($MULTICAST_ADDR:$MULTICAST_PORT)")

                // 5단계: 패킷 수신 대기 루프
                Log.e(TAG, "[5/5] 패킷 수신 대기 시작")
                val buffer = ByteArray(RECEIVE_BUFFER_SIZE)
                while (true) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    Log.e(TAG, "[5/5] receive() 블로킹 대기 중...")
                    multicastSocket.receive(packet)
                    Log.e(
                        TAG,
                        "[5/5] 패킷 수신 성공 - from=${packet.address}:${packet.port}, length=${packet.length}",
                    )

                    val raw = String(packet.data, 0, packet.length)
                    val timecode = parseTimecode(raw) ?: continue
                    Log.e(TAG, "타임코드 파싱 성공 - masterMs=${timecode.masterMs}, elapsedMs=${timecode.elapsedMs}")
                    onTimecode(timecode)
                }
            } catch (e: Exception) {
                Log.e(TAG, "수신 루프 중 예외 발생: ${e.message}", e)
            } finally {
                Log.e(TAG, "수신 루프 종료 - socket closed=${multicastSocket?.isClosed}")
            }
        }
    }

    private fun parseTimecode(raw: String): Timecode? {
        return try {
            val json = JSONObject(raw)
            Timecode(
                type = json.getString("type"),
                masterMs = json.getLong("masterMs"),
                elapsedMs = json.getLong("elapsedMs"),
                startAt = json.getLong("startAt"),
            )
        } catch (e: Exception) {
            Log.e(TAG, "패킷 파싱 실패: $raw", e)
            null
        }
    }

    fun stop() {
        job?.cancel()
        try {
            socket?.leaveGroup(InetAddress.getByName(MULTICAST_ADDR))
        } catch (e: Exception) {
            Log.e(TAG, "그룹 탈퇴 실패: ${e.message}", e)
        }
        socket?.close()
        multicastLock?.release()
        Log.d(TAG, "수신 종료 및 MulticastLock 해제")
    }
}
