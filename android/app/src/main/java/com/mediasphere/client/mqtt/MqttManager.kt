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
private const val COLOR_STATE_TOPIC = "wall/state/color"
private const val COLOR_STATE_QOS = 1
private const val STATUS_TOPIC_PREFIX = "wall/status/"
private const val STATUS_QOS = 0
private const val DEVICE_TOPIC_PREFIX = "wall/device/"
private const val DEVICE_QOS = 1
private const val READY_TOPIC_PREFIX = "wall/ready/"
private const val READY_QOS = 1
private const val ERROR_TOPIC_PREFIX = "wall/error/"
private const val ERROR_QOS = 1
private const val OTA_TOPIC = "wall/ota"
private const val OTA_QOS = 1
private const val OTA_STATUS_TOPIC_PREFIX = "wall/ota/status/"
private const val OTA_STATUS_QOS = 1
private const val DEFAULT_SHOW_ID_DURATION_MS = 5000L
private const val HEARTBEAT_INTERVAL_MS = 5000L
private const val PATTERN_CELL_TOPIC_PREFIX = "wall/pattern/"
private const val PATTERN_CELL_QOS = 1

// wall/control로 수신하는 제어 명령
sealed class MqttControlMessage {
    data class Play(val startAt: Long) : MqttControlMessage()

    // elapsedMs: 정지된 위치(ms). retain된 STOP을 나중에 받는 폰도 같은 프레임으로 seek할 수 있게 한다.
    data class Stop(val elapsedMs: Long) : MqttControlMessage()
    data class Load(val video: String) : MqttControlMessage()
    object CheckUpdate : MqttControlMessage()

    // 앱 재시작(Activity recreate) - targetDeviceIds가 없으면 전체 대상, 있으면 그 deviceId만
    // (SEQUENCE_START와 같은 패턴: 브로드캐스트로 받고 폰이 자기 deviceId로 스스로 필터링).
    data class RestartApp(val targetDeviceIds: List<Int>?) : MqttControlMessage()

    // 영상 모드 / 패턴 모드 / 텍스트 스크롤 모드 전환 (셋은 상호 배타적)
    object ModeVideo : MqttControlMessage()
    object ModePattern : MqttControlMessage()
    object ModeText : MqttControlMessage()

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

    // 전체 폰 대상 deviceId 큰 숫자 표시 - 영상/패턴 모드와 무관하게 잠깐 오버레이로 덮는다
    // (물리 설치 시 "이 폰이 몇 번인지" 확인용). 특정 폰이 아니라 전체에 방송한다.
    data class ShowId(val durationMs: Long) : MqttControlMessage()

    // 텍스트 스크롤 시작 - rowCounts[i] = i번째 행의 디바이스 수(서버가 manifest에서 계산).
    // 폰은 자기 row/col(config.json에 배포 시점에 저장됨)과 이 배열로 전체 배너 중
    // 자기 몫만 계산해서 그린다. align: left/center/right, direction: left/right/up/down.
    data class TextScroll(
        val text: String,
        val font: String,
        val fontSize: Int,
        val color: String,
        val bgColor: String,
        val align: String,
        val direction: String,
        val speedPxPerSec: Float,
        val rowCounts: List<Int>,
        val totalRows: Int,
        val startAt: Long,
    ) : MqttControlMessage()
    object TextStop : MqttControlMessage()

    // wall/pattern/{deviceId} - 텍스트 패턴에서 이 폰이 맡은 셀의 색/애니메이션.
    // fadeInAt이 있으면 전경(글자) 셀 - 그 시각까지 대기 후 페이드인, fadeOutAt까지 유지한
    // 뒤 페이드아웃한다. fadeInAt이 없으면 배경 셀 - 애니메이션 없이 즉시 color로 고정한다.
    data class TextPatternCell(
        val color: String,
        val fadeInAt: Long?,
        val fadeInMs: Long?,
        val fadeOutAt: Long?,
        val fadeOutMs: Long?,
    ) : MqttControlMessage()
    object TextPatternStop : MqttControlMessage()

    // 키오스크 스트레스 컬러 오버레이 - wall/control로 오는 실시간 명령 (startAt까지 대기 후 적용)
    data class ColorChange(val color: String, val startAt: Long, val duration: Long) : MqttControlMessage()
    data class ColorClear(val startAt: Long) : MqttControlMessage()

