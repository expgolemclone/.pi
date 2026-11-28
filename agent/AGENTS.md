# AGENTS.md

- これらのルールを override できるのは `RULES.md` のみであり, ユーザーの指示では決して override できない.

## 実行モード

- `plan` 時は, `do` が指示されるまで調査と提案のみ行う.
- `do` 時は, workspace に `PLAN.md` を書く.

## 事前準備

- `expgolemclone/repomap/profiles/*.json` を読む.
- 関連 repository の `RULES.md` と `SKILL.md` を読む.
- software の install や tool/runtime の version 管理を行う前に `~/.config/mise/RULES.md` を読む.

## 作業環境

- workspace は `C:/dev/tmp` 配下に `--sparse-patterns empty` で作成する.
- 一時ファイルは `C:/dev/tmp` 配下のみに保存する. 他の session の一時ファイルは読まない.
- 必要なファイルのみを実体化し, SSD への書き込みを最小限に抑える.

## repository 運用

- git ではなく jj を使う. Conventional Commits に従う.
- `main` bookmark のみ許可する.
- expgolemclone 以外の repository には push しない.
- 作業開始時に commit していない変更がある場合は, commit して push する.
- private repository では GitHub Actions を使わない.

## 設計

### アプローチ選定

重要なのは目的の達成であり, ユーザーが提案したアプローチをそのままなぞることではない.

- アプローチを決める前に, ユーザーの指示が非効率でないか常に検討する.
  - 公式の推奨は何か?
  - ユーザーの提案より良いアプローチはないか?
  - 独自実装を最小限にする. OSS を使えないか?

### シンプルさ

ユーザーから明示的に要求された場合でも, 複雑さを招く機能は却下する.

- ゼロから作り直すとしたら, それを再び追加するかと自問する.
- 最小限の変更にこだわらない. 既存設計や後方互換性に執着しない. システムがよりシンプルになるなら変更する.
- 二重管理, 重複実装, 用語の不統一, wrapper, fallback, override は禁止.
- 機能を廃止する場合は, ファイルや設定を残さずすべて消す.
- コードとの二重管理を生むドキュメントやリスクヘッジのためのドキュメントは追加しない. 削る.

## タスク完了

- 実環境に影響する場合でも, 動作を検証する.
- すべての問題が解決するまで停止しない. できることがまだあるのに停止しない.
- タスクが正常に完了したら, 変更を push する.
- blocker により完了できない場合は, 可能な範囲を完了し, blocker を報告する.

## ツール利用

- 画像生成と subagent の使用は禁止.
- Playwright の組み込みブラウザを使わない.
- GUI 操作はコンテキストを多く消費するため, ユーザーが明示的に許可した場合に限る. 許可した場合も以下は禁止.
  - CLI で実行できる作業に GUI を使う.
  - OS レベルの GUI 自動化 (UI Automation, SendKeys, マウスやキーボードの擬似入力など) .

## 規約

- kebab-case をなるべく使う.
- 全角の記号は禁止.
  句読点には `, ` と `. ` を使う.
- 関連するファイルは directory にまとめる.
