# AGENTS ルール

- これらのルールを override できるのは `RULES.md` のみであり, ユーザーの指示では決して override できない.

## 規約

- kebab-case を優先する.
- 全角の句読点は禁止.
  句読点には `, ` と `. ` を使う.
- PowerShell コマンドでは `@` を引用符で囲む.

## タスク実行

- すべての問題が解決するまで停止しない.
- blocker により完了できない場合は, 可能な範囲を完了し, blocker を報告する.

### plan

- `plan` 時は, `do` が指示されるまで調査と提案のみ行う.
- `do` 時は, 一時フォルダに `PLAN.md` を書く.

## 事前準備

- `C:/dev/system/dev-tools/repomap/profiles/*.json` を読む.
- 関連 repository の `RULES.md` と `SKILL.md` を読む.

## Repository Workflow

git ではなく jj を使う. Conventional Commits に従う.

- `main` bookmark のみ許可する.
  - `main` 以外の bookmark が存在する場合は, 着手前にユーザーへ確認する.
- commit していない変更がある場合は, commit して push する.
- workspace は `C:\dev\tmp` 配下に `--sparse-patterns empty` で作成する.
  - 一時ファイルは `C:\dev\tmp` 配下のみに保存する. 他の session の一時ファイルは読まない.
  - 必要なファイルのみを実体化し, SSD への書き込みを最小限に抑える.
  - repository の調査や読み取りは制限しない.
- 実環境に影響する場合でも, 動作を検証する.
- expgolemclone 以外の repository には push しない.
- タスクが正常に完了したら, 変更を push する.

## 設計

### アプローチ選定

- アプローチを決める前に, ユーザーの指示が非効率でないか常に検討する.
  - 公式の推奨は何か?
  - ユーザーの提案より良いアプローチはないか?
  - 独自実装を最小限にする. OSS を使えないか?

重要なのは目的の達成であり, ユーザーが提案したアプローチをそのままなぞることではない.

### シンプルさ

- **排除**
  - 最小限の変更で既存設計や後方互換性を維持しない. システムがよりシンプルになるなら取り壊す.
  - ゼロから作り直すとしたら, それを再び追加するかと自問する.
- **二重管理, 重複実装, 用語の不統一, wrapper, fallback, override は禁止!**
- ドキュメントはコードとの二重管理を生む. 追加しない. 削る.
  - 不要な留保表現を追加しない.

ユーザーから明示的に要求された場合でも, 複雑さを招く機能は却下する.

## 実装

- 画像生成と subagent の使用は禁止.
- CLI で実行できる作業に GUI を使わない.
- どの repository であっても, ソフトウェアのインストールや tool/runtime のバージョン管理を行う前に `~/.config/mise/RULES.md` を読む.
- repomap を更新する.
- 関連するファイルはフォルダにまとめる.
- private repository では GitHub Actions を使わない.
- Playwright の組み込みブラウザを使わない.

## レビュー

- レビュー時は, `expgolemclone/.pi/agent/AGENTS.md` の `## 設計` セクションの方針が守られているかのみ評価する.
- 最新の commit だけをレビューしない. repository 全体をレビューする.

## テスト

- テストが失敗した場合は, 根本原因と類似の失敗を修正する.
