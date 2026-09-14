#Requires AutoHotkey v2.0
#SingleInstance Force

; ─────────────────────────────────────────────────────────────────────────────
;  Trade Journal — global marking hotkeys
;
;  These work while Tradovate has focus, browser or desktop app, because they
;  are registered with Windows rather than with a web page. A page only receives
;  keypresses while its own tab is focused, which yours is not while you trade.
;
;  Setup:
;    1. Install AutoHotkey v2 from https://www.autohotkey.com
;    2. Start the recorder:  node scripts/serve.mjs
;    3. Double-click this file. A green "H" appears in the system tray.
;    4. Click "Start recording" in the browser tab, then trade.
;
;  Starting a recording cannot be a hotkey: the browser requires a real click in
;  the page before it will hand over the screen. Stopping one is fine.
;
;  To change a key, edit the lines at the bottom. In AutoHotkey:
;    ^ = Ctrl    ! = Alt    + = Shift    # = Windows key
; ─────────────────────────────────────────────────────────────────────────────

SERVER := "http://localhost:5173"
SHOW_CONFIRMATION := true     ; brief on-screen confirmation for each mark
CONFIRMATION_MS := 700

; ── the hotkeys ──────────────────────────────────────────────────────────────

^!e::Mark("entry")                             ; Ctrl+Alt+E   entry
^!x::Mark("exit")                              ; Ctrl+Alt+X   exit
^!n::Mark("note")                              ; Ctrl+Alt+N   note

^!l::Mark("entry", { direction: "long" })      ; Ctrl+Alt+L   long entry
^!s::Mark("entry", { direction: "short" })     ; Ctrl+Alt+S   short entry

^!q::StopRecording()                           ; Ctrl+Alt+Q   stop the session

; ─────────────────────────────────────────────────────────────────────────────
;  Everything below is plumbing.
; ─────────────────────────────────────────────────────────────────────────────

Mark(kind, extra := "") {
    global SHOW_CONFIRMATION

    body := '{"command":"mark","kind":"' kind '"'
    if (IsObject(extra)) {
        for key, value in extra.OwnProps()
            body .= ',"' key '":"' value '"'
    }
    body .= '}'

    result := Post(body)
    if (!SHOW_CONFIRMATION)
        return

    if (result.ok && result.delivered > 0)
        Toast(StrUpper(SubStr(kind, 1, 1)) SubStr(kind, 2) " marked")
    else if (result.ok)
        Toast("Nothing received it — is the recorder tab open?", 2500)
    else
        Toast("Not marked: " result.error, 3000)
}

StopRecording() {
    result := Post('{"command":"stop"}')
    if (result.ok && result.delivered > 0)
        Toast("Recording stopped", 1200)
    else
        Toast("Could not reach the recorder tab", 2500)
}

/**
 * Posts a command to the bridge.
 *
 * Content-Type must be application/json — the server rejects anything else, so
 * that a web page you happen to be visiting cannot quietly inject markers.
 */
Post(body) {
    global SERVER

    try {
        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.Open("POST", SERVER "/bridge/mark", false)
        http.SetRequestHeader("Content-Type", "application/json")
        ; Short timeouts: a hotkey must never hang the keyboard if the server
        ; is not running. (resolve, connect, send, receive)
        http.SetTimeouts(1000, 1000, 1000, 2000)
        http.Send(body)

        response := http.ResponseText
        delivered := 0
        if (RegExMatch(response, '"delivered":(\d+)', &m))
            delivered := Integer(m[1])

        if (http.Status = 200)
            return { ok: true, delivered: delivered, error: "" }

        error := "server said " http.Status
        if (RegExMatch(response, '"error":"([^"]+)"', &m))
            error := m[1]
        return { ok: false, delivered: 0, error: error }
    } catch as err {
        return { ok: false, delivered: 0, error: "server not running" }
    }
}

/**
 * A small confirmation near the top of the screen. NoActivate matters: marking
 * must never steal focus from your platform mid-trade.
 */
Toast(text, ms := 0) {
    global CONFIRMATION_MS
    static current := ""

    if (ms = 0)
        ms := CONFIRMATION_MS

    ; Clear any toast still on screen from a previous mark.
    if (IsObject(current)) {
        try current.Destroy()
        current := ""
    }

    box := Gui("+AlwaysOnTop +ToolWindow -Caption +E0x20")
    box.BackColor := "1c232c"
    box.MarginX := 18
    box.MarginY := 12
    box.SetFont("s10 cFFFFFF", "Segoe UI")
    box.Add("Text", "", text)
    box.Show("NoActivate AutoSize y60")
    current := box

    ; Destroy this specific toast, not whichever is current when the timer
    ; fires — two quick marks would otherwise cut the second one short.
    SetTimer(() => CloseToast(box), -ms)
}

CloseToast(box) {
    try box.Destroy()
}

; Tray icon, so it is obvious the script is running and easy to stop.
A_IconTip := "Trade Journal hotkeys — Ctrl+Alt+E / X / N"
TraySetIcon("shell32.dll", 138)