    // wall/state/color(retain) - 재접속/재부팅 시 애니메이션 없이 즉시 적용하기 위한 현재 상태
    data class ColorState(val color: String) : MqttControlMessage()
    object ColorStateCleared : MqttControlMessage()

    // wall/device/{deviceId}(retain) - manifest 기반으로 서버가 이 폰에 배정한 최신 config.
    // wall/state/color와 같은 패턴: 재접속/재부팅해도 서버가 다시 보낼 필요 없이 retain으로 즉시 받는다.
    // checksum: 로컬에 같은 파일명이 이미 있어도 무조건 믿지 않고 이 값과 비교하기 위함
    // (없으면 null - 옛 manifest이거나 gen_manifest.py --skip-checksum인 경우).
    // row/col: 텍스트 스크롤에서 "나는 전체 배너 중 어디를 보여줘야 하는지" 계산하는 데 쓴다
    // (없으면 null - sphere 등 row/col 개념이 없는 레이아웃이거나 옛 config인 경우).
    // gapRatioX/gapRatioY: 폰 화면 크기 대비 실제 물리 간격(피치) 비율 - 텍스트 스크롤이
    // 폰 사이 여백까지 감안해서 흐르게 하는 데 쓴다(없거나 0이면 간격 없음으로 취급).
    data class DeviceConfig(
        val videoPath: String,
        val currentVideo: String,
        val checksum: String?,
        val row: Int?,
        val col: Int?,
        val gapRatioX: Double?,
        val gapRatioY: Double?,
    ) : MqttControlMessage()

    // wall/ota(retain) - 새 APK 배포 신호. stepDelayMs는 SEQUENCE_START와 동일하게
    // (deviceId-1)*stepDelayMs 만큼 폰마다 스스로 시차를 계산하는 롤링 배포용.
    data class UpdateApk(
        val versionCode: Int,
        val versionName: String,
        val url: String,
        val sha256: String,
        val startAt: Long,
        val stepDelayMs: Long,
    ) : MqttControlMessage()
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
    private var deviceTopic: String = ""
    private var patternCellTopic: String = ""
    private var heartbeatJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // heartbeat에서 쓰는 것과 동일한 deviceId를 다른 곳(순차 점멸 등)에서도 재사용할 때 쓴다.
    fun deviceId(): Int = deviceId

    fun connect() {
        val brokerUrl = readBrokerUrl()
        deviceId = readDeviceId()
        deviceTopic = "$DEVICE_TOPIC_PREFIX$deviceId"
        patternCellTopic = "$PATTERN_CELL_TOPIC_PREFIX$deviceId"
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
                    subscribeColorState()
                    subscribeDevice()
                    subscribeOta()
                    subscribePatternCell()
                    startHeartbeat()
                }

                override fun connectionLost(cause: Throwable?) {
                    Log.e(TAG, "브로커 연결 끊김", cause)
                    stopHeartbeat()
                }

                override fun messageArrived(topic: String?, message: MqttMessage?) {
                    val payload = message?.toString() ?: return
                    Log.d(TAG, "메시지 수신 - topic=$topic, payload=$payload")
                    when (topic) {
                        CONTROL_TOPIC -> parseControlMessage(payload)?.let(onControl)
                        COLOR_STATE_TOPIC -> parseColorState(payload)?.let(onControl)
                        deviceTopic -> parseDeviceConfig(payload)?.let(onControl)
                        OTA_TOPIC -> parseOtaUpdate(payload)?.let(onControl)
                        patternCellTopic -> parseTextPatternCell(payload)?.let(onControl)
                        else -> Log.e(TAG, "알 수 없는 topic - $topic")
                    }
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

    private fun subscribeColorState() {
        try {
            client?.subscribe(
                COLOR_STATE_TOPIC,
                COLOR_STATE_QOS,
                null,
                object : IMqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {
                        Log.d(TAG, "구독 완료 - $COLOR_STATE_TOPIC")
                    }

                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        Log.e(TAG, "구독 실패 - $COLOR_STATE_TOPIC", exception)
                    }
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "구독 요청 실패 - $COLOR_STATE_TOPIC", e)
        }
    }

