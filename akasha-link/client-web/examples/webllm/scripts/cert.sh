#!/bin/bash
# mkcert 証明書生成（LAN 配信用）
#
# - LAN IP を引数で明示指定: npm run cert -- <MacのLAN IP>
# - 省略時はアクティブな LAN インターフェース（デフォルトルート）を自動検出
set -e

LAN_IP="${1:-}"
if [ -z "$LAN_IP" ]; then
  # デフォルトルートのインターフェースを特定（en0 固定ではない）
  IFACE="$(route get default 2>/dev/null | awk '/interface:/{print $2}')"
  if [ -n "$IFACE" ]; then
    LAN_IP="$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)"
  fi
fi

if [ -z "$LAN_IP" ]; then
  echo "❌ LAN IP を自動検出できませんでした。明示的に指定してください:"
  echo "   npm run cert -- <MacのLAN IP>"
  echo "   （例: npm run cert -- 192.168.0.17）"
  exit 1
fi

mkdir -p .cert
mkcert -cert-file .cert/cert.pem -key-file .cert/key.pem localhost "$LAN_IP"
echo "✅ 証明書生成完了 (localhost + $LAN_IP)"
echo "   iPhone からは https://$LAN_IP:4174 でアクセス"
