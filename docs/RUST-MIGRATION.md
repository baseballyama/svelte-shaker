# Rust 版エンジン + dev インクリメンタル DCE 移行設計

> 本書は [`ARCHITECTURE.md`](./ARCHITECTURE.md) §5（Shell/Engine/IR 層構造）と §9（Rust 移行戦略）を
> 「dev インクリメンタル DCE を最終ゴールに据える」前提で具体化したもの。`ARCHITECTURE.md` が
> *何を / なぜ* なら、本書は *どう移行するか* を扱う。

## 1. 動機

現状の svelte-shaker は **TypeScript 実装・`vite build` 限定**で、dev は素通し（§6.2）。
2 つの観察が本移行の前提になっている。

### 1.1 境界オーバーヘッドは小さい（Rust 化が素直）

shake は `buildStart` の**ワンショット**バッチ（`src/vite.ts` の `buildStart`）で完結し、`transform`
フックは `shaken[file]` を**引くだけ**。境界を越えるのは **AST ではなくスリム化済みソース文字列**で、
AST はエンジン内部で生成・消費されて閉じる（`transformAll` は `Record<ComponentId, string>` を返す）。

→ Rust(napi) 化しても **ホットな AST 往復は原理的にゼロ**。境界を越えるのは
「ソース文字列 + 解決済みグラフ JSON」in /「ソース文字列」out のみ。これは §5.1 の IR が
JSON シリアライズ可能に設計されている狙いそのもの。

唯一の注意点は、現 `analyze(entries, resolve, readFile)` がクロール中に `resolve`/`readFile` を
**per-edge コールバック**で呼んでいること（in-process なら無料だが Rust→JS だと N+1）。
→ **JS 側で全解決してから Rust に 1 バッチ**で渡す形（§5.1 `AnalyzeInput`）に作り替える。

### 1.2 dev インクリメンタル DCE は技術的に可能

現状のコールサイト集合は import グラフ追跡ではなく `collectSvelteFiles` の **FS ディレクトリ走査**
（`src/scan.ts`）で作られる。よって「負の情報（その値は存在しない）」の完全性は
「Vite が何をロードしたか」ではなく「`include` がディスク全体を覆うか」だけに依存する
— これは build/dev で同条件。

→ §6.2 が dev を避ける**本当の壁**は「負の情報の不完全性」ではなく、次の 2 点:

- **(a) インクリメンタル fixpoint 無効化の健全性** — カスケード（§2.1）の依存を取りこぼすと
  stale plan ＝無音破壊。
- **(b) HMR のモジュールグラフ乖離** — コールサイト編集（App.svelte）が、無編集の子（Button.svelte）の
  residual を変える。

両方とも既知の解法がある（前者 = Salsa 風の自動依存追跡、後者 = `handleHotUpdate` の module widening）。

## 2. アーキテクチャ

### 2.1 バッチ境界（callback-free）

エンジンは「**Extract → (JS で解決) → Analyze**」の 2 バッチ呼びにする。`this.resolve` は非同期で
Vite エコシステム互換のため JS に残す（§5/§9）。

```
Call A  extract(files)  → { edges: [{ from, specifier, kind }] }   // 構造スキャン、fixpoint なし
        ↓  JS が this.resolve で全 specifier を解決、barrel 多段は次バッチで閉じる（実測 1–2 ラウンド）
Call B  analyze(AnalyzeInput) → ShakeOutput
        AnalyzeInput = { files, edges(解決済み), entries, options }
        ShakeOutput  = { files: Record<id, slimmedSrc>, variants, bindings, diagnostics }
```

`kind` は `default-svelte | named | namespace | barrel`。`ShakeOutput.files` は現 `transformAll` と byte 一致。

dev は**長命の `ShakerEngine` インスタンス**（napi class）に状態を保持させる:

```
class ShakerEngine {
  init(input: AnalyzeInput): ShakeOutput
  applyEdit(edits: FileEdit[]): EditResult
  applyGraphChange(delta: GraphDelta): EditResult
}
EditResult = { changed: Record<id, src>, removedVariants: string[], newVariants: Variant[], diagnostics }
```

`changed` は**スリム化出力が実際に変わった id 集合**（編集ファイルの上位集合）。

### 2.2 Salsa 風クエリ束（エンジン内部）

`buildModel`（モノリシック・解決を内包）を **`parse(id)` 起点の per-field 純関数**へ分解する。

