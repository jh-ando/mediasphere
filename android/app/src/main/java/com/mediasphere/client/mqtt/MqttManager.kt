package com.mediasphere.client.mqtt

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.eclipse.paho.client.mqttv3.IMqttActionListener
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.IMqttToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import org.json.JSONObject
import java.io.File

private const val TAG = "[MQTT]"
private const val CONFIG_PATH = "/sdcard/mediasphere/config.json"
private const val DEFAULT_BROKER_URL = "tcp://192.168.0.1:1883"
private const val DEFAULT_DEVICE_ID = -1
private const val CONTROL_TOPIC = "wall/control"
private const val CONTROL_QOS = 1
private const val STATUS_TOPIC_PREFIX = "wall/status/"
private const val STATUS_QOS = 0
private const val HEARTBEAT_INTERVAL_MS = 5000L

// wall/control로 수신하는 제어 명령
sealed class MqttControlMessage {
    data class Play(val startAt: Long) : MqttControlMessage()

    // elapsedMs: 정지된 위치(ms). retain된 STOP을 나중에 받는 폰도 같은 프레임으로 seek할 수 있게 한다.
    data class Stop(val elapsedMs: Long) : MqttControlMessage()
    data class Load(val video: String) : MqttControlMessage()
    object CheckUpdate : MqttControlMessage()

    // 영상 모드 / 패턴 모드 전환
    object ModeVideo : MqttControlMessage()
    object ModePattern : MqttControlMessage()

    // 패턴(점멸) 시작 - color는 "#RRGGBB" 형태의 원본 문자열 그대로 전달한다.
    data class PatternStart(val color: String, val interval: Long, val duration: Long, val startAt: Long) :
        MqttControlMessage()
    object PatternStop : MqttControlMessage()

    // 순차 점멸 시작 - 폰마다 deviceId 순서대로 stepDelay만큼 늦게 시작한다.
    data class SequenceStart(
        val color: String,
        val interval: Long,
        val duration: Long,
        val stepDelay: Long,
        val startAt: Long,
        val totalDevices: Int,
    ) : MqttControlMessage()
    object SequenceStop : MqttControlMessage()
}

/**
 * 서버(Mosquitto)와 연결해 wall/control 토픽을 구독한다.
 * config.json의 mqttBroker 값을 사용하며, 연결이 끊기면 Paho의 자동 재연결에 맡긴다.
 */
