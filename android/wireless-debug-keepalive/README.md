# Wireless Debug KeepAlive

Keeps Android's **Wireless debugging** switch (`Settings.Global` key `adb_wifi_enabled`)
in the state *you* chose, for phones that quietly turn it back off. Written for a Samsung
Galaxy S26 Ultra on current Android / One UI, but there is nothing Samsung-specific in the code.

- **Package name:** `com.tdm.wirelessdebugkeepalive`
- **minSdk 30** (Android 11 — the release that introduced Wireless debugging), **compileSdk / targetSdk 36** (Android 16)
- **No root.** Nothing is patched, no other app is touched.
- **No Internet permission at all.** No analytics, no ads, no telemetry, no cloud. The
  diagnostic log lives in the app's private storage and only leaves the phone if you copy it yourself.

## What it does and does not touch

| | |
|---|---|
| Reads and writes | `Settings.Global` / `adb_wifi_enabled` only — and it only ever writes `1` |
| Never touches | `adb_enabled` (USB debugging), ADB pairing data or ADB keys, Cube ACR, any other app, any other secure setting |
| Never disables | any Android security feature |

The `WRITE_SECURE_SETTINGS` permission is granted once, by hand, over ADB. The app makes no
attempt to obtain it any other way.

## Build

```bash
cd android/wireless-debug-keepalive
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Output: `android/wireless-debug-keepalive/app/build/outputs/apk/debug/app-debug.apk`

CI (`.github/workflows/android-keepalive.yml`) runs the same two tasks on every push to the
feature branch and uploads the APK as the `wireless-debug-keepalive-debug-apk` artifact.

## Install and grant

```bash
adb install -r app-debug.apk
adb shell pm grant com.tdm.wirelessdebugkeepalive android.permission.WRITE_SECURE_SETTINGS
```

To take the permission away again:

```bash
adb shell pm revoke com.tdm.wirelessdebugkeepalive android.permission.WRITE_SECURE_SETTINGS
```

Confirm it took:

```bash
adb shell dumpsys package com.tdm.wirelessdebugkeepalive | grep -i WRITE_SECURE_SETTINGS
```

The app's main screen shows `WRITE_SECURE_SETTINGS: GRANTED` once it is in place, and prints
both commands on screen with copy buttons when it is not.

## Verify the restore actually works

With Wi-Fi connected and the **Keep Wireless Debugging On** master switch ON:

```bash
# 1. current state — expect 1
adb shell settings get global adb_wifi_enabled

# 2. simulate Samsung turning it off
adb shell settings put global adb_wifi_enabled 0