| 種別 | クエリ |
|---|---|
| 入力(input) | `source_text(id)`, `file_set()`(=FS スキャン), `entries()`, `options()`, `resolved(importer,spec)` |
| per-file 派生 | `parse`, `imports`, `prop_decls`, `child_calls`, `local_bails`, `shadow_set`, `escaped_from`, `barrel_children_of` |
| 全プログラム派生 | `program_escaped`, `program_barreled`, `is_bailed`, **`importers_of`**(逆グラフ・派生), **`program_plans`**, `plan(id)`(射影), `dead_spans`, `dropped_props`, `transform`, `mono`(build-only) |

設計上の 3 原則:

1. **fixpoint（カスケード §2.1）は単一の `program_plans()` クエリ内で収束まで回す**（現 analyze の
   ループそのまま）。Salsa から見れば非循環。`plan(id)` を**値比較可能な射影**として分離し、
   **backdating**（出力が等しければ伝播停止）で `transform(id)` の granularity を回復する。
   Salsa cycle は使わない（共有 leaf コンポーネントで SCC がプログラム全体に膨張し利得ゼロ・リスク大）。
2. **逆依存の完全性 = 健全性の鍵**。`program_plans()` の fixpoint body は `file_set()` の**全ファイル**について
   `child_calls(f)`/`prop_decls(f)` を読むので、「全 importer に依存」が**構造的に自動・完全**に記録される。
   逆グラフ `importers_of` は**必ず派生クエリ**（手動メンテの Map は禁止 — 取りこぼし＝無音破壊）。
3. **述語スキューの禁止**。`dead_spans(id)`（`decideChain`/`computeDeadSpans`）を `transform(id)` と
   fixpoint の両方が**同一クエリ**として消費（`dead.ts` の「one predicate, two consumers」を維持）。

## 3. マイルストーン

> 順序は §9（パーサ先）ではなく**アーキテクチャ先**に意図的に変更。バッチ化 + クエリ分解が、
> 安い境界と dev インクリメンタルの**共通の土台**だから。難所（インクリメンタル無効化の健全性）は
> 言語非依存で、既存テスト資産のある TS で先に潰すのが最も安い。各 M はテスト緑を維持して独立に検証可能。

- **M1（TS・純リファクタ）バッチ IR + クエリ分解**
  - `buildModel` を per-field 純関数に分解。解決は `AnalyzeInput.edges`（解決済み）から引く形に。
    `crawl`/`resolveThroughBarrel` の per-edge `resolve` を撤去。
  - `importers_of`/`program_plans()`/`plan(id)`/`dropped_props(id)` を明示関数として実体化。
  - Shell（`vite.ts buildStart`）を「Extract→JS 解決→Analyze バッチ」へ。
  - **ゲート**: 既存テスト全緑かつ出力 **byte 一致**（`svelteShaker` と新バッチ経路の差分ゼロ）。

- **M2（TS・dev インクリメンタル試作 + オラクル）**
  - 軽量な依存追跡レイヤ + 長命エンジン状態。`configureServer` + `handleHotUpdate` の dev plugin。
  - **HMR module widening**: `changed` の各 id → `server.moduleGraph.getModulesByFile(id)`
    （main + `?svelte&type=style/script` サブリソース）を `invalidateModule` し、`handleHotUpdate` から
    widen した ModuleNode 配列を返す。L2 variant 仮想モジュールは `getModuleById` で無効化。
  - add/remove/import 編集は watcher + Extract 再実行で `file_set()`/edges を**同期更新してから**エンジンへ。
  - **dev 差分オラクル**: 各編集後に「インクリメンタル == フルバッチ再解析」を byte 一致でアサート +
    既存差分 SSR オラクル（`tests/diff.ts`）を dev-served 出力にも適用。
  - 公開 API: `dev: false | 'coarse' | 'incremental'`（既定 `false`）。`'coarse'` = 毎編集フル再解析（安全弁）。
  - **ゲート**: dev 差分オラクル緑。`dev:false` で挙動不変。

