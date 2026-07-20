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
    widen した ModuleNode 配列を返す。monomorphization variant 仮想モジュールは `getModuleById` で無効化。
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
  - **（M3 時点では）既定は svelte/compiler のまま**。rsvelte は差分オラクルで検証する Rust 経路として導入し、
    default flip は下記ブロッカー解消後（M4/M5 で恒久差分オラクルとして常設）。**→ ブロッカー全解消後、PR12 で
    parser 既定を `'rsvelte'` に flip し必須 peer 化（下記 §「上流修正後の再検証」／§3-2）。**
  - **default flip のブロッカー（rsvelte 上流修正 3 件 → 全て✅解決済み。compiler 0.7.6 / native 0.2.3。
    実速度は §6「上流修正後の再検証」: skipExpressionLoc 経路で実フル 1.46x）**:
    0. ✅**【最重要・健全性】AST span が UTF-8 バイトオフセット**（[rsvelte#793](https://github.com/baseballyama/rsvelte/issues/793)・**修正済**）—
       rsvelte は node の `start`/`end` を **UTF-8 バイト**で出すが、svelte/compiler・magic-string・JS エンジン全体は
       **UTF-16 コードユニット**。ASCII のみなら一致するので**フィクスチャ（全 ASCII）では露見しない**が、非 ASCII
       （日本語 UI 文字列＝nexus 全域）を含む実ファイルでは以降の span が全てズレ、誤った置換 or
       `MagicString end is out of bounds` で**ハードクラッシュ**（実コーパス 474 ファイルで即発生）。**WASM・native 両方**。
       ①②と違いこれは**正しさのバグ**（サイレント破損）。UTF-16 への remap が必須（OXC は内部 byte → svelte は出力時に
       UTF-16 変換している。rsvelte も同じ remap が要る）。**これが解けない限り rsvelte parse は実コーパスで使えない**。
    1. ✅**TS 型ノード未実装**（[rsvelte#791](https://github.com/baseballyama/rsvelte/issues/791)・**修正済**）— rsvelte@0.6.1 は
       inline 型注釈（`{ x: boolean }`）を `members` の無い `TSUnknownKeyword` stub で出すため、落とした prop の
       型メンバ除去（`transform.ts removeTypeMember`）が no-op になり死んだ型テキストが残る（compile で消えるので
       挙動は健全、byte のみ差分）。**WASM `parse_svelte`・native `parse` の両方**が同じ stub を出す（共有エミッタ）。
       rsvelte が完全な TS 型ノードを出せば解消（M4/M5 でも同じ gap を踏むので上流で直すのが二度手間回避）。
    2. ✅**`parse` の wrapper 再エクスポート欠落**（[rsvelte#792](https://github.com/baseballyama/rsvelte/issues/792)・**修正済**）—
       0.2.1 では `index.cjs` から `parse`/`parseEnvelope` が再エクスポートされておらず `parse-envelope.js`
       （`decodeParseEnvelope`）も未出荷だった。0.2.3 で両方 export + decoder 出荷済み。
  - **残課題（新規・envelope 経路のみ）**: [rsvelte#908](https://github.com/baseballyama/rsvelte/issues/908) — `decodeParseEnvelope`
    が **typed-arrow body のサブツリーで byte offset のまま**（#793 の envelope 取りこぼし）。非 ASCII + 型付き arrow で破損
    （318/474 file）。**JSON 経路（`parse`）は正常**なので実用上は JSON + skipExpressionLoc で 1.46x が得られる。envelope は
    #908 解決後の上積み。
  - **ゲート**: 差分オラクル緑（408/474 byte 一致 + 66 は SSR 等価な AST パリティ差）。既存テスト全緑・`dev:false` 挙動不変。

- **M4（Rust ②）解析を Rust → WASM へ（差分オラクルで段階検証）**
  - **配布形態 = WASM（決定済み）**: `@rsvelte/compiler` と同方式。Rust エンジンは **rsvelte_core 非依存・自己完結**
    （JS が parse → AST JSON を WASM に渡す → Rust は `serde_json` で解析）。重いコンパイラ crate 依存・git dep・
    ネイティブ prebuild infra を回避し、クロスプラットフォーム単一 `.wasm`。`wasm-pack --target nodejs`
    （Node ビルド時に同期ロード、init 不要）。crate は `packages/svelte-shaker/engine-rs/`、成果物 `pkg/` は
    **commit**（CI はツールチェーン不要で committed wasm をロード）。
  - **段階検証**: 解析は `plans`（§5.1 IR）を出すので **Rust plans == TS plans を差分比較**できる。スライスごとに
    移植 → TS と差分比較 → 緑、を繰り返す（M3 と同じオラクル手法）。
  - **実装済み: per-file `FileModel` を完全移植**（全フィクスチャの実グラフ + 実 Svelte 構文で **Rust == TS** を
    `tests/wasm-m4.test.ts` が担保）: 宣言 props、`hasRestProp`、`collectTemplateBindings`（shadowed/debug =
    fold-blocked 名、`addPatternNames` 再帰）、`<svelte:options>` bail、`collectChildCalls`（解決済み edge から
    imports 再構築 + span）、`collectBarrelChildIds`、`collectEscapedComponents`（`isValueUse` の parent 文脈含む）。
  - **実装済み: whole-program 集約も完全移植**。`eval.rs`（`Literal` enum `Str`/`Num`/`Bool`/`Null`/`Undefined` +
    JS 演算子セマンティクスの `evaluate` + Kleene 三値の `evaluate_with_sets`、`eval.test.ts` 相当を cargo で担保）と、
    `readCallSite`/`valueSetFor`/`buildPlan`/`buildUsage`+fixpoint/`decideChain`+`computeDeadSpans`/`plansEqual` を移植。
    `analyze_program(input with ASTs) → plans JSON`。**全 9 フィクスチャの実グラフで full `plans`（constFold/narrow/
    valueSets/bail/reasons）== TS plans** を `tests/wasm-program.test.ts` が担保（cascade の fixpoint・spread の top・
    narrow 値集合・dead-span 込み）。`undefined` は `{$undefined:true}` センチネルで JSON 境界を越える。
    → **M4（解析）の Rust 移植は完了**。
  - 残り: 次は **M5 変換+emit を Rust へ**（fold/DCE/CSS/属性除去/再印字）。出力 byte 一致 + 差分 SSR で検証。
  - **既知の付随発見**: svelte/compiler の `<svelte:options>` は `root.options`（type 無し・`fragment` 外）に入るため、
    `analyze.ts` の `fragment` を `SvelteOptions` で walk する accessors/customElement bail は現状の AST では発火
    しない可能性がある（既存ギャップ。Rust は analyze.ts を忠実移植したので両者一致＝consistent）。別途
    failing test 先行で扱う。
  - **将来**: 解析全体が揃ったら Salsa db 化（`program_plans` fixpoint・`plan(id)` 射影・`importers_of` 派生、
    AST ノードは安定 id で interning）。**ゲート**: Rust plans == TS plans（全フィクスチャ）。TS エンジンを恒久差分
    オラクルとして残す。CI に `cargo test` + `build:wasm`（pinned toolchain）ジョブ追加は follow-up。

- **M5（Rust ③）変換 + emit を Rust へ — 完了**。`transform.ts` + `css.ts` を Rust に移植し、`magic-string` 相当の
  `MagicEdit`（**UTF-16 単位**の span エディタ。non-ASCII でも健全。後勝ち overlap で `drop` が先行 substitute を
  supersede）でサージカル削除/上書き。`decide_chain` を解析と共有（fold が食い違わない）。`shake_program(input with
  ASTs + code) → {id: slimmedSrc}` = 解析 + 変換のフルエンジン。**全 9 フィクスチャ + non-ASCII で Rust 出力 ==
  TS `svelteShaker` 出力（byte 一致）+ compile 可**（`tests/wasm-shake.test.ts`）。
  → **エンジン全体（解析+変換+emit+CSS）の Rust/WASM 移植は完了**。unused-prop fold / constant fold / value-set narrowing のみ（monomorphization/sourcemap は後続）。

- **M6 dev インクリメンタルを Rust エンジンで検証 — 完了**。content-keyed parse キャッシュ（変更ファイルのみ
  再パース）+ `shake_program`(Rust/WASM) で編集列（callsite 編集 / add / remove / leaf 編集）を駆動し、各ステップで
  TS `svelteShaker` と **byte 一致**（`tests/wasm-dev.test.ts`。add で un-shake・remove で re-shake のカスケード込み）。
  → dev インクリメンタルフローが Rust エンジンで正しいことを実証。

---

## 移行ステータス（M1–M6 完了）

検証済みの Rust 移行は完了。全マイルストーンが差分オラクルで TS と一致を担保:

| M | 内容 | 検証 |
|---|---|---|
| M1 | バッチ境界（純粋 `analyzeInput` / Shell `buildAnalyzeInput`） | byte 一致 |
| M2 | dev インクリメンタル + `DevShaker` + `handleHotUpdate` widening | 差分オラクル + 実 Vite |
| M3 | rsvelte(Rust)パースで TS エンジン駆動 | 9 中 7 byte 一致 / 2 既知 TS 差分は SSR 等価 |
| M4 | 解析を Rust→WASM（値集合束・fixpoint・dead-span・eval） | 全フィクスチャで plans == TS |
| M5 | 変換+emit+CSS を Rust→WASM（`MagicEdit` UTF-16） | 全フィクスチャ + non-ASCII で出力 == TS |
| M6 | dev インクリメンタルを Rust エンジンで | 編集列で出力 == TS |

**エンジン全体（解析+変換+emit+CSS, unused-prop fold / constant fold / value-set narrowing）が Rust/WASM で TS と byte 一致**。`engine-rs/`（自己完結・
rsvelte_core 非依存・serde_json + wasm-bindgen）、`@rsvelte/compiler`(WASM) は差分オラクルの parse 比較用 devDep。

### プロダクション化の follow-up（本移行のスコープ外・要メンテナ判断）

検証は完了したが、Rust エンジンを**出荷経路**にするのは別判断（後戻りしにくい）:

1. **WASM 成果物の出荷 + 既定エンジンの切替**: 現状 `engine-rs/pkg` は commit のみで npm 未出荷（`files: dist`）。
   byte 一致なので健全性ギャップは無いが、**速度目的では非推奨**：エンジン本体は全体の ~15%（183ms）に過ぎず、
   WASM 化は境界マーシャリングで逆に遅くなる（§6）。Rust エンジンは「TS との恒久差分オラクル＝健全性の二重化」
   としての価値に留める。
2. ✅**rsvelte パース（native）の採用**（M3）— **実装済み（opt-in）**。上流修正 **4 件（#791/#792/#793/#916）は全て解決済み**
   （compiler 0.7.8 / native 0.2.4）。実測で **native `parse({skipExpressionLoc:true})` + `JSON.parse` がフル 1.46x**（§6）。
   - **`parser: 'rsvelte'`（当初 opt-in・既定 `svelte`。PR12 で既定化）** を Vite プラグインに追加。`Parse` 注入を
     `parseCached`→`buildAnalyzeInput`→`svelteShaker`/`svelteShakerWithMono`/`DevShaker` に通し、crawl と analysis で
     **共有 cache に 1 parse/file**。
   - **必ず `skipExpressionLoc: true`**（loc 込みだとフル 0.72x まで沈む。エンジンは start/end しか見ないので出力は不変）。
   - native は **必須 peer**（PR12 で optional 解除）。**読めない時は throw**（既定 `parser:'rsvelte'` の silent fallback は
     「native 有無でバンドルが変わる」再現性の罠なので避ける。`parser:'svelte'` が明示フォールバック）。
   - **健全性検証済み**: native 駆動の実コーパス **474/474 が compile 可**、svelte 差 22 は全て「native の方がよく shake」（SSR 等価）。
   - **既定 flip 済み（PR12）**: parser 既定を `'rsvelte'` に変更。再現性のため未導入時は throw（`parser:'svelte'` が明示
     オプトアウト）。環境フリー API とブラウザ playground は native を要求できないため `svelte/compiler` のまま（境界）。
   - **envelope（さらに上積み）は [#908](https://github.com/baseballyama/rsvelte/issues/908) 解決待ち**。
   - **WASM（0.61x）/ loc 込み native（0.72x）は不採用**。Rust/WASM エンジン化も速度目的では非推奨（上記 1）。
3. **monomorphization の Rust 化**、**sourcemap**（`TransformResult.map`）、**CI に `cargo test`+`build:wasm`
   （pinned toolchain）ジョブ追加**。
4. **`<svelte:options>` accessors/customElement bail の発火**（M4 で記録した既存ギャップ）。

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
- **サブリソース（`?svelte&type=style`）**: 無効化時に CSS サブリソースも含めて無効化（value-set narrowing の CSS 除去は
  `type=style` 側）。build の skip ガードと対称に。
- **monomorphization の dev は当面しない**: 仮想モジュール + 純減ゲート（ホールプログラム測定）をインクリメンタルに保つのは
  高コスト。dev は unused-prop fold / constant fold / value-set narrowing のみと文書化。
- **sourcemap**: M5 まで dev のマップは近似。`TransformResult.map` 実体化で解消。
- **未ロードモジュールの ModuleNode 不在**: `shaken` 更新は ModuleNode の有無と独立に常に行う。

## 6. パース速度ベンチ（Option A の根拠・実測）

「速度が最優先」という方針で、parse を rsvelte に差し替える Option A の効果を実コーパスで測定した。
コーパスは nexus 実ビルドから捕捉した **474 `.svelte` / 3.1 MiB**（`/tmp/shaker-capture/input-474.json`）。
5 pass・warm、parse のみ（解析/変換は除く）:

| 経路 | ms/pass | µs/file | vs `svelte/compiler` |
|---|---:|---:|---:|
| `svelte/compiler` parse → object（現状の既定） | 996 | 2101 | 1.00x |
| WASM `@rsvelte/compiler` `parse_svelte` + `JSON.parse` | 1643 | 3467 | **0.61x（遅い）** |
| WASM `parse_svelte`（文字列のみ・JSON.parse 前） | 2871 | 6057 | 0.35x |
| native `binding.parse` + `JSON.parse` | 817 | 1724 | 1.22x |
| native `binding.parse`（文字列のみ） | 418 | 882 | 2.38x |
| native `binding.parseEnvelope`（buffer・decode 前） | 465 | 982 | 2.14x |

### フルパイプライン実測（parse → analyze → transform、同コーパス）

parse 単体ではなくシェイク全体で測ると、parse がパイプラインの大半を占める一方、**JSON 経路では native の
parse 速度優位がフルでは消える**ことが分かった（`tests/_bench_pipeline.test.ts` で実測。計測後に削除）:

| フェーズ | ms/pass | 全体比 |
|---|---:|---:|
| `svelte/compiler` parse（cache seed） | 1044 | — |
| `analyzeInput` + `transformAll`（パーサ非依存） | **183** | — |
| **FULL（svelte/compiler）= parse+analyze+transform** | 1035 | 100% |
| └ うち parse | ~1044 | **~85%** |
| native parse（cache seed・JSON 経路） | 1083 | — |

- **エンジン本体（解析+変換）はわずか 183ms**＝全体の ~15%。**ここを Rust/WASM 化しても全体は速くならない**
  （しかも WASM 化は境界で遅くなる）。エンジンの Rust 化は速度目的では割に合わない（健全性の二重チェックとしては価値あり）。
- **支配的なのは parse（~85%）**。だが **JSON 経路の native parse はフルパイプラインでほぼ break-even（1083 vs 1044ms）**。
  単体ベンチで native parse が速かった分（文字列生成 418ms）は、**`JSON.parse`（~400ms）＋ AST 保持の確保コスト**で
  相殺される。→ **JSON を介す限り、どのパーサでも頭打ち**。
- 真の勝ち筋は **raw-transfer envelope（`parseEnvelope` + `decodeParseEnvelope`）で `JSON.parse` を丸ごと飛ばす**こと
  だけ。envelope parse 単体は 465ms（2.14x）で、decode が JSON.parse より十分速ければフル ~1.5x が見込める。

> ⚠️ この時点（rsvelte 0.6.1 / native 0.2.1）の結論は「投入不能」だった。下記「上流修正後の再検証」で**覆る**。

- **WASM は parse でも遅い（0.61x）**。`shake_program`(WASM エンジン) が ~2x 遅かったのと同根（境界マーシャリング）。
  → **Rust/WASM 化は速度の打ち手にならない**（この結論は不変）。
- 当時の native+JSON はフルで break-even、envelope は出荷漏れ（#792）+ UTF-8 オフセット（#793）でそもそも動かなかった。

### 上流修正後の再検証（compiler 0.7.6 / native 0.2.3、issue 全解決後）

[#791](https://github.com/baseballyama/rsvelte/issues/791)（TS 型ツリー）・[#792](https://github.com/baseballyama/rsvelte/issues/792)
（native `parse`/`parseEnvelope` 再エクスポート + decoder 出荷）・[#793](https://github.com/baseballyama/rsvelte/issues/793)
（UTF-16 オフセット）が**全て修正された**ので、native 0.2.3 で再測定（`tests/_bench_native.test.ts`、計測後削除）。
3 件とも実機で修正を確認済み（UTF-16 一致・完全 TS 型ツリー・`parse`/`parseEnvelope`/`decodeParseEnvelope` 出荷）。

| 経路 | parse のみ | フルパイプライン | 健全性 |
|---|---:|---:|---|
| `svelte/compiler`（既定） | 1.00x | 1.00x | — |
| native `parse` + `JSON.parse`（loc 込み） | 1.08–1.17x | **0.72x（遅い）** | クラッシュ無し |
| **native `parse({skipExpressionLoc:true})` + `JSON.parse`** | **2.24x** | **1.46x** | **クラッシュ無し・loc 無視で出力不変（差分 0）** |
| native `parseEnvelope` + `decodeParseEnvelope` | （理論上最速） | — | **[#908](https://github.com/baseballyama/rsvelte/issues/908) で破損**（typed-arrow body が byte offset・318/474 file 破損） |

- **決め手は `skipExpressionLoc: true`**。native の JSON は**全ノードに `loc{line,column}` を載せる**ため、loc 込みだと
  AST が肥大化しエンジンの walk が ~8x 遅くなり、フルで 0.72x まで沈む。**nested expression loc を落とすと AST が
  軽量化**し、parse 2.24x・**フル 1.46x** の実速度向上。エンジンは `start`/`end` しか見ない（`loc` 不使用）ので
  **skipExpressionLoc は出力に 0 影響**（native-JSON-with-loc と byte 一致を実証）。
- **正当性**: native 駆動の shake は svelte/compiler 駆動と **474 中 408 が byte 一致**、残り 66 は**些細な AST 形状差**
  （`root` end の off-by-one、svelte が `typeAnnotation: undefined` / CSS `args: null` を明示する所を native は key 省略）
  に起因。**全て compile 可・SSR 等価**で、健全性問題ではなくパリティ磨きレベル。
- **envelope（JSON.parse を飛ばす真の最速路）は新バグ [#908](https://github.com/baseballyama/rsvelte/issues/908) で当面不可**。
  typed-arrow param があると arrow body 以降のサブツリーが byte offset のまま（#793 の envelope 取りこぼし）。解決すれば
  1.46x からさらに上積み可能。

**最新結論（Option A 実装済み・opt-in）**:

- **native `parse({skipExpressionLoc:true})` + `JSON.parse` で実フル 1.46x**。クラッシュ無し・skipExprLoc は出力不変。
  WASM（0.61x）でも loc 込み native（0.72x）でもなく、**この経路が現実解**。
- **実装済み（`parser: 'rsvelte'`。当初 opt-in・既定 `svelte`、PR12 で既定化）**: `parseCached`→`buildAnalyzeInput`→
  `svelteShaker`/`DevShaker` に `Parse` を注入。crawl と analysis で**共有 cache に 1 parse/file**（svelte 経路の二重 parse
  より効率的）。native は **必須 peer** `@rsvelte/vite-plugin-svelte-native`、ローダーは node 専用 `rsvelte-parse.ts`（vite entry に同梱）。
- **健全性（上流 #791/#792/#793/#916 全解決後、native 0.2.4）**: native 駆動の shake は実コーパス **474/474 が compile 可**。
  svelte 駆動との差 22 は全て「native の方がよく shake（未渡し prop を undefined 畳み・冗長属性除去、SSR 等価）」。
- **再現性のため explicit `parser:'rsvelte'` は native ロード失敗時に throw**（silent fallback だと「native 有無で
  バンドルが変わる」罠になる）。
- **既定 flip 済み（PR12）**: parser 既定を `'rsvelte'`（native）に変更し、必須 peer 化。再現性のため未導入時は silent
  fallback せず throw、`parser:'svelte'` が svelte/compiler への明示フォールバック。環境フリー API とブラウザ playground は
  native バイナリを要求できないため `svelte/compiler` のまま（境界）。envelope（#908）解決でさらに高速化。エンジン本体の
  Rust/WASM 化は **速度目的では非推奨**（全体の ~15%・境界で逆効果）。