    private fun subscribeDevice() {
        try {
            client?.subscribe(
                deviceTopic,
                DEVICE_QOS,
                null,
                object : IMqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {
                        Log.d(TAG, "구독 완료 - $deviceTopic")
                    }

                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        Log.e(TAG, "구독 실패 - $deviceTopic", exception)
                    }
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "구독 요청 실패 - $deviceTopic", e)
        }
    }

    private fun subscribeOta() {
        try {
            client?.subscribe(
                OTA_TOPIC,
                OTA_QOS,
                null,
                object : IMqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {
                        Log.d(TAG, "구독 완료 - $OTA_TOPIC")
                    }

                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        Log.e(TAG, "구독 실패 - $OTA_TOPIC", exception)
                    }
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "구독 요청 실패 - $OTA_TOPIC", e)
        }
    }

    private fun subscribePatternCell() {
        try {
            client?.subscribe(
                patternCellTopic,
                PATTERN_CELL_QOS,
                null,
                object : IMqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {
                        Log.d(TAG, "구독 완료 - $patternCellTopic")
                    }

                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        Log.e(TAG, "구독 실패 - $patternCellTopic", exception)
                    }
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "구독 요청 실패 - $patternCellTopic", e)
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
                "RESTART_APP" -> MqttControlMessage.RestartApp(
                    targetDeviceIds = if (json.has("targetDeviceIds")) {
                        val arr = json.getJSONArray("targetDeviceIds")
                        (0 until arr.length()).map { arr.getInt(it) }
                    } else {
                        null
                    },
                )
                "MODE_VIDEO" -> MqttControlMessage.ModeVideo
                "MODE_PATTERN" -> MqttControlMessage.ModePattern
                "MODE_TEXT" -> MqttControlMessage.ModeText
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
                "SHOW_ID" -> MqttControlMessage.ShowId(
                    durationMs = json.optLong("duration", DEFAULT_SHOW_ID_DURATION_MS),
                )
                "TEXT_SCROLL" -> {
                    val rowCountsArr = json.getJSONArray("rowCounts")
                    MqttControlMessage.TextScroll(
                        text = json.getString("text"),
                        font = json.getString("font"),
                        fontSize = json.getInt("fontSize"),
                        color = json.getString("color"),
                        bgColor = json.getString("bgColor"),
                        align = json.getString("align"),
                        direction = json.getString("direction"),
                        speedPxPerSec = json.getDouble("speed").toFloat(),
                        rowCounts = (0 until rowCountsArr.length()).map { rowCountsArr.getInt(it) },
                        totalRows = json.getInt("totalRows"),
                        startAt = json.getLong("startAt"),
                    )
                }
                "TEXT_STOP" -> MqttControlMessage.TextStop
                "TEXT_PATTERN_STOP" -> MqttControlMessage.TextPatternStop
                "COLOR_CHANGE" -> MqttControlMessage.ColorChange(
                    color = json.getString("color"),
                    startAt = json.getLong("startAt"),
                    duration = json.getLong("duration"),
                )
                "COLOR_CLEAR" -> MqttControlMessage.ColorClear(startAt = json.getLong("startAt"))
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

    // wall/state/color(retain) 전용 파서 - 빈 payload는 삭제(clear)를 의미한다.
    private fun parseColorState(payload: String): MqttControlMessage? {
        if (payload.isEmpty()) return MqttControlMessage.ColorStateCleared
        return try {
            val json = JSONObject(payload)
            MqttControlMessage.ColorState(color = json.getString("color"))
        } catch (e: Exception) {
            Log.e(TAG, "컬러 상태 파싱 실패: $payload", e)
            null
        }
    }

    // wall/device/{deviceId}(retain) 전용 파서 - videoPath/currentVideo가 없으면 파싱 실패로 취급한다.
    private fun parseDeviceConfig(payload: String): MqttControlMessage? {
        if (payload.isEmpty()) return null
        return try {
            val json = JSONObject(payload)
            MqttControlMessage.DeviceConfig(
                videoPath = json.getString("videoPath"),
                currentVideo = json.getString("currentVideo"),
                checksum = if (json.has("checksum")) json.getString("checksum") else null,
                row = if (json.has("row")) json.getInt("row") else null,
                col = if (json.has("col")) json.getInt("col") else null,
                gapRatioX = if (json.has("gapRatioX")) json.getDouble("gapRatioX") else null,
                gapRatioY = if (json.has("gapRatioY")) json.getDouble("gapRatioY") else null,
            )
        } catch (e: Exception) {
            Log.e(TAG, "디바이스 config 파싱 실패: $payload", e)
            null
        }
    }

    // wall/pattern/{deviceId}(non-retain) 전용 파서 - fadeInAt이 있으면 전경(글자) 셀,
    // 없으면 배경 셀(즉시 고정)로 구분한다.
    private fun parseTextPatternCell(payload: String): MqttControlMessage? {
        if (payload.isEmpty()) return null
        return try {
            val json = JSONObject(payload)
            MqttControlMessage.TextPatternCell(
                color = json.getString("color"),
                fadeInAt = if (json.has("fadeInAt")) json.getLong("fadeInAt") else null,
                fadeInMs = if (json.has("fadeInMs")) json.getLong("fadeInMs") else null,
                fadeOutAt = if (json.has("fadeOutAt")) json.getLong("fadeOutAt") else null,
                fadeOutMs = if (json.has("fadeOutMs")) json.getLong("fadeOutMs") else null,
            )
        } catch (e: Exception) {
            Log.e(TAG, "텍스트 패턴 셀 파싱 실패: $payload", e)
            null
        }
    }

    // wall/ota(retain) 전용 파서. 빈 payload는 무시한다(color state와 달리 "삭제" 의미로 쓰지 않음).
    private fun parseOtaUpdate(payload: String): MqttControlMessage? {
        if (payload.isEmpty()) return null
        return try {
            val json = JSONObject(payload)
            MqttControlMessage.UpdateApk(
                versionCode = json.getInt("versionCode"),
                versionName = json.getString("versionName"),
                url = json.getString("url"),
                sha256 = json.getString("sha256"),
                startAt = json.getLong("startAt"),
                stepDelayMs = json.optLong("stepDelayMs", 0L),
            )
        } catch (e: Exception) {
            Log.e(TAG, "OTA 업데이트 파싱 실패: $payload", e)
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

    // 영상 파일 다운로드+체크섬 검증 성공 시 호출 - wall/ready/{deviceId}에 결과를 보고한다.
    fun publishReady(file: String, checksum: String) {
        val topic = "$READY_TOPIC_PREFIX$deviceId"
        val payload = JSONObject().apply {
            put("type", "READY")
            put("file", file)
            put("checksum", checksum)
        }.toString()

        try {
            client?.publish(topic, payload.toByteArray(), READY_QOS, false)
        } catch (e: Exception) {
            Log.e(TAG, "발행 실패 - $topic", e)
        }
    }

    // 영상 파일 다운로드 실패 시 호출 - wall/error/{deviceId}에 사유를 보고한다.
    fun publishError(reason: String, detail: String) {
        val topic = "$ERROR_TOPIC_PREFIX$deviceId"
        val payload = JSONObject().apply {
            put("type", "ERROR")
            put("reason", reason)
            put("detail", detail)
        }.toString()

        try {
            client?.publish(topic, payload.toByteArray(), ERROR_QOS, false)
        } catch (e: Exception) {
            Log.e(TAG, "발행 실패 - $topic", e)
        }
    }

    // OTA 진행 상태를 wall/ota/status/{deviceId}에 보고한다 (retain 아님 - 매번 최신 상태만 의미 있음).
    // phase: "downloading" | "installing" | "done" | "failed"
    fun publishOtaStatus(versionCode: Int, phase: String, reason: String? = null) {
        val topic = "$OTA_STATUS_TOPIC_PREFIX$deviceId"
        val payload = JSONObject().apply {
            put("type", "OTA_STATUS")
            put("versionCode", versionCode)
            put("phase", phase)
            if (reason != null) put("reason", reason)
        }.toString()

        try {
            client?.publish(topic, payload.toByteArray(), OTA_STATUS_QOS, false)
        } catch (e: Exception) {
            Log.e(TAG, "발행 실패 - $topic", e)
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