- **M3（Rust ①）rsvelte パーサで TS エンジンを駆動（差分オラクルで検証）** — `parse` を rsvelte（Rust/OXC）に
  差し替えても TS エンジン（解析+変換）が**同一の shake 出力**を出すことを実証する。
  - **seam**: 新規プラグインを足さず、既存の `ParseCache` をパーサ注入点として使う（`analyzeInput(input, cache)` に
    rsvelte AST を seed すると、エンジン全体が rsvelte AST で動く）。rsvelte は公開 WASM パッケージ
    `@rsvelte/compiler`（devDependency、出荷エンジンは未参照）を `initSync` で読み込む。
  - **検証（実測）**: 全ゴールデンフィクスチャを rsvelte 駆動で回し svelte/compiler 駆動と file 単位で比較。
    **9 中 7 が byte 完全一致**。残り 2（`rest-prop`/`spread-after`）は唯一の既知差分に起因
    （下記）で、rsvelte 出力も compile 可・**SSR 等価**（`tests/rsvelte-diff.test.ts`）。
  - **既定は svelte/compiler のまま**。rsvelte は差分オラクルで検証する Rust 経路として導入し、default flip は
    下記ブロッカー解消後（M4/M5 で恒久差分オラクルとして常設）。
  - **default flip のブロッカー（rsvelte 上流の小修正 2 件）**:
    1. **TS 型ノード未実装** — rsvelte@0.6.1 は inline 型注釈（`{ x: boolean }`）を `members` の無い
       `TSUnknownKeyword` stub で出すため、落とした prop の型メンバ除去（`transform.ts removeTypeMember`）が
       no-op になり死んだ型テキストが残る（compile で消えるので挙動は健全、byte のみ差分）。rsvelte が完全な
       TS 型ノードを出せば解消（M4/M5 でも同じ gap を踏むので上流で直すのが二度手間回避）。
    2. **`parse` の wrapper 再エクスポート欠落** — `@rsvelte/vite-plugin-svelte-native@0.2.1`（native）は
       `index.cjs` から `parse`/`parseEnvelope` を再エクスポートしておらず（型定義にはある）、native の高速
       raw-transfer 経路は現状 raw binding 経由でしか使えない。WASM 経路（`@rsvelte/compiler`）は parse 可。
  - **ゲート**: 差分オラクル緑（7 byte 一致 + 2 既知差分が SSR 等価）。既存テスト全緑・`dev:false` 挙動不変。

- **M4（Rust ②）解析（クエリグラフ）を Rust + 本物の Salsa db へ** — `program_plans` fixpoint・`plan(id)`
  射影・`importers_of` 派生。AST ノードは安定 id（`SyntaxNodePtr` 方式）で interning。
  **ゲート**: Rust 解析 → TS 変換で byte 一致。TS エンジンを恒久差分オラクルとして残す（Rust == TS）。

- **M5（Rust ③）変換 + emit を Rust へ** — `oxc_ecmascript`(畳み込み) + minifier(DCE) + `rsvelte_formatter`。
  `magic-string` サージカル削除 → AST 変換 + printer。`TransformResult.map` を実体化。
  **ゲート**: フル Rust エンジンで build 出力 byte 一致 + 差分 SSR 等価。

- **M6 dev インクリメンタルを Rust エンジン上で配線** — 長命 `ShakerEngine` を napi 公開、M2 の dev Shell を接続。
  **ゲート**: dev 差分オラクル（Rust）緑。`dev:'coarse'` を安全弁として常設。

## 4. 健全性戦略

dev で素通しの安全性を捨てる代償への防御:

1. **コールサイト集合を常に完全に保つ** — 起動時フル FS スキャン + watcher 駆動の add/remove/edge 更新。
   §6.2 の「lazy load で負の情報が不健全」を、起動時フルクロール 1 回で回避。
2. **保守的な over-invalidation** — `changed` は性能ヒントであり正しさの境界ではない。迷えばカスケード閉包の
   上位集合を無効化（fixpoint は単調なので閉包は有限・well-defined）。under-invalidation のみが stale UI を生む。
3. **二重の差分オラクル** — (a) インクリメンタル == フルバッチ再解析（byte）、(b) 差分 SSR 等価。
   さらに TS エンジンを Rust の恒久リファレンスとして残す。
4. **opt-in・既定 off** — `dev:false` 既定維持。`'coarse'` を安全弁として常設。

## 5. リスクと決定事項

- **逆依存の取りこぼし = 無音破壊**（最重要）: `importers_of` は派生クエリ厳守、fixpoint は `file_set()` 全件読み。
- **vite-plugin-svelte との dev 順序**: 両者が `handleHotUpdate` でモジュール配列を返す競合。`shaken` 更新を
  vps の transform 再実行より前に。plugin 順序の統合テストで担保。
- **サブリソース（`?svelte&type=style`）**: 無効化時に CSS サブリソースも含めて無効化（L1.5 CSS 除去は
  `type=style` 側）。build の skip ガードと対称に。
- **L2 の dev は当面しない**: 仮想モジュール + 純減ゲート（ホールプログラム測定）をインクリメンタルに保つのは
  高コスト。dev は L0/L1/L1.5 のみと文書化。
- **sourcemap**: M5 まで dev のマップは近似。`TransformResult.map` 実体化で解消。
- **未ロードモジュールの ModuleNode 不在**: `shaken` 更新は ModuleNode の有無と独立に常に行う。