# 3. wait ~2 seconds, then read it back — expect 1 again
sleep 2; adb shell settings get global adb_wifi_enabled
```

Step 3 returning `1` is the whole test. The app's diagnostic log will show the matching pair
of lines:

```
… [SETTING]  adb_wifi_enabled changed: 1 -> 0
… [RESTORE]  Restoring adb_wifi_enabled to 1 (Wireless Debugging was turned off)
… [RESTORE]  Restore succeeded: Wireless Debugging is back ON
```

If you are on USB ADB, note that turning `adb_wifi_enabled` off does not drop your USB session,
so the test is safe to run over a cable.

## How the monitoring works

| Trigger | Behaviour |
|---|---|
| `ContentObserver` on `adb_wifi_enabled` | On a 1 → 0 transition: wait ~1 s, re-read, and only write `1` if it is *still* 0. No polling loop. |
| `ConnectivityManager.NetworkCallback` (Wi-Fi) | On Wi-Fi becoming available: if KeepAlive is on, permission is granted and the value is 0, restore it. |
| 15-minute heartbeat (in-service) and 15-minute `WorkManager` watchdog | A *read*; writes only if the value has actually gone to 0. Also restarts the service if it was killed. |
| `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` | Resumes monitoring if the master switch was on. |

### Restoring without Wi-Fi

Android's own `AdbDebuggingManager` clears `adb_wifi_enabled` when the Wi-Fi network goes
away, so a write made with no Wi-Fi connected may be reverted by the framework within a
second. That is usually *why* Wireless Debugging turns itself off.

The **Restore even without Wi-Fi** switch (on by default) makes the app try regardless.
Three seconds after every restore the app re-reads the value and logs whether it stuck:

```
… [RESTORE]  Confirmed: still ON 3s after the restore
… [RESTORE]  Android reverted adb_wifi_enabled to 0 within 3s of the restore - no Wi-Fi is connected, which is the usual cause.
```

If it turns into a losing fight, the rate limit below pauses it rather than letting the app
and the framework trade writes indefinitely. To check what your device does, from a PC with
Wi-Fi off:

```bash
adb shell settings put global adb_wifi_enabled 1
sleep 3; adb shell settings get global adb_wifi_enabled   # 1 = it sticks, 0 = framework reverted it
```

### Loop safety

- After a successful restore there is a 5-second quiet period, so the setting-change callback
  our own write provokes cannot bounce into another write.
- **A restore that holds does not count towards the limit.** Three seconds after each
  restore the app re-reads the value; if it is still 1, that attempt is dropped from the
  rate-limit window. Losing and regaining Wi-Fi all day can therefore never exhaust the
  retry budget — only writes the framework actually undoes accumulate.
- If Android forces the value back to 0 **5 times within 5 minutes**, automatic retry is
  suspended for 30 minutes and the app shows:
  *"Android repeatedly disabled Wireless Debugging."* Every attempt is timestamped in the log
  so the cause can be worked out. A **Resume automatic retry** button clears the suspension.

### Background architecture

A `specialUse` foreground service with a low-priority ongoing notification
("Wireless Debug KeepAlive is monitoring Wireless Debugging"), `START_STICKY`, and a
`WorkManager` periodic watchdog as a recovery net.

`specialUse` is deliberate rather than `dataSync`: Android 15+ applies a runtime budget to
`dataSync` and `mediaProcessing` foreground services and stops them, and those types are also on
the list Android 15+ blocks from starting off `BOOT_COMPLETED`. `specialUse` is on neither list.
The required justification is declared as `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` in the manifest.
(That property is reviewed by Google Play; it is irrelevant for a sideloaded APK.)

## Quick Settings tile

A tile called **Wireless Debug** shows the live state (Active = on, Inactive = off,
Unavailable = permission missing). Tapping it only ever tries to turn Wireless Debugging **on**,
and only when the permission is granted and Wi-Fi is connected. **It never turns it off.**

Add it from the Quick Settings panel: pull the shade down fully → pencil / "Edit buttons" →
drag **Wireless Debug** into the active area.

## Samsung / One UI setup

These are One UI menu paths and Samsung renames them between versions — **verify the wording on
your own phone**, the names below may differ on your build:

1. **Battery — the important one.**
   `Settings > Apps > Wireless Debug KeepAlive > Battery > Unrestricted`
   On some One UI versions this is `Settings > Battery > Background usage limits`, or
   `Settings > Apps > Wireless Debug KeepAlive > Battery usage > Allow background activity`.
   The in-app **"Battery / app settings for this app"** button jumps to the right screen
   without you having to find it.
2. **Never sleeping apps (if present).**
   `Settings > Battery > Background usage limits > Never sleeping apps` → add this app.
   Also check that it is *not* in **Deep sleeping apps** or **Sleeping apps**.
3. **Adaptive battery / Put unused apps to sleep.**
   `Settings > Battery > Background usage limits > Put unused apps to sleep` → off, or make
   sure this app is exempt.
4. **Notifications.** Leave the app's notification permission on. The ongoing notification is
   what keeps the foreground service alive; silencing the channel is fine, blocking it is not.
5. **Developer options.** Wireless debugging itself lives at
   `Settings > Developer options > Wireless debugging`. The in-app **Open Developer Options**
   button goes straight there where the OEM supports the standard intent, and falls back to the
   top-level Settings screen where it does not.

Things this app cannot do anything about, and which will still turn Wireless debugging off:
switching Wi-Fi off entirely, Airplane mode, and a reboot before the app has been re-granted
its permission (the grant *does* survive reboots, but not a reinstall of the app).

## Diagnostic log

Timestamped, newest first, capped at 1000 entries and mirrored to the app's private storage so
it survives a process kill. Records: setting changes, Wi-Fi up/down, restore attempts and their
outcome, missing permission, and exceptions. **Copy Log** puts the whole thing on the clipboard.

It deliberately records nothing about calls, phone numbers, Bluetooth audio, Cube ACR, or any
other personal data — only this app's own actions on one settings key.
