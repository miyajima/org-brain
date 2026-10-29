---
name: OrgBrain Console
description: 組織の知識と利用状況を確認する運用画面
colors:
  primary: "#0071e3"
  primary-hover: "#0066cc"
  link: "#0066cc"
  text: "#1d1d1f"
  muted: "#62626a"
  background: "#f5f5f7"
  surface: "#ffffff"
  line: "#dcdce1"
  rail: "#eeeef1"
  selected: "#e8f2ff"
  secondary-text: "#333336"
  danger: "#a82432"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif'
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  title:
    fontSize: "1.125rem"
    fontWeight: 650
    lineHeight: 1.45
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif'
    fontSize: "16px"
    lineHeight: 1.6
  button:
    fontWeight: 600
    lineHeight: 1.4
rounded:
  small: "4px"
  field: "6px"
  control: "7px"
  detail: "9px"
  panel: "10px"
  dialog: "12px"
spacing:
  "8": "8px"
  "10": "10px"
  "16": "16px"
  "18": "18px"
  "24": "24px"
  "36": "36px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 17px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary-text}"
    rounded: "{rounded.control}"
    padding: "9px 17px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "#515154"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "9px 17px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  navigation:
    backgroundColor: "{colors.rail}"
    padding: "30px 18px 20px"
    width: "214px"
  navigation-active:
    backgroundColor: "{colors.selected}"
    textColor: "#0066cc"
    rounded: "{rounded.control}"
    padding: "11px 14px"
  badge:
    backgroundColor: "#eeeef1"
    textColor: "#515154"
    rounded: "{rounded.small}"
    padding: "3px 7px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
---

# Design System: OrgBrain Console

## Overview

**Creative North Star: "蓄積された知識と実際の利用を確認できる"**

運用担当者が内容を読み、状態を見分け、必要な箇所を整えるための視覚体系。白と薄い灰色の面、濃い文字、抑えた青のアクセントを使う。面は平坦に保ち、罫線、余白、文字の強弱でまとまりを示す。

この文書は現在の `apps/console/src/styles/operator.css` とOperatorLayoutを記録する。旧画面の黒い背景、ガラス状のレール、浮き上がるカードは、新しい主要画面の視覚基準にしない。業務パック・指標・振り返り・改善は新しい管理画面内に統合する。旧専用導入画面、graph、labなどの補助画面にも共通シェルとスタイルを適用するが、内部構成まで統一済みとは扱わない。

**Key Characteristics:**

- 白・灰色の平坦な面と濃い文字。
- 青による主要操作と選択状態の識別。
- 日本語の読みやすさと、見える操作状態。
- PCの常設ナビゲーションと、モバイルの上部ナビゲーション。

## Colors

変更前からの黒・白・グレーと青の指定を継承する。主アクセントは青、本文と補助情報は色味を抑えたニュートラルグレーで分ける。値の正本はfrontmatterであり、CSSを変更した際は両方を照合する。sidecarの色見本には表示用に補間した明度差を含むが、追加の実装色は定義しない。

### Primary

- **青** (`primary`): 主要ボタン、フォーカス、選択タブの下線に使う。ホバー時は `primary-hover` を使う。リンクと選択中の文字には、薄い背景でも読みやすい `link` を使う。
- **選択面の薄い青** (`selected`): 主ナビゲーションの現在位置に使う。

### Neutral

- **濃い本文色** (`text`): 見出し、本文、入力内容。
- **補助文字の灰色** (`muted`): 説明、更新日時、補助情報。
- **薄い背景色** (`background`): ワークスペース全体。
- **白い面** (`surface`): パネル、入力欄、上部バー。
- **境界の灰色** (`line`): 面と行の区切り。
- **レールの灰色** (`rail`): 常設ナビゲーションの背景。

### Status

危険操作には `danger` を使う。確認済みは淡い緑、警告・未確認・期限切れは淡い黄、失敗・停止は淡い赤のバッジで示す。色に加えて状態名を表示する。具体的なバッジ配色はCSSとsidecarの例を参照する。

## Typography

**Display Font:** 見出し専用フォントは設けず、本文と共通のシステムフォントを使う。
**Body Font:** frontmatterの日本語対応システムサンセリフ。
**Label/Mono Font:** ラベルも本文と共通。登録コードなど内容が固定幅表示を必要とする箇所はmonospace。

見出しは短く、本文は読み続けられる行間を確保する。数値と日時は必要な箇所で等幅数字を使う。

### Hierarchy

- **Headline** (`headline`): ページの主見出し。モバイルでは1.5remへ縮小する。
- **Title** (`title`): パネルの見出し。詳細対象のタイトルは20pxを使う。
- **Body** (`body`): 基本文字。詳細本文は15px・行間1.9・最大75ch、ページ説明は最大65ch。
- **Label**: フォームラベルは主に13px、補助情報は12–14px。バッジは11px。
- **Button** (`button`): 文字を太くして操作を識別する。

