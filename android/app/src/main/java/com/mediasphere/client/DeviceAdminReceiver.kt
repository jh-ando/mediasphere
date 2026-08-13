package com.mediasphere.client

import android.content.Context
import android.content.Intent
import android.util.Log

private const val TAG = "[DeviceAdmin]"

/**
 * dpm set-device-owner 로 이 앱을 Device Owner로 등록하기 위한 최소 구성요소.
 * 실제로 이 클래스가 뭘 하는 건 없다 - Device Owner "상태" 자체가
 * UpdateManager의 PackageInstaller 무인 설치(setRequireUserAction(false))를
 * 가능하게 해주는 것이지, 이 리시버가 어떤 정책을 강제하는 게 아니다.
 *
 * 등록 절차(1회, 폰이 공장초기화 상태거나 계정이 하나도 없어야 성공):
 *   adb shell dpm set-device-owner com.mediasphere.client/.DeviceAdminReceiver
 */
class DeviceAdminReceiver : android.app.admin.DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        Log.d(TAG, "Device Admin 활성화됨")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.d(TAG, "Device Admin 비활성화됨")
    }
}
