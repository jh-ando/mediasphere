package com.mediasphere.client

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/**
 * MainActivity를 띄울 인텐트. 이 앱이 기본 홈 앱으로 고정돼 있으면(Device Owner 설치) 홈
 * 인텐트를, 아니면(개발 폰 등) 지금처럼 명시적 실행 인텐트를 돌려준다.
 *
 * 홈 인텐트로 띄워야 화면이 "홈"으로 떠서 앱이 죽었을 때 시스템이 다시 띄워준다. 명시적으로
 * 띄우면 MainActivity가 홈 방식으로 다시 실행하는 한 단계를 더 거쳐야 한다
 * (MainActivity.relaunchAsHomeIfNeeded() 주석 참고) - 부팅/원격 재시작/OTA 직후/정비 자동 복귀가
 * 모두 이걸 쓴다.
 */
object AppLaunch {
    fun homeIntent(): Intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)

    fun isPinnedHome(context: Context): Boolean {
        val resolved = context.packageManager.resolveActivity(homeIntent(), PackageManager.MATCH_DEFAULT_ONLY)
        return resolved?.activityInfo?.packageName == context.packageName
    }

    fun mainIntent(context: Context): Intent =
        if (isPinnedHome(context)) homeIntent() else Intent(context, MainActivity::class.java)
}
