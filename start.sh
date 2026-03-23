#!/data/data/com.termux/files/usr/bin/bash
export NODE_OPTIONS="--no-deprecation"

trap 'echo -e "\n\033[1;31m[!] Stopping FusionMusic completely...\033[0m"; pkill -9 -f node; pkill -9 -f ssh; exit 0' SIGINT SIGTERM EXIT

mkdir -p database
clear
echo -e "\033[1;36m┌──────────────────────────────────────┐\033[0m"
echo -e "\033[1;36m│          FusionMusic v11.3           │\033[0m"
echo -e "\033[1;36m│   (Anti-Skip & Back Button Fixes)    │\033[0m"
echo -e "\033[1;36m└──────────────────────────────────────┘\033[0m"

echo -e "\033[1;31m>>> Destroying old ghost processes...\033[0m"
killall -9 node 2>/dev/null
pkill -9 -f node 2>/dev/null
pkill -9 -f ssh 2>/dev/null
fuser -k 5555/tcp 2>/dev/null
sleep 1

# THE CRITICAL FIX: Automatically update yt-dlp to bypass YouTube's newest stream blocks
echo -e "\033[1;33m>>> Updating streaming engine (bypassing YouTube blocks)...\033[0m"
pip install -U yt-dlp > /dev/null 2>&1 || yt-dlp -U > /dev/null 2>&1

while true; do
    echo -e "\033[1;32m✓ Starting Server Engine on Port 5555...\033[0m"
    node server.js &
    NODE_PID=$!
    
    sleep 2
    echo -e "\n\033[1;36m>>> Connecting to Serveo (fusionhubmusic)...\033[0m"
    
    ssh -R fusionhubmusic:80:127.0.0.1:5555 serveo.net 2> /dev/null | grep --line-buffered "https://" | \
    while read -r line; do
        echo -e "\n\033[1;32m🚀 FusionMusic is LIVE!\033[0m"
        echo -e "\033[1;36m🌐 Public Link:\033[0m ${line}"
        echo -e "\033[1;36m📱 Local Wi-Fi:\033[0m http://192.168.1.4:5555"
        echo -e "\033[1;33m(Keep this Termux window open)\033[0m"
    done
    
    kill -9 $NODE_PID 2>/dev/null
    echo -e "\n\033[1;31m⚠ Connection dropped. Restarting loop in 3s...\033[0m"
    sleep 3
done
