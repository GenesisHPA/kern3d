#!/bin/bash
# Kern3D Станок: cage shows one program full screen; Chromium in kiosk mode on the station page.
# /opt/kern3d-station/rotate holds the turn (0/90/180/270, set from the station's settings): one -r per 90°.
TURN=$(cat /opt/kern3d-station/rotate 2>/dev/null || echo 0)
ROTATE=()
for _ in $(seq 1 $(( ${TURN:-0} / 90 ))); do ROTATE+=("-r"); done
exec cage "${ROTATE[@]}" -- chromium --kiosk --noerrdialogs --disable-infobars --no-first-run \
    --disable-session-crashed-bubble --check-for-update-interval=31536000 \
    --ozone-platform=wayland --enable-features=OverlayScrollbar \
    --user-data-dir=/home/station/.kern3d-station-chromium \
    http://localhost:8080/station.html