class MqttManager(
    private val onControl: (MqttControlMessage) -> Unit,
) {
    private var client: MqttAsyncClient? = null
    private var deviceId: Int = DEFAULT_DEVICE_ID
    private var heartbeatJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // heartbeat에서 쓰는 것과 동일한 deviceId를 다른 곳(순차 점멸 등)에서도 재사용할 때 쓴다.
    fun deviceId(): Int = deviceId

    fun connect() {
        val brokerUrl = readBrokerUrl()
        deviceId = readDeviceId()
        val clientId = "mediasphere-${System.currentTimeMillis()}"

        try {
            val mqttClient = MqttAsyncClient(brokerUrl, clientId, MemoryPersistence())
            client = mqttClient

            // MqttCallbackExtended의 connectComplete()는 최초 연결뿐 아니라 자동 재연결 성공 시에도
            // 호출되므로, 구독/heartbeat 재시작을 여기 한 곳에서 처리한다.
            mqttClient.setCallback(object : MqttCallbackExtended {
                override fun connectComplete(reconnect: Boolean, serverURI: String?) {
                    Log.d(TAG, if (reconnect) "브로커 재연결 성공 - $serverURI" else "브로커 연결 성공 - $serverURI")
                    subscribeControl()
                    startHeartbeat()
                }

                override fun connectionLost(cause: Throwable?) {
                    Log.e(TAG, "브로커 연결 끊김", cause)
                    stopHeartbeat()
                }

                override fun messageArrived(topic: String?, message: MqttMessage?) {
                    val payload = message?.toString() ?: return
                    Log.d(TAG, "메시지 수신 - topic=$topic, payload=$payload")
                    parseControlMessage(payload)?.let(onControl)
                }

                override fun deliveryComplete(token: IMqttDeliveryToken?) {}
            })

            val options = MqttConnectOptions().apply {
                isAutomaticReconnect = true
                isCleanSession = true
                connectionTimeout = 10
                keepAliveInterval = 30
            }

            Log.d(TAG, "브로커 연결 시도 - $brokerUrl")
            mqttClient.connect(
                options,
                null,
                object : IMqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {}

                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        Log.e(TAG, "브로커 연결 실패 - $brokerUrl", exception)
                    }
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "MQTT 클라이언트 초기화 실패", e)
        }
    }

    private fun subscribeControl() {
        try {
            client?.subscribe(
                CONTROL_TOPIC,
                CONTROL_QOS,
                null,
                object : IMqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {
                        Log.d(TAG, "구독 완료 - $CONTROL_TOPIC")
                    }

                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        Log.e(TAG, "구독 실패 - $CONTROL_TOPIC", exception)
                    }
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "구독 요청 실패 - $CONTROL_TOPIC", e)
        }
    }

    private fun parseControlMessage(payload: String): MqttControlMessage? {
        return try {
            val json = JSONObject(payload)
            when (json.getString("type")) {
                "PLAY" -> MqttControlMessage.Play(startAt = json.getLong("startAt"))
                "STOP" -> MqttControlMessage.Stop(elapsedMs = json.optLong("elapsedMs", 0L))
                "LOAD" -> MqttControlMessage.Load(video = json.optString("video"))
                "CHECK_UPDATE" -> MqttControlMessage.CheckUpdate
                "MODE_VIDEO" -> MqttControlMessage.ModeVideo
                "MODE_PATTERN" -> MqttControlMessage.ModePattern
                "PATTERN_START" -> MqttControlMessage.PatternStart(
                    color = json.getString("color"),
                    interval = json.getLong("interval"),
                    duration = json.getLong("duration"),
                    startAt = json.getLong("startAt"),
                )
                "PATTERN_STOP" -> MqttControlMessage.PatternStop
                "SEQUENCE_START" -> MqttControlMessage.SequenceStart(
                    color = json.getString("color"),
                    interval = json.getLong("interval"),
                    duration = json.getLong("duration"),
                    stepDelay = json.getLong("stepDelay"),
                    startAt = json.getLong("startAt"),
                    totalDevices = json.getInt("totalDevices"),
                )
                "SEQUENCE_STOP" -> MqttControlMessage.SequenceStop
                else -> {
                    Log.e(TAG, "알 수 없는 type - $payload")
                    null
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "메시지 파싱 실패: $payload", e)
            null
        }
    }

    // config.json에서 mqttBroker 값을 읽는다. 실패하면 기본값을 사용한다.
    private fun readBrokerUrl(): String {
        return try {
            val json = JSONObject(File(CONFIG_PATH).readText())
            json.getString("mqttBroker")
        } catch (e: Exception) {
            Log.e(TAG, "config.json 읽기 실패 - 기본값($DEFAULT_BROKER_URL) 사용", e)
            DEFAULT_BROKER_URL
        }
    }

    // config.json에서 deviceId 값을 읽는다. 실패하면 기본값을 사용한다.
    private fun readDeviceId(): Int {
        return try {
            val json = JSONObject(File(CONFIG_PATH).readText())
            json.getInt("deviceId")
        } catch (e: Exception) {
            Log.e(TAG, "config.json 읽기 실패 - deviceId 기본값($DEFAULT_DEVICE_ID) 사용", e)
            DEFAULT_DEVICE_ID
        }
    }

    // 5초마다 wall/status/{deviceId}에 heartbeat를 발행한다. 중복 시작을 막기 위해 먼저 정리한다.
    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatJob = scope.launch {
            while (isActive) {
                publishHeartbeat()
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
        Log.d(TAG, "heartbeat 발행 시작 - deviceId=$deviceId")
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun publishHeartbeat() {
        val topic = "$STATUS_TOPIC_PREFIX$deviceId"
        val payload = JSONObject().apply {
            put("deviceId", deviceId)
            put("status", "online")
            put("timestamp", System.currentTimeMillis())
        }.toString()

        try {
            // retain: false - heartbeat는 매번 새로 오는 값이 의미 있으므로 남겨둘 필요 없음
            client?.publish(topic, payload.toByteArray(), STATUS_QOS, false)
        } catch (e: Exception) {
            Log.e(TAG, "heartbeat 발행 실패 - $topic", e)
        }
    }

    fun disconnect() {
        stopHeartbeat()
        scope.cancel()
        try {
            client?.disconnect()
        } catch (e: Exception) {
            Log.e(TAG, "연결 종료 실패", e)
        }
    }
}
