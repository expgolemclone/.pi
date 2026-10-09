# WindowsでPiを使う

ChatGPT OAuth向けのPi設定. Pi 1.0.0とPowerShell 7で動作確認済み.

## セットアップ

1. Pi未導入なら `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
2. `jj`で本リポジトリを `~/.pi` にクローン.
3. `~/.agents`と, envxの配置を登録したPC用の `local-repository-map` を準備し, PowerShell 7で `./setup.ps1` を実行.
4. `pi`の `/login` でOpenAIのSign in with ChatGPTを選択.

## 運用

共通設定は `~/.agents` で管理. Kintone MCP設定, 独自圧縮, 入力待ち通知を含む. 拡張機能変更後は `/reload`.

既定でプロジェクトを信頼し, ツールはOSのユーザー権限で動作. サンドボックスなし. 認証情報と履歴は管理対象外.
