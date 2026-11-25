#!/bin/bash
# Kern3D Станок: cage shows one program full screen; Chromium in kiosk mode on the station page.
# /opt/kern3d-station/rotate holds the turn (0/90/180/270, set from the station's settings). cage
# in Debian has no rotate option, so the output is turned with wlr-randr inside the session.
exec 2>>/tmp/kiosk.log
TURN=$(cat /opt/kern3d-station/rotate 2>/dev/null || echo 0)
case "$TURN" in 90 | 180 | 270) TRANSFORM=$TURN ;; *) TRANSFORM=normal ;; esac
export KERN3D_TRANSFORM=$TRANSFORM
exec cage -- /bin/sh -c '
    OUT=$(wlr-randr 2>/dev/null | awk "/^[^ ]/ {print \$1; exit}")
    [ -n "$OUT" ] && wlr-randr --output "$OUT" --transform "$KERN3D_TRANSFORM"
    exec chromium --kiosk --noerrdialogs --disable-infobars --no-first-run \
        --disable-session-crashed-bubble --check-for-update-interval=31536000 \
        --ozone-platform=wayland --enable-features=OverlayScrollbar \
        --user-data-dir=/home/station/.kern3d-station-chromium --remote-debugging-port=9222 \
        http://localhost:8080/station.html
'