## Layout

PCでは左に常設レール、右に上部バーと作業領域を置く。通常のレール幅はfrontmatterの `navigation.width`。作業領域は最大1600px、通常の外側余白は36px。1600px以上では外側余白を44px・52pxへ広げる。

1100px以下ではレールを176pxへ縮め、主領域の余白を28px・24pxにする。760px以下ではレールを上部の3項目ナビゲーションへ変え、主領域の余白を26px・18pxにする。知識画面の一覧と詳細はPCでは並置し、モバイルでは選択状態に応じて一方を表示する。

パネル間の間隔は主に24px、内部余白は主に18–26px。詳細タブと管理項目は幅に収まらない場合に横スクロールできる。ページ固有の情報構成は [Console operator UX](docs/CONSOLE_OPERATOR_UX.md) を参照する。

## Elevation & Depth

通常のパネルは影を付けず、白い面と細い境界線で区切る。選択された知識行には内側の細い強調線を使う。確認ダイアログだけに外側の影と背景の暗転がある。影や透過素材を通常の情報階層に使わない。

### Shadow Vocabulary

- **確認ダイアログ** (`0 15px 50px #1d1d1f29`): 対象と変更内容を確認するモーダル。
- **選択行の内側線** (`inset 0 0 0 1px #87b4e5`): 一覧内で選択された対象の識別。

## Shapes

角は控えめに丸める。入力欄は `field`、ボタンと主ナビゲーションは `control`、知識の一覧・詳細は `detail`、一般パネルは `panel`、確認ダイアログは `dialog` を使う。境界線は通常1px。アバターには円形を使う。

## Components

### Buttons

主要操作は塗りつぶし、補助操作は白地の枠線、軽い操作は透明背景で区別する。

- **Shape:** `control` の角丸。通常の最小高さは44px。
- **Primary:** `button-primary`。ホバーは `button-primary-hover`。
- **Secondary / Quiet:** frontmatterの該当variant。補助ボタンの枠線は `#bfbfc5`、ホバーは `#f5f5f7`。
- **Danger:** 白地と危険色の文字、`#dfb7bd` の枠線。ホバーは `#fff0f1`。
- **Focus:** 3pxの青のoutlineと3pxのoffset。無効時は不透明度を下げ、処理中のcursorを表示する。

### Chips

状態バッジは `badge` の小さな矩形を使う。中立、確認済み、警告、失敗を文字と配色で区別する。操作用チップと状態表示を混同しない。

### Cards / Containers

一般パネルは `panel`。白地、1pxの境界線、通常時は影なし。ヘッダーと本文の余白で区切り、不要な入れ子で面を増やさない。

### Inputs / Fields

白い面と `#b8b8c0` の枠線を使う。ラベルを置き、placeholderだけに説明を任せない。通常の最小高さは44px。textareaは最小140pxで縦方向に拡大できる。エラーや保存結果はフォームの状態欄で文字として伝える。

### Navigation

主ナビゲーションは「ホーム・知識・管理」。通常は15px、モバイルは12pxの文字とアイコンを使う。現在位置は背景と文字の強弱、`aria-current` で示す。知識詳細のタブは下線、管理項目は背景で選択状態を示す。

### Knowledge List and Detail

一覧では短いタイトル、要約、状態、プロジェクト、日時をまとめる。選択された行には背景と内側線を付ける。詳細本文は折り返し、読みやすい幅に収める。モバイルでは一覧へ戻る操作を表示する。

### Motion and Accessibility

ボタンの背景変化は0.16秒のease-out。`prefers-reduced-motion` ではtransitionを無効にする。forced colorsでは選択項目にoutline、状態バッジに枠線を付ける。本文へのスキップリンクを用意する。これらの実装は、操作試験やアクセシビリティ適合の認定とは区別する。

## Do's and Don'ts

### Do:

- **Do** 白・灰色の面、濃い文字、青の主要操作を共通して使う。
- **Do** 選択、警告、失敗を文字と視覚状態の両方で示す。
- **Do** 通常のボタンと入力欄に44px以上の最小高さを確保する。
- **Do** 長文を折り返し、本文の行幅と行間を維持する。

### Don't:

- **Don't** 旧画面の黒い背景やガラス状のレールを新しい主要画面へ戻す。
- **Don't** 通常のパネルに装飾的な影やグラデーションを追加する。
- **Don't** 色だけで状態や操作の意味を伝える。
- **Don't** 共通スタイルの適用を、専門フォームの構成まで統一済みと表現する。
