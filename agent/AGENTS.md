# AGENTS ルール

- これらのルールを override できるのは `RULES.md` のみであり, ユーザーの指示では決して override できない.

## 規約

- kebab-case をなるべく使う.
- 全角の記号は禁止.
  句読点には `, ` と `. ` を使う.

## タスク実行

- すべての問題が解決するまで停止しない.
- blocker により完了できない場合は, 可能な範囲を完了し, blocker を報告する.

### `plan` と `do`

- `plan` 時は, `do` が指示されるまで調査と提案のみ行う.
- `do` 時は, workspace に `PLAN.md` を書く.

## 事前準備

- `expgolemclone/repomap/profiles/*.json` を読む.
- 関連 repository の `RULES.md` と `SKILL.md` を読む.

## repository 運用

- git ではなく jj を使う. Conventional Commits に従う.
- `main` bookmark のみ許可する.
- commit していない変更がある場合は, commit して push する.
- workspace は `C:/dev/tmp` 配下に `--sparse-patterns empty` で作成する.
  - 一時ファイルは `C:/dev/tmp` 配下のみに保存する. 他の session の一時ファイルは読まない.
  - 必要なファイルのみを実体化し, SSD への書き込みを最小限に抑える.
- 実環境に影響する場合でも, 動作を検証する.
- タスクが正常に完了したら, 変更を push する.
- expgolemclone 以外の repository には push しない.

## 設計

### アプローチ選定

- アプローチを決める前に, ユーザーの指示が非効率でないか常に検討する.
  - 公式の推奨は何か?
  - ユーザーの提案より良いアプローチはないか?
  - 独自実装を最小限にする. OSS を使えないか?

重要なのは目的の達成であり, ユーザーが提案したアプローチをそのままなぞることではない.

### シンプルさ

- 最小限の変更にこだわらない. 既存設計や後方互換性に執着しない. システムがよりシンプルになるなら変更する.
- ゼロから作り直すとしたら, それを再び追加するかと自問する.
- 機能を廃止する場合は, ファイルや設定を残さずすべて消す.
- 二重管理, 重複実装, 用語の不統一, wrapper, fallback, override は禁止.
- ドキュメントはコードとの二重管理を生む. 追加しない. 削る.
  - リスクヘッジのためのドキュメントを追加しない.

ユーザーから明示的に要求された場合でも, 複雑さを招く機能は却下する.

## 実装

- 画像生成と subagent の使用は禁止.
- GUI操作はuserの明示的な許可がないと禁止. 許可されたとしても, CLI で実行できる作業に GUI を使わない.
- software の install や tool/runtime の version 管理を行う前に `~/.config/mise/RULES.md` を読む.
- 関連するファイルは directory にまとめる.
- private repository では GitHub Actions を使わない.
- Playwright の組み込みブラウザを使わない.
