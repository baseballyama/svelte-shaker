# svelte-shaker アーキテクチャ設計

> Svelte コンポーネントを「コンパイル前のソース段階」で部分評価し、未使用 props に紐づく
> dead code をツリーシェイクしてから Svelte コンパイラへ渡す Vite プラグイン。
> いわば **「Svelte 版 Rollup tree-shaking」**。

最終的には性能のため中核エンジンを Rust（[rsvelte](https://github.com/baseballyama/rsvelte) = OXC 上の
Svelte5 コンパイラ移植）で実装する。本書はまず TypeScript で動かしつつ、最初から Rust へ
無理なく差し替えられる層構造を定義する。

> **スコープ（決定済み）**：**Svelte5 runes 専用**（`$props()` / `$derived` / `$effect`）。
> **未使用・定数畳み済み prop は署名から落とす（攻め）**を既定とする。詳細は §12。

---

## 1. なぜこれが必要で、なぜコンパイル後では不可能なのか

### 1.1 解きたい問題

デザインシステム／UI ライブラリのコンポーネントは props が非常に多い（`Button` に
`variant / size / loading / icon / iconPosition / fullWidth / rounded / as / href ...`）。
しかし個々のアプリは、その一部しか使わない。使われない props に紐づくコード
（テンプレート分岐・クラス計算・リアクティブ文・import・CSS）は、そのアプリにとって
**実質的に dead code** だが、現状のツールチェーンでは消えずにバンドルへ残る。

```svelte
<!-- Button.svelte（ライブラリ側、30 props） -->
<script lang="ts">
  let { variant = 'primary', loading = false, icon, /* …28 more… */ } = $props();
</script>
{#if loading}<Spinner />{/if}
{#if icon}<Icon name={icon} />{/if}
<button class="btn btn-{variant}">{@render children?.()}</button>

<!-- アプリ側：loading も icon も一度も渡さない -->
<Button variant="primary">Save</Button>
```

このアプリでは `loading` / `icon` のコードは到達不能。`<Spinner>` も `<Icon>` も実際には
不要なので、それらのモジュール・CSS ごと消えてほしい。

### 1.2 なぜ Svelte コンパイル後の JS では消せないのか

Svelte コンパイラは **1 コンポーネント = 1 JS モジュール** を、全呼び出し元で共有できるよう
汎用的に出力する。生成 JS では prop の値はランタイム（`$.prop(...)` / `$$props` / getter）を
経由する間接値になり、`variant` や `loading` は **JS 上の静的定数として現れない**。

その結果：

- terser / esbuild / Rollup の DCE は `if (loading)` を `if (false)` に畳めない
  （`loading` がランタイム由来で定数と証明できない）。
- 1 モジュールは「将来どんな呼び出しでも動く」前提なので、特定アプリでの未使用 prop を
  消すのは **ホールプログラム情報を持たないコンパイラには原理的に不可能**。

→ **解決策：prop の値（default やコールサイトのリテラル）がまだソース上に見えていて、
テンプレート構造も無傷な「コンパイル前 Svelte AST」の段階で部分評価し、dead code を削ってから
コンパイラへ渡す。** これが svelte-shaker の核心。

---

## 2. 中核アイデア：ホールプログラム部分評価器

svelte-shaker は本質的に **Svelte を理解する partial evaluator（部分評価器）兼 DCE** であり、
それを **アプリ全体のコールサイト情報** で駆動する。

```
全コールサイトを走査
        │  各 <Comp prop={...}/> から「prop → 値の抽象」を集約
        ▼
コンポーネントごとの PropProfile（この prop は一度も渡されない / 常に同じ定数 / 動的…）
        │  既知の定数を default ともども prop へ代入
        ▼
定数畳み込み（script + template + CSS class）
        ▼
DCE（死んだ分岐・リアクティブ文・宣言・import・未使用 CSS を除去）
        ▼
スリム化した Svelte ソースを再生成 → 公式 Svelte コンパイラへ
```

ポイントは「prop を消す」とは結局 **「prop をその確定値で置換し、定数畳み込みして DCE する」**
だということ。一度も渡されない prop はその値が常に default なので、`export let x = false`
は `const x = false` と等価になり、下流の畳み込みが分岐を消す。

### 2.1 グラフ上の不動点（fixpoint）= カスケード削減

これは 1 コンポーネント内で閉じない。prop 削減が **子コンポーネントの呼び出しごと消す** と、
子の PropProfile が変わり、さらに削れる：

```
App が Button に icon を渡さない
  → Button 内 {#if icon} が false 畳み → <Icon> の呼び出しが消える
    → アプリ内で Icon の呼び出しが他になければ Icon モジュールごと dead（Rollup が落とす）
    → Icon が他で限定的にしか使われないなら Icon の PropProfile も縮む → さらに削減
```

よって **解析はコンポーネントグラフ上の不動点反復**になる（削れなくなるまで回す）。

### 2.2 値の抽象とジョイン束（lattice）

prop `p`（コンポーネント `C`）の、全コールサイトにわたる抽象値は以下の束のジョインで求める。
**「あるサイトで `p` を渡さない」= そのサイトでは `p` は default 値**として束に参加させる
（これが「未使用 = default で畳める」を自然に表現する鍵）。

```
                 ⊤  Unknown / Dynamic
                /   |   \         （spread不明・動的式・bind・escape のいずれか）
          Const(a) Const(b) …    （リテラル。値が割れたら multi=値集合として value-set narrowing で活用）
                \   |   /
              SingleConst（全サイトで唯一の定数）
                    │
                    ⊥  まだ呼び出しなし
```

- `⊥ ⊔ x = x`
- `Const(a) ⊔ Const(a) = Const(a)`
- `Const(a) ⊔ Const(b) (a≠b)` … `multi={a, b}`（値集合）として保持。**value-set narrowing で到達可能値集合**
  として使い、集合外の分岐・CSS を消す。monomorphization ではさらに形状別モノモーフィズに使う。
- 動的式 / 解決不能 spread / `bind:` / コンポーネントの escape は即 `⊤`。

`⊤` になった prop は削れない（=使われ得る）。`Const(v)`（default 込みで単一定数）に
収束した prop は `v` で畳める。一度も渡されない prop は「全サイトで default」= `Const(default)`。

> **フィクスチャ `basic1` の位置づけ**：`<Sub hasIcon={false}/>` が唯一の呼び出し →
> `hasIcon` は `Const(false)` に収束 → `{#if hasIcon}` を `{#if false}` に畳んで
> `<p>Icon</p>` を除去。これは後述の **constant fold** に相当する。
>
> **採用方針（決定済み）**：prop 署名まで縮める（攻め）。よって `Sub` 側は `hasIcon` を
> `$props()` から落とし、連動して `App` 側の `hasIcon={false}` 属性も除去する。
> 現行フィクスチャ `basic1/expected`（宣言を残す保守版）は、この既定に合わせて
> 更新が必要（§12-2 / §7 参照）。

---

## 3. 最適化パス（常時オンの 3 段 + オプトアウト可能な monomorphization）

攻めるほど削れるがリスク／複雑度／コードサイズが増す。そこで健全・低コストな 3 段（unused-prop
fold / constant fold / value-set narrowing）は**常時オン**にし、形状別に複製する
**monomorphization** だけを（既定 ON のまま）オプトアウト可能にする。

| パス                    | 名前                         | 何をするか                                                                                                          | モジュール数                  | 既定   |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ |
| **unused-prop fold**    | 未使用 prop 除去             | どのサイトからも渡されない prop を default で畳んで DCE。**`$props()` の署名からも落とす**                          | 1/コンポーネント              | ✅     |
| **constant fold**       | 全アプリ定数伝播             | 全サイトで同一リテラルに収束する prop を畳む（`basic1` がこれ）。署名から落とし、**全コールサイトの該当属性も除去** | 1/コンポーネント              | ✅     |
| **value-set narrowing** | **値集合ナローイング**       | 全サイトの到達可能値集合（例 `variant ∈ {primary, secondary}`）で、集合に無い値の分岐・CSS を除去                   | 1/コンポーネント              | ✅     |
| **monomorphization**    | コールサイト・モノモーフィズ | prop 形状ごとにコンポーネントを複製・特殊化                                                                         | N/形状（dedup・サイズガード） | ✅¹    |

- **unused-prop fold / constant fold / value-set narrowing が本命**。1 コンポーネント 1 モジュールを
  保つので安全・低コスト・コードサイズ増なし。この 3 段はスイッチを持たない（bail-safe で出力が増える
  ことは無い）。
- ¹ **monomorphization は Vite プラグインでは既定 ON**（net-win ゲートで肥大しないため。下記）。
  `monomorphize: false` で OFF にできる（ビルド時間と圧縮率のトレードオフ）。環境フリーのエンジン API
  （`svelteShakerWithMono` / `DEFAULT_MONO_OPTIONS`）は既定 OFF で、プラグインの `resolveMono` が ON に倒す。

#### value-set narrowing（「使わない variant を消す」主力）

`variant` のような prop は constant fold では `Const('primary') ⊔ Const('secondary') = Dynamic` となり
「使われている」と諦めてしまう。だが実際には **到達可能な値集合 `{primary, secondary}`** が分かれば、
集合に無い値に紐づくコードは dead。よって束に **`multi`（値集合）抽象**（§2.2）を保持し、次を消す：

- 明示分岐：`{#if variant === 'danger'}` / `{:else if}` / `switch(variant)` の `danger`/`ghost`/`link` ケース
- オブジェクトマップ：`styles[variant]` の到達不能キー（他で参照されない場合）
- **CSS（shaker 独自の価値）**：`class="btn btn-{variant}"` のような文字列補間は Svelte の
  unused-CSS 刈りが中身を追えず `.btn-danger` を残す。shaker は「variant ∈ {primary,secondary} だから
  `btn-danger` は生成不能」と判定して **CSS ルールごと除去**できる。Svelte 単体では届かない領域。

健全性の鍵：値集合ナローイングは **「全コールサイトを把握済み」が前提**。1 箇所でも spread/escape/
動的式で `⊤` になると集合は「全値」に退化し、ナローイングが死ぬ。よって **§4.1 の部分 bail
（`⊤` を prop 単位に局所化して減らす）が value-set narrowing / monomorphization の効きを直接左右する前提条件**になる。
初期はコールサイトがリテラルのケースのみ対象（`variant={v}` は将来 TS の union literal 型から
集合を絞る高度化余地）。

#### monomorphization（**既定 ON**、**測定ベースの純減ゲートで「絶対に肥大させない」**）

value-set narrowing で削った後、`<Button variant="primary">` の**呼び出しごと**に `variant='primary'`
固定の複製を作り `variant==='primary'` を true 畳みして primary 以外を全消し…という素朴な monomorphization
は**最強だが形状数だけ複製が増え、しばしばバンドルを肥大させる**。ここが核心の洞察：

> **なぜ素朴な monomorphization は肥大するのか / monomorphization が本当に効くのはどこか**
>
> **value-set narrowing は既に「アプリ全体で到達不能なアーム」を消している**。だから monomorphization が
> **バンドルを縮める**のは、特殊化によって**あるモジュール全体がプログラム全体から参照されなくなる**ときだけ。
> これは **value-set narrowing の独立ナローイングでは殺せない「相関した複数 prop 条件」**で起こる。代表例：
>
> ```svelte
> <!-- Child.svelte -->
> {#if a === 1 && b === 1}<Heavy/>{/if}<p>base</p>
> ```
>
> アプリ全体で `a ∈ {0,1}`・`b ∈ {0,1}` だが、コールサイトは `<Child a={0} b={1}/>` と
> `<Child a={1} b={0}/>` だけ＝**`(1,1)` は決して起きない**。value-set narrowing は `a`・`b` を**独立に**
> narrowing するので `a && b` が両方 1 にならないことを証明できず、`<Heavy/>` を残す → Heavy はバンドルに残る。
> monomorphization は各サイトを特殊化（`a` か `b` が定数化）→ **どちらの variant でも `{#if a===1&&b===1}` が
> false に畳まれ** → `<Heavy/>` が全 variant から消える → **Heavy がプログラム全体から未参照** → バンドラが
> Heavy を丸ごと落とす。**これが monomorphization の唯一の勝ち筋**。
>
> 逆に、**モジュール消去を伴わない素の `variant ∈ {a,b}`（インラインアームのみ）は特殊化してはならない**：
> 形状ごとのモジュールに割ると共有スキャフォールドが複製されてバンドルが**増える**だけ。

そこで monomorphization は **graph-aware・測定ベースの純減（net-win）ゲート**で、**消した方がプログラム
全体のモジュール集合が縮むときだけ**子を特殊化する：

1. **ALL-SITES-OR-NOTHING（子 C 単位）**：C を特殊化するのは、プログラム全体の **生きている全コールサイト**
   （dead `{#if}` span 内・共有述語で除外）が**残らず非ベース residual（本物の variant）になる**ときだけ。
   1 つでもベースを保つ生サイトがあれば C は特殊化しない（さもないと **ベースが残ったまま variant が増える＝
   純粋な肥大**）。全サイト特殊化なら C のベースモジュールが未参照になり、バンドラが落とせる。
2. **whole-program live render グラフ**：ノード＝コンポーネントモジュール、辺 `O → X` ＝ O の residual 内の
   各生 `<X/>`（通常コンポーネントはベース residual、candidate の variant は variant ソースをパースして C の
   import マップで `<X/>` を解決）。到達ルート＝**shake entries**（Shell が全 `.svelte` を渡すため、
   他コンポーネントから render される entry は落とし、真の import グラフ根のみをルートにする）。
3. **`ownSize(residual)`**：`svelte/compiler` の `compile({generate:'client',dev:false})` で client JS に
   コンパイルした `js.code.length`（per-module の byte 代理。共有 npm/.ts 依存は両シナリオで同一なので無視可）。
   メモ化。コンパイルエラーは「サイズ不能」として当該子を非特殊化（skip）。
4. **2 シナリオ測定**：candidate 子 C（dedup 済み variant 集合 `{V1..Vk}`, `k ≤ maxVariants`）について、
   - `Σ_base` ＝ entries から**ベースシナリオ**で到達するコンポーネント集合の `ownSize(ベース residual)` 合計。
   - `Σ_spec` ＝ 同じ到達性だが C を variant に置換：C のサイトは Vi を render、C.base は除去、各 Vi は自分の
     生子を render。variant は `ownSize(Vi)`、それ以外はベースサイズ。
   - **`Σ_spec < Σ_base * (1 - minSavings)` のときだけ C を特殊化**（厳密純減）。それ以外はベース維持。
     candidate 同士は**互いに独立**に同一ベースへ評価する（相互作用は後続。常にベース比較＋厳密純減なので
     union が肥大することはない＝健全）。判断に迷えば**特殊化しない**。

これにより **monomorphization ON のバンドルは常に value-set narrowing（既定）バンドル以下**（byte）に
なることが構成的に保証される。import は `virtual:shaker/Button?shaker_variant=<n>` 相当の仮想モジュールへ
張り替え、同形状は dedup する。**Vite プラグインでは既定 ON**（肥大しないため）。

> **実装状況（M6 + net-win ゲート / 実装済み）**：エンジン（`src/mono.ts`）が **コールサイトごとの特殊化
> residual・dedup マップ・測定ベースの純減ゲート**を計算する。**Vite プラグインでは既定 ON** で、
> `shaker({ monomorphize: false })` で OFF（ビルドを速くする）。環境フリーの
> エンジン API（`svelteShakerWithMono(entries, …, { enabled: true, maxVariants, minSavings })`）は既定 OFF で、
> OFF のときは value-set narrowing 出力と**完全に byte 一致**（挙動不変）。
>
> - **健全性（構成的）**：特殊化するのは (1) **生きている**コールサイト（dead `{#if}` span 内は除外、
>   fixpoint と同一述語）かつ (2) その prop が **spread に上書きされ得ないリテラル**であるサイトのみ
>   （`afterLastSpread` かつ非 `dynamic`、§4.1 の部分 bail と同条件）。bail 済みコンポーネント
>   （escape/barrel/accessors）・shadow される prop・`{@debug}` prop・constant fold で既に畳んだ prop は
>   特殊化しない。residual は **unused-prop fold / constant fold / value-set narrowing と同一の監査済み
>   ボディパイプライン**（`shakeBody`）で生成し、monomorphization は fold 環境を増やすだけ。
> - **絶対に肥大しない（net-win ゲート）**：上記 1–4 の all-sites-or-nothing ＋ 測定ベース `Σ_spec < Σ_base`
>   判定。`Σ_spec` の到達性は「C の全入辺を全 variant に展開」する**健全な上界**なので、迷えば**特殊化を見送る**
>   側に倒れる（真の勝ちを逃すことはあっても、決して肥大しない）。`minSavings`（既定 0＝厳密純減のみ）を
>   `MonomorphizeOptions` に追加。上げると保守側に倒れるだけで unsound にはならない（§13.2 精度ノブ）。
> - **dedup（residual 等価）**：dedup キーは **residual ソースそのもの**。byte 一致する residual は 1
>   モジュールを共有する（§13.2「相異なる residual 数で内在的に有界」）。瓜二つコピーは構成的に生じない。
> - **CSS も連動**：frozen prop は定数化するので、その variant 内では到達不能クラスの CSS ルールがさらに
>   消える（`variant="primary"` の複製から `.btn-danger` が落ちる）。
> - **`maxVariants` cap**：相異なる residual 数の上限（コンポーネント単位、既定 8）。超過した子は**全サイトを
>   特殊化できない**＝ベースが残るので、その子は丸ごとベース維持（部分分割はしない＝常に健全）。
> - **配線（Vite Shell）**：variant は **元の子ファイルパス + `?shaker_variant=<n>` クエリ**の仮想
>   リクエストとして公開する（相対 import が無特殊化の子と同一に解決される）。Shell の `resolveId`/`load`
>   が residual を供給し、所有側ソースの該当 `<Child …>` を variant import へ張り替え、frozen 属性のみ除去
>   （`{...spread}` 等は保持）。差分 SSR で「発生する値について観測等価」をテストで保証
>   （`tests/mono.test.ts`：相関条件で Heavy をモジュールごと消す + 純減ゲートが素のインライン variant を
>   却下する + monomorphization OFF byte 一致 + 差分 SSR 等価 + dedup + all-sites cap + bail + e2e で
>   monomorphization バンドル ≤ value-set narrowing）。

---

## 4. 健全性（soundness）と bail-out フレームワーク

最適化器が「たまに壊す」と無価値（サイレントにアプリが壊れる）。
**正しさ > 攻め**を絶対原則とし、危険な機能（poison features）に対しては最適化を見送る「bail-out」を持つ。

### 4.1 部分 bail フレームワーク（既定）

**完全 bail**（危険機能が 1 つでもあればコンポーネントの全 prop を諦め素通し）は安全だが、
実アプリは spread/rest を多用するためほとんど効かなくなる。よって既定は **部分 bail**：
**危険機能の影響を prop 単位に局所化し、影響を受けない prop の最適化は続ける**。
（部分 bail で `⊤` を減らすことは、§3 の value-set narrowing と monomorphization が効くための前提でもある。）

| poison feature                                                                                 | 影響範囲                     | 部分 bail の扱い                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **コールサイトの spread** `<Comp {...rest} a={1} b={2} />`                                     | rest が埋めうる prop         | **後勝ち順序で救う**：spread より**後ろ**に明示された prop は確定 → 救う。spread より前/同名は `⊤`。`rest` が解決可能な object literal なら key 展開して narrowing |
| **コンポーネント側が rest を読む** `let { variant, ...rest } = $props()`                       | rest に流れる「未宣言 prop」 | **明示宣言 prop（`variant`）は救う**。rest 経由で DOM 転送される未宣言 prop は削除不可                                                                             |
| **`bind:prop`（双方向）**                                                                      | その prop のみ               | その prop だけ「使用 & 動的」で `⊤`。他 prop は通常通り                                                                                                            |
| **`<svelte:options accessors />` / `customElement`**                                           | コンポーネント全体           | props が公開 getter/setter・要素属性になり外部設定され得る → **完全 bail**                                                                                         |
| **escape**（`<svelte:component this={X}>` / コンポーネントを値として代入・関数渡し・配列格納） | コンポーネント全体           | 漏れた先の使われ方を追うのはポイント解析が必要で割に合わない → **完全 bail**（簡易 escape 解析で検知）                                                             |

- **副作用の保存**（横断原則）：値が未使用でも観測可能な副作用（`$effect` / 純粋性不明な関数呼び出し）
  を持つコードは削らない。純粋かつ未使用と証明できた場合のみ除去。
- 補足：Svelte5 専用方針（§12-1）のため `$$props` / `$$restProps`（Svelte4）は対象外。
  Svelte5 の rest は上表「コンポーネント側が rest を読む」で扱う。

### 4.2 ライブラリ境界 — どのビルドで動かすか

未使用 prop の判定は **「このアプリの全消費者」を知って初めて成り立つ**。よって：

- svelte-shaker は **アプリ側のビルド**で動かす。`node_modules` のデザインシステムも
  「このアプリ用の入力」として特殊化する。
- ただし **ライブラリが `.svelte` ソースで配布されている**ことが前提（`svelte-package` 推奨の
  配布形態）。コンパイル済み JS を配布するライブラリは shaker の対象外（§1.2 の理由でソースが要る）。
  → ドキュメントで「shake 可能な配布形態」を明示し、対象外は静かに素通しする。

#### 非 `.svelte` コールサイトの穴と module escape

whole-program クロールは **`.svelte` しかパースしない**。よって `.ts`/`.js` 内のコールサイト
（`mount(Comp, { props })`・`render(Comp, …)`・遅延 `import()` 等）はクロールに**見えない**。
「`.svelte` テンプレートからも使われ、かつ `.ts` からも props を渡される」混在コンポーネントでは、
`.ts` 側が見えないまま prop を `Const(default)` に畳んで unsound になり得る（`findNeverPassedProps`
も同様に over-report し得る）。**コールサイトが 1 つも無いコンポーネント**は既存の zero-call-site
スキップ（`buildPlan` の `sites.length === 0`）が守るが、混在ケースはそれをすり抜ける。

対策は **機構を 1 つだけ**持つ：`AnalyzeInput.escaped`（`ComponentId` の純データ集合）を、
既存の whole-component escape bail（§4.1 の accessors/customElement/escape と同じ経路）に**合流**させる。
出力フィルタ（報告だけ消して fold は残す）ではなく bail に合流させることで、「fold は止まるが報告は残る」
ような不整合を構造的に排除する。escape 扱いのコンポーネントは **fold も unused 報告もされない**が、
**そのコンポーネント自身のコールサイト（子への使用）は引き続き数える**（＝子の value set には寄与する）。

この集合を埋める **フィーダーは 2 つ**（どちらも Shell 側。Engine は純データを受け取るだけ）：

1. **非 `.svelte` モジュールの自動スキャン**：`entries` 配下の `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts`/
   `.jsx`/`.tsx`（`.svelte.[jt]s` を含む、`.d.ts` を除く）を走査し、静的 import・`export … from`・
   **リテラル**動的 `import('…')` のうち `.svelte` に解決される先を escape に加える。specifier 解決は
   クロールと同じ注入済み Resolve を再利用（bare は `node_modules` へも解決）。走査対象ファイル自体は
   `entries` 配下のみ（`node_modules` 内の `.ts` は対象外＝seed スキャンと同スコープ）。
   **非リテラル動的 import（`import(expr)`）は検出不能** — その穴を塞ぐのが次の `preserve`。
2. **`preserve` オプション（ユーザー指定）**：スキャンが届かない消費者（`import(expr)`、`entries` 外の
   モジュール）への健全な逃げ道。`entries` と同じ「ディレクトリ or ファイルのプレフィックス一致」基準
   （glob 非依存）で、そのコンポーネントの **prop インターフェースをソースのまま保持**する。
   保持するのは prop であって**バンドル上の存在ではない** — Rollup/Vite の `external`（バンドルから
   外して外部 import として残す）とは無関係で、ファイルがバンドルから消えるような話は一切しない。
   **A セマンティクス**：ファイルは解析対象に残り（その中のコールサイトは数え続ける）、当該
   コンポーネント**自身**の fold / unused 判定だけが止まる。「スキャンから外すフィルタ」ではない。
   `entries` と違い**過剰指定は安全側**に倒れる（shake 量が減るだけで不健全にはならない）ので、
   迷ったら列挙してよい。

> **用語の注意**：ここでの preserve は monomorphization の「frozen prop」（§3 の variant がリテラルに
> 固定した prop ＝最適化を**強めた**結果）とは逆向きの概念である。preserve は最適化を**止める**指定。

両フィーダーは `computeEscapedComponents`（`svelte-shaker/node`）で 1 本化し、build パスと dev パスの
双方に配線する。dev では非 `.svelte` モジュールの add/change/unlink で escape 集合を再計算し、集合が
動いたときだけ full-reload する（dev が build より unsound にならないため）。両エンジン（JS / Rust WASM）
は `escaped` を同一セマンティクスで bail し、byte-identical 出力を保つ。

`computeEscapedComponents` は escape 集合に加え **診断を構造化データで返す**：parse できなかった
モジュール（`.jsx`/`.tsx` の JSX 本文・特殊 TS 等 → そこから mount される component が escape されない
soundness ホール）と、どの component にもマッチしなかった `preserve` エントリ（typo で保持され損ねる）。
Vite シェルはこれを **`config.logger.warn` で対象パス付きの actionable な警告**として surface する
（build は失敗させない）。将来の eslint シェルは同じ構造化データを自前で報告できる。silent drop は
CLAUDE.md「Don't swallow exceptions」に反するため、ここは必ず可視化する。

---

## 5. 層構造（Shell / Engine / IR）

Rust 差し替えを最初から可能にするため、**環境グルー（Shell）** と
**Svelte の賢さ（Engine）** を厳密に分離し、間を **安定した IR / データ契約**でつなぐ。

```
┌─────────────────────────────────────────────────────────────┐
│  Shell  =  Vite プラグイン（常に JS/TS）                      │
│  ・フック（buildStart / resolveId / transform）              │
│  ・モジュール解決（this.resolve — Vite エコシステム互換のため JS 必須）│
│  ・ファイル IO / キャッシュ / HMR ポリシー / 診断の表示      │
└───────────────▲───────────────────────────┬─────────────────┘
        EngineResponse                 EngineRequest（= IR）
┌───────────────┴───────────────────────────▼─────────────────┐
│  Engine  =  解析 + 変換のコア（TS 実装 → Rust 実装に差替）   │
│  ・parse（Svelte AST）                                       │
│  ・whole-program 解析（PropProfile・fixpoint）               │
│  ・部分評価（substitute → fold → DCE）                       │
│  ・Svelte ソース再生成（+ sourcemap）                        │
└─────────────────────────────────────────────────────────────┘
```

**Shell が握るもの**：Vite のフック、`this.resolve` によるモジュール解決
（プラグインエコシステム互換のため JS に残す）、ファイル読み込み、キャッシュ、
dev/HMR の方針、診断のターミナル表示。

**Engine が握るもの**：Svelte 固有の全処理。env 非依存・純粋関数的にし、入出力を IR で固定する。

### 5.1 エンジン境界の IR（データ契約）

```ts
// コンポーネント識別子：解決済み絶対パス（+ 必要なら export 名）
type ComponentId = string;

// 1 prop の、全サイトにわたる抽象値（§2.2 の束）
type PropAbstraction =
  | { kind: 'bottom' } // まだ呼び出しなし
  | { kind: 'const'; value: JsonLiteral } // 単一定数に収束
  | { kind: 'multi'; values: JsonLiteral[] } // 到達可能値集合（value-set narrowing / monomorphization）
  | { kind: 'dynamic' } // 使われている・値不定
  | { kind: 'top'; reason: BailReason }; // 削除不可（escape / rest / spread …）

// 解析が各コンポーネントに対して出す「計画」
interface ComponentPlan {
  id: ComponentId;
  bail: boolean; // 完全 bail なら素通し（accessors/customElement/escape）
  reasons: BailReason[];
  bailedProps: Set<string>; // 部分 bail：この prop だけ ⊤（spread後勝ち/rest/bind）
  removable: Map<string, JsonLiteral>; // unused-prop fold：default で畳む prop
  constFold: Map<string, JsonLiteral>; // constant fold：確定定数で畳む prop
  narrow: Map<string, JsonLiteral[]>; // value-set narrowing：到達可能値集合（集合外の分岐/CSSを除去）
  // monomorphization 用の形状割当ては別途 VariantPlan として持つ
}

// Engine への 2 つの入力フェーズ
interface AnalyzeInput {
  // フェーズ1：解析
  files: Array<{ id: ComponentId; code: string; lang: 'js' | 'ts' }>;
  edges: Array<{ from: ComponentId; to: ComponentId; props: CallSiteProps }>;
  options: ShakerOptions;
}
interface TransformInput {
  // フェーズ2：変換
  file: { id: ComponentId; code: string; lang: 'js' | 'ts' };
  plan: ComponentPlan;
}
interface TransformResult {
  code: string; // スリム化した .svelte ソース
  map: SourceMap; // shaken → original（デバッグ用）
  emptiedImports: ComponentId[]; // 次の fixpoint ラウンドへのヒント
  diagnostics: Diagnostic[];
}
```

この IR が JSON シリアライズ可能であることが Rust 化（napi raw-transfer）を素直にする。

---

## 6. Vite 統合（Shell の具体設計）

### 6.1 2 パス構成

ホールプログラム解析は「全コールサイトを見てから特殊化」する必要があるが、Vite/Rollup は
モジュールを遅延・個別に処理する（鶏と卵）。そこで **解析を自前クロールで前倒し**する。

```
buildStart:
  entry（Rollup input / Vite config）から import グラフを自前で辿り、
  .svelte / .svelte.[jt]s を「コンパイルせず」軽量パースして
    ・各コンポーネントの prop 宣言 + default
    ・各 <Comp .../> のコールサイト prop 形状
    ・コンポーネント識別子の escape
  を収集 → Engine.analyze() → PropProfile → fixpoint → Map<ComponentId, ComponentPlan>

transform（enforce: 'pre'：vite-plugin-svelte より前）:
  対象 .svelte ごとに ComponentPlan を引き、Engine.transform() を適用
  → スリム化した .svelte ソース + sourcemap を返す
  → そのまま公式 Svelte プラグインがコンパイル（未使用 CSS の刈り取りも委譲できる）
```

- 自前クロールでファイルを 2 度パースする（クロール時 + コンパイル時）。クロール用パースは
  「import / コールサイト prop 形状 / prop 宣言」だけ取れれば良く軽い。AST をキャッシュして
  transform 時に再利用する。**ここがまさに Rust（高速パース）の効くホットパス**。
- **順序**：`enforce: 'pre'` で vite-plugin-svelte の transform より前に走らせ、
  `.svelte → スリム化した .svelte` を返す。我々は「コードを消すプリプロセッサ」に徹し、
  Svelte の codegen には一切踏み込まない（バージョン非依存・疎結合）。
- **CSS シェイク**：死んだマークアップを消せば、対応する CSS は Svelte 自身の
  「未使用セレクタ除去」が後段で刈ってくれる。CSS の大部分は Svelte に委譲できる。

### 6.2 dev / HMR ポリシー — dev では原理的にやらない（既定 off）

**dev で shake しないのは妥協ではなく正しい設計**。これは本最適化の本質に由来する：

- **ホールプログラム前提と HMR の局所性が根本的に相容れない**。本最適化は全コールサイト集約＋
  グラフ不動点に依存する。dev/HMR は「変更モジュールだけ局所再処理」が信条で、1 コールサイトの
  編集が子・孫の PropProfile を変え広範囲を無効化する。
- **value-set narrowing / monomorphization は「その値は存在しない」という負の情報に依存する**。dev はモジュールを遅延ロードするため
  「まだ読まれていないファイルに新しい variant 使用があるかも」を排除できず、楽観的に消すと後から壊れる。
  毎回ルートから完全クロールすれば防げるが、それは dev の速さを殺す。
- **Vite dev がそもそも tree-shaking しない**のと同じ理由（dev は unbundled ESM、shake は本番ビルド限定）。
  これに倣うのが一貫していて自然。

したがって既定：

- **`vite build`（本番）でのみ shake**。`serve`/dev は**素通し**（未最適化だが常に正しく、HMR が単純）。
- 唯一の懸念 **dev/prod 乖離** は、shaker が**健全な最適化（観測挙動を変えない）**である保証で守る。
  乖離が出たらそれは shaker のバグ → **CI で「shake あり/なしの prod ビルドが同じ振る舞い」を回帰テスト**。
- どうしても dev で prod 相当を見たい人向けに `dev: 'coarse'`（毎回ルートから完全クロール、HMR は遅い）を
  後続マイルストーンで **opt-in** 提供。**既定 off で確定**。

> **dev インクリメンタル DCE の検討**：dev を避ける本当の壁は「負の情報の不完全性」ではなく
> **(a) インクリメンタル fixpoint 無効化の健全性**と **(b) HMR のモジュールグラフ乖離**である
> （コールサイト集合は import グラフ追跡ではなく FS 走査由来なので、完全性は build/dev で同条件）。
> Salsa 風の自動依存追跡（(a)）と `handleHotUpdate` の module widening（(b)）で opt-in 提供する
> 移行計画は [`RUST-MIGRATION.md`](./RUST-MIGRATION.md) を参照。

### 6.3 ソースマップ / プリプロセッサ順序 / TS

- 我々は元 `.svelte` から **span を削除**する変換なので、magic-string で
  `shaken → original` のマップを生成 → 下流 Svelte のマップと合成すれば元ソースでデバッグ可能。
- **TS を保持**：`<script lang="ts">` の型注釈は消さず、dead code だけ削る
  （`basic1` の期待出力も `lang="ts"` と `: { hasIcon: boolean }` を保持）。
  → スクリプト解析は **TS 対応パーサ**で行う（OXC/rsvelte は TS ネイティブ、TS 経路が綺麗）。
- 我々は他のプリプロセッサ（TS トランスパイル等）より **前**＝著者ソースに最も近い段階で動く。
  prop の型・default を読め、出力も `.svelte`(+TS) のまま保てる。

---

## 7. Engine 内部パイプライン（部分評価器の詳細）

1 コンポーネントの変換（`Engine.transform`）：

```
parse（module script / instance script / template / style を AST 化）
  └ scope/semantic 構築（use-def、束縛、参照）
        │
substitute：plan.removable + plan.constFold の prop を確定値に
  └ $props() 分割代入の該当 prop を const に降格 → 署名から落とす（既定：攻め）
  └ constant fold で署名から落とした prop は、全コールサイトの該当属性も除去
       ・ただし属性式が副作用を持つ（例：value={sideEffect()}）場合は属性を残す/式を保持
       ・bail 済みの rest props 経由は対象外なので、未知 prop 流入の心配なし
        │
constant fold（script → template → CSS class）
  └ if/ternary/logical/文字列補間/class: の条件を畳む
  └ {#each empty} / {#if false} などを評価
        │
DCE（副作用・リアクティビティを尊重）
  └ 出力が未使用かつ副作用なしのリアクティブ文（$:/$derived/$effect）を除去
  └ 未使用宣言・未使用 import を除去
  └ 死んだテンプレート分岐（{#if false} ブロック、到達不能 {:else}）を除去
        │
emit：スリム化した Svelte ソース + sourcemap
```

これを **コンポーネント内でも不動点反復**（畳み込みが次の畳み込みを生む）。

**空白（whitespace）の健全性**：Svelte はフラグメント端の空白専用テキストを除去し、
2 つの描画ノードの**間**の空白は 1 スペースに潰して保持する（ノード種別・改行有無は
不問。`tests/whitespace-oracle.test.ts` が実測で固定）。死んだ `{#if}` チェーンの削除は
隣接空白を「間」から「端」へ変えてスペースを失わせ得るし、生き残ったアームの splice は
ブロックフラグメント端でトリムされていた空白を「間」へ持ち込んでスペースを増やし得る。
そこで transform は、スペースが失われる継ぎ目だけを `{" "}`（ExpressionTag は端でも
トリムされない）で補償し、splice 時はアーム端の空白を剥がす。`<pre>`/`<textarea>`/
`preserveWhitespace` 配下は何もトリムされないため、素の削除のままがバイト一致で正しい。

**実装手段の選択**：

- **削除主体**なので magic-string による **AST ノード span のサージカル削除**が頑健
  （整形を保ち、テキスト再構成の脆さがない）。
- 式を**書き換える**畳み込み（`btn-{variant}` → `btn-primary`）は置換で対応。
- Rust 版は rsvelte の AST を直接変換し `rsvelte_formatter` で再印字する経路も取れる
  （printer ベース。§9）。

---

## 8. TypeScript 実装（第一段階）

既存スキャフォールド（pnpm workspace）を踏襲：

```
packages/
  svelte-shaker/                 … Engine（コア）。env 非依存
    src/
      parse/                     … svelte/compiler parse ラッパ（→将来 rsvelte）
      analyze/                   … クロール収集物 → PropProfile → fixpoint
      transform/                 … substitute / fold / dce / emit
      ir.ts                      … §5.1 のデータ契約
      engine.ts                  … analyze() / transform()
  vite-plugin-svelte-shaker/     … Shell（Vite。enforce:'pre'、2 パス、HMR ポリシー）
  example/                       … 動作確認・回帰フィクスチャ
```

- 第一段階は **unused-prop fold + constant fold**、`basic1` を緑にするところから。`svelte/compiler` の `parse` と
  `zimmerframe` walk、`magic-string`、スクリプト解析に OXC（`oxc-parser` npm）/ TS を使う。
- **既存 PoC（phase1/2/3）の扱い**：§9 で評価。core の素朴な土台としては有用だが、
  本流は「直接 AST 部分評価器」に寄せる。

### 8.1 プラグイン API（案）

```ts
shaker({
  entries, // クロールの起点ディレクトリ（glob 非対応。§8.1.1）
  preserve, // 見えない消費者を持つコンポーネントの prop を保持（§4.2）
  dev: false, // dev でも走らせるか（既定 false = build のみ）
  monomorphize: { maxVariants: 8, minSavings: 0.15 }, // 既定 ON。false で OFF
  unsafe: { allowRestProps: false }, // bail を緩める脱出口
  report: false, // 削減レポート（prop/branch/byte）を出力
});
```

キー集合はこれで閉じている：未知のキーは build 開始時に throw する。黙って無視すると
typo は旧キーと同じ壊れ方をする（設定したはずのものが効かないまま build が通り、
`preserve` の綴り間違いなら守りたかったコンポーネントが over-shake されて出荷される）。

#### 8.1.1 なぜ glob（`exclude` / パターン指定）を持たないのか

`entries` は「処理対象ファイルのフィルタ」ではなく**クロールの起点**であり、`exclude` のような
除外パターンはこの設計に接続しない（起点から到達したコンポーネントは、`node_modules` 内の
ライブラリ component も含めて shake される — 起点集合はそれを狭めない）。glob を入れない理由は 2 つ：

1. **失敗モードが一方向にしか倒れない。** 起点が広すぎても健全性は損なわれない（余分な `.svelte` が
   コールサイト源として数えられるだけ）が、**覆い漏れ**は不可視のコールサイトを生み、prop の誤った
   fold ＝無音の破壊になる。パターン言語は「意図せず狭める」操作を簡単にするだけで、安全側には効かない。
2. **同じディレクトリ列が 2 つの異なる走査を駆動している。** `collectSvelteFiles` による `.svelte`
   起点収集と、`collectNonSvelteModules` による**非 `.svelte` モジュールのエスケープスキャン**（§4.2）
   である。`.svelte` 向けに書かれた glob は後者を表現できず、`preserve` で拾うべき消費者を静かに
   取りこぼす — つまり glob は不健全側に倒れる。

見えない消費者への逃げ道は `preserve` 一本に集約する（§4.2）。こちらも glob ではなく
「ディレクトリ or ファイルのプレフィックス一致」で、`entries` と同じ基準である。

**ただし `devOnly`（glob）だけは別物として持つ。** 上の 2 つの理由が却下しているのは「アプリの
**覆いを狭める** glob（`exclude` 的な用途）」であって、`devOnly` はそれとは向きが違う。`devOnly` が
宣言するのは**そもそも production バンドルに出荷されない dev 専用ファイル** — colocated なテスト・
Storybook のストーリー — であり、「出荷されない＝消費者として数えてはいけない」というのが
discount を健全にする契約そのものである。これらは数え続けても shake を**悪化させるだけ**である
（`Foo.test.svelte` が起点として数えられ、`Button.test.ts` が import した component を丸ごと
preserve 扱いにする）。理由 2 への答えも構造的で、`devOnly` は `.svelte` 向けだけの glob ではなく
**両方の走査に同一の述語として渡る** — `collectSvelteFiles` の起点収集からも `collectNonSvelteModules`
のエスケープスキャンからも同じファイルが外れるので、「`.svelte` 向け glob が escape スキャンを
取りこぼす」不整合は起きない。既定パターンは `**/*.test.*` / `**/*.spec.*` / `**/__tests__/**` /
`**/__mocks__/**` / `**/*.stories.*` の**規約ベースの狭いもの**に限り、`devOnly` 指定はこの既定を
**置換**する（`[...DEFAULT_DEV_ONLY, …]` で拡張、`devOnly: []` で全ファイルを数える）。`devOnly` が
外すのは seed / escape 源としての登場だけで**ファイルを shake から外すわけではない** — アプリが実際に
import する `.svelte` は通常のクロールが依然到達し shake もされるため、到達可能なコールサイトを
取りこぼすことはない（§4.2）。唯一の危険は「`.svelte` グラフの**外からのみ**消費される component」を
誤ってパターンに含めるケースで、これは `entries` の覆い漏れと同じ失敗モード — だからこそ既定を規約
ベースの狭いパターンに留める。`preserve` とは別物である：`preserve` は出荷される component の prop を
そのまま保つ指定、`devOnly` は「そのファイルは production グラフの一部ではない」という宣言。マッチ
判定は Vite root（standalone node API では走査 dir）相対の posix 正規化パスに対して `picomatch` で行う
（Shell 側 `src/dev-only.ts`。Engine は環境非依存のまま）。

**`exclude`（ビルド出力ディレクトリの剪定）も別物として持つ。** これは冒頭が却下した「アプリの
**覆いを狭める** glob」ではなく、**そもそもソースでない生成物ツリー**（SvelteKit adapter-static の
`build/`、`dist/` など）を両走査の**ディレクトリ走査ごと**枝刈りする指定である。理由 2 への答えは
`devOnly` と同じく構造的で、`exclude` は `.svelte` 向けだけの glob ではなく**両方の走査に同一の述語
として渡る**（`collectSvelteFiles` と `collectNonSvelteModules` の双方が同じディレクトリを `continue`
で飛ばす）ので、escape スキャンを取りこぼす不整合は起きない。`entries` と同じく**プレフィックス一致**
（glob 非依存）で、Vite の resolved `build.outDir` は**常に無条件で除外**する（今まさに上書きする出力先
なので、アプリが依存するソースを含み得ない＝自明に安全）。それ以外の生成物 —— とりわけ `build.outDir`
の外に出る adapter-static の `build/` —— をユーザーが列挙する。動機は性能：`build/` の中の巨大な
minified JS を escape スキャンが `.svelte` import を探して全パースするのは純粋な無駄で、実アプリでは
クロール全体を支配し得る（`escape-scan.ts` / `scan.ts` が resolved `build.outDir` と `exclude` から
コンパイルした述語を共有する）。`devOnly` との違い：`devOnly` は出荷されない**ソース**ファイル
（テスト・ストーリー）を glob で外す指定、`exclude` は**ソースでない生成物ディレクトリ**まるごとの
剪定。過剰指定は `entries` と同じく**不健全側**に倒れる（剪定したディレクトリのコールサイトが数えられ
なくなる）ので、**生成物だけを列挙し、ソースは決して含めない**。だからこそ既定は自明に安全な
`build.outDir` のみで、それ以外の既定は持たない。マッチ判定は `src/exclude.ts` の `compileExclude`
（Shell 側。Engine は環境非依存のまま）。

**現状の実装サーフェス**（Vite `src/vite.ts`）：

```ts
// unused-prop fold / constant fold / value-set narrowing + monomorphization
// （既定。monomorphization は net-win ゲートで肥大しないので既定 ON）
shaker({ entries: ['.'] });

// monomorphization を OFF（ビルドを速くする。圧縮率は少し落ちる）
shaker({ entries: ['.'], monomorphize: false });

// monomorphization を切らずにチューニング
shaker({ entries: ['.'], monomorphize: { maxVariants: 16 } });
shaker({ entries: ['.'], monomorphize: { minSavings: 0.15 } }); // >=15% 純減を要求

// エンジン直叩き（Shell 非依存）
import { svelteShakerWithMono } from 'svelte-shaker';
const { files, mono } = await svelteShakerWithMono(
  entries,
  resolve,
  readFile,
  { enabled: true, maxVariants: 8, minSavings: 0 }, // 既定 enabled:false
  (variantId) => `…`, // variant の import 先 specifier を組み立てる
);
// entries は net-win ゲートの到達ルート計算にも使われる（§3 monomorphization）。
// mono.variants: id -> { code(residual), foldedProps } ／ mono.bindings: コールサイト割当て
```

`minSavings` は**実装済み**（既定 0＝厳密純減のみ。§3 monomorphization / §13.2 の測定ベース net-win ゲート）。monomorphization のサイズ
ガードは **all-sites-or-nothing ＋ `Σ_spec < Σ_base * (1-minSavings)` ＋ dedup ＋ `maxVariants` cap**。
`exclude` / `unsafe` / `report` は API 予約（未実装）。

---

## 9. Rust（rsvelte / OXC）への移行戦略

rsvelte は **OXC フルスタック上の Svelte5 コンパイラ移植**で、shaker に必要な部品が既に揃う。
エンジン境界（§5.1 IR）を最初から固定しておけば、Engine 実装だけを差し替えられる。

> **dev インクリメンタル DCE を最終ゴールに据えた移行計画**（バッチ境界化 → クエリ束化 → Rust 化 →
> dev opt-in）の詳細マイルストーンは [`RUST-MIGRATION.md`](./RUST-MIGRATION.md)。以下の表は
> その M3–M5 で差し替える Engine 部品の対応。

| shaker が必要とする処理        | rsvelte / OXC の既存資産                                                         |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Svelte ソースの高速パース      | rsvelte の Svelte AST（`crates/rsvelte_core/src/ast`：`template/js/css`）        |
| use-def / スコープ / 参照解析  | `oxc_semantic`                                                                   |
| 定数評価・畳み込み             | `oxc_ecmascript`（evaluate / constant folding）                                  |
| script の DCE / minify 基盤    | OXC minifier（dead code elimination）                                            |
| Svelte ソース再生成（printer） | `rsvelte_formatter`（`markup.rs` / `script.rs` / `style.rs` / `expression.rs`）  |
| JS ↔ Rust の高速橋渡し        | rsvelte の **napi raw-transfer**（`napi_raw_parse.rs`：AST を 1 バッファで転送） |
| Vite 統合の足場                | rsvelte の `vps`（vite-plugin-svelte 移植）を参考にできる                        |

**移行の順序（ホットパスから）：**

1. **パーサだけ Rust 化**：Shell/Engine は TS のまま、`parse` を rsvelte の napi に差し替え。
   全ファイルを舐めるクロールが最も重いのでここが効く。
2. **解析（PropProfile + fixpoint）を Rust 化**：グラフ計算を Rust に移し、Shell は
   `this.resolve` の結果（解決済みパス）だけ渡す。モジュール解決は Vite 互換のため JS に残す。
3. **変換（fold + DCE + emit）を Rust 化**：`oxc_ecmascript` + minifier + `rsvelte_formatter`。
   ここで「magic-string サージカル削除（TS 版）」から「AST 変換 + printer 再印字（Rust 版）」へ
   実装手段が自然に変わる。IR は不変なので Shell は無改修。

> モジュール解決（`this.resolve`）と Vite フックは **JS に残す**のが正解。
> エコシステム互換のため。Rust 化するのは「Svelte を理解する純粋計算」だけ。

---

## 10. 既存 PoC（phase1/2/3）の評価と推奨

現 PoC は **「Svelte テンプレートを擬似 JS に変換 → Rollup の JS tree-shaker → マーカー経由で
Svelte に戻す」** 方式（`phase1`=擬似 JS 化、`phase2`=`rollup({treeshake})`、`phase3`=復元）。

- **良い洞察**：成熟した JS tree-shaker（Rollup）の到達可能性解析を再利用する発想。
- **限界**：
  - treeshake 後の **JS テキストから Svelte ソースをコメントマーカーで復元**するのが脆い
    （整形・ネスト・`{#each}`/`{#await}`/`{#snippet}`/bind/CSS を正しく往復させづらい）。
  - Rollup の DCE は「モジュール export 到達可能性 + 副作用」ベース。テンプレート制御フローを
    JS にエンコードしないと畳めず、リアクティビティ（`$:`/runes）や `class:`/属性補間の意味論を
    正確に表現しきれない。
  - span マッピングの破綻リスク。

**推奨**：本流は §7 の **直接 Svelte-AST 部分評価器**（OXC の定数評価・DCE を AST 上で使う）。
PoC の「JS シャドウ」発想は捨てず、ただし **テキスト復元には使わない**。すなわち —
_「コンポーネントを JS の liveness モデルに落として到達可能性/DCE を解き、その結果を
元 AST のノード id 上の keep-set として引き戻し、出力は元 AST（printer / magic-string）から行う」_
という **ハイブリッド**にすれば、JS 解析の恩恵を得つつテキスト再構成の脆さを排除できる。
→ JS シャドウは「解析の補助」、元 AST が「真実の出力元」。

---

## 11. 実装状況（IMPLEMENTATION STATUS）

> 本節は「設計（§1–§10, §12, §13）が現行コードでどこまで実装されたか」の正直な棚卸し。
> 設計セクション自体は将来像も含むため残す。テスト全緑（`pnpm --filter svelte-shaker test`：
> `eval` / `basic` / `shadow` / `probes2` / `css` / `vite` / `mono`）。

### DONE（実装済み・テストで担保）

- **M0｜骨格** ✅：IR 確定（§5.1 / `src/ir.ts`）。Engine（`src/{parse,analyze,eval,dead,transform,css,index}.ts`）/
  Shell（`src/vite.ts`）分離。`basic1` を unused-prop fold / constant fold で
  緑に（新既定＝署名まで縮める）。dev は素通し（`apply:'build'`）。
- **M1｜実用 unused-prop fold / constant fold + 部分 bail** ✅：whole-program fixpoint カスケード（`analyze.ts` + `dead.ts` の単一述語
  `decideChain`）、部分 bail フレームワーク（§4.1：spread 後勝ち・callee rest・`bind:`）、escape 解析
  （`<svelte:component this={X}>` 等）と barrel/named import の完全 bail（§4.2）、shadowing/`{@debug}` ガード、
  call-site 属性除去（副作用式は保持）、より広い fold（template ternary、文字列補間）。magic-string による
  サージカル span 削除。
- **M2｜value-set narrowing + 堅牢化** ✅：`multi`（値集合）抽象、到達不能な if/else-if アームの除去
  （`eval.ts evaluateWithSets`、Kleene 三値・strict/loose 等価を区別）、**CSS 到達不能クラスルール除去**
  （`css.ts`、shaker 独自の differentiator）。差分 SSR を健全性オラクルとする回帰（`tests/diff.ts`：
  comment 除去・空白正規化した server-render HTML の同値）。CSS ベンチ（`tests/css.test.ts`：control は
  `.btn-danger`/`.btn-ghost` を残すが shaken は除去）。adversarial soundness 群（`tests/{shadow,probes2}.test.ts`）。
- **unused-prop fold / constant fold / value-set narrowing / monomorphization = Vite プラグインで
  既定有効** ✅：§3 の表のとおり。既定で monomorphization まで ON（net-win ゲートで肥大しない）。
  `monomorphize: false` で monomorphization OFF（ビルド速度トレードオフ）。
- **M6｜コールサイト・モノモーフィズ（既定 ON、測定ベース net-win ゲート）** ✅：エンジン `src/mono.ts`
  （生きたサイト × spread に上書きされ得ないリテラル prop のみ特殊化、residual は unused-prop fold /
  constant fold / value-set narrowing と同一の
  `shakeBody` で生成）＋仮想モジュール配線（`?shaker_variant=<n>`）＋ residual dedup。**「絶対に肥大しない」
  ゲート**：(1) **all-sites-or-nothing**（子 C は全生サイトが非ベース residual のときだけ＝ベースを未参照化
  できるときだけ候補）、(2) **whole-program live render グラフ**の到達性を `ownSize`（`compile({generate:
'client'})` の `js.code.length`、メモ化）で測り、**`Σ_spec < Σ_base * (1 - minSavings)` の厳密純減のときだけ**
  特殊化（§3 monomorphization / §13.2）。`maxVariants`（既定 8）超過の子は全サイト特殊化不能＝丸ごとベース維持。
  `svelteShakerWithMono(entries, …)` に **entries を通して**到達ルートを計算（Shell が全 `.svelte` を渡すため
  真の import グラフ根に絞る）。相関条件で Heavy をモジュールごと消す / 素のインライン variant を純減ゲートが
  却下 / monomorphization OFF byte 一致 / 差分 SSR 等価 / dedup / all-sites cap / bail / e2e で
  monomorphization バンドル ≤ value-set narrowing を
  `tests/mono.test.ts` で担保。プラグインでは既定 ON（`shaker({ monomorphize: false })` で OFF）。エンジン API
  `svelteShakerWithMono` は `{ enabled: true }` で有効化（既定 OFF）。

### REMAINING（未実装・後続）

- **monomorphization フォローアップ**：測定ベースの **net-win ゲート（all-sites-or-nothing ＋ `Σ_spec < Σ_base * (1-minSavings)`）
  は実装済み**。残りは (a) candidate 同士の**相互作用**を含めた厳密最適抽出（§13.2 の e-graph / ILP。現状は各
  candidate を独立にベース比較＝健全だが大域最適ではない）、(b) gzip 後サイズや共有チャンク粒度を考慮した
  コストモデル。`exclude` / `unsafe` / `report` の API は予約のみ（未実装）。
- **M3 残**：大規模デザインシステムでのベンチ、`svelte-package` 配布ライブラリでの実測、CI での
  「shake 有/無の prod ビルド同値」回帰の常設。
- **M4｜Rust 化①**：パーサを rsvelte（OXC）napi に差し替え（§9-1）。**未着手**（Vite プラグインの既定 parse は
  M3 の rsvelte native parser 経路＝`parser:'rsvelte'`（PR12 で既定化・必須 peer）。環境フリー API とブラウザ
  playground は native バイナリを要求できないため `svelte/compiler` のまま）。
- **M5｜Rust 化②③**：解析・変換を Rust（OXC + `rsvelte_formatter`）へ（§9-2/3）。**未着手**。
- **M7｜dev coarse モード**：影響部分グラフのみ再解析する HMR（§6.2、opt-in）。**未着手**（dev は常に素通し）。
- **value-set narrowing 高度化**：TS union literal 型からの値集合 seed・オブジェクトマップキー除去・§13 のフル
  IDE/SCCP/CFA（§12-8：縮約版の範囲確定が未決）。

---

## 12. 設計判断

### 決定済み

1. **対象 Svelte バージョン → Svelte5 runes 専用**。`$props()` / `$derived` / `$effect` のみ対象。
   実装・健全性解析が単純で、rsvelte（Svelte5）の Rust 経路と完全一致する。
   Svelte4（`export let` / `$:` / `$$props`）は対象外（将来の拡張余地として残すが初期はサポートしない）。
   ただし legacy `<slot>` と `$$slots` は runes コンポーネントでも合法にコンパイルされ実際に現れ得る。
   これらは `$props()` の外でスロット内容を観測するため、入力集合を unknown 扱いにして bail する（§4.1）。
2. **prop 宣言の扱い → 署名まで縮める（攻め）**。未使用／定数畳み済み prop は `$props()` から落とす。
   constant fold では連動して全コールサイトの該当属性も除去（副作用を持つ属性式は保持）。
   → 既存フィクスチャ `basic1/expected` を本既定に合わせて更新する（宣言と `hasIcon={false}` 属性を削る）。

3. **値集合ナローイング（value-set narrowing）→ 既定 ON**。「使わない variant を消す」を複製なしで実現する主力。
   束に `multi`（値集合）抽象を持たせ、到達不能な分岐・オブジェクトマップキー・CSS ルールを除去する。
4. **dev の既定 → build-only で確定**（§6.2）。dev は素通し。`dev: 'coarse'` は後続で opt-in。
5. **spread / rest / bind → 部分 bail を既定**（§4.1）。影響を prop 単位に局所化して救う。
   **accessors / customElement / escape のみ完全 bail**。

6. **値集合の上流追跡 → ヒューリスティック不要、§13 の原理的解析で確定**。「どこまで遡るか」は
   IDE による meet-over-all-valid-paths 精度で*解消*する（恣意的レベルを置かない）。
7. **monomorphization 複製の判断 → `maxVariants`/`minSavings` を廃し、§13 の原理的機構で確定**。
   変種は「相異なる residual 数」で内在的に有界、終了は WQO whistle、選択は測定コストの最適抽出。

### 未解決（要決定）

8. **§13 の理論をどこまで実装に落とすか**（フル IDE/CFA/supercompiler は重い）。
   対象が「prop＝引数・値はリテラル union」の分配的断片であることを使った*縮約版*の範囲確定。

---

## 13. 原理的アルゴリズム基盤（ヒューリスティック回避）

§3 の value-set narrowing と monomorphization は、`maxVariants`/`minSavings`/「追跡レベル」
のような恣意的ヒューリスティックを使わない。**両者は同一理論「抽象解釈に基づくポリバリアント特殊化
(polyvariant specialization by abstract interpretation)」の表裏**であり、確立アルゴリズムで形式的保証つきに解ける。

|                             | 何を決めるか                                 | 原理的機構                                                                           |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| **解析（value-set narrowing の値集合）** | 各コンテキストで*何が静的に分かるか*         | Conditional Value-Set Analysis = IDE + SCCP + CFA、TS union で seed、widening で有界 |
| **特殊化（monomorphization の複製判断）** | _どのコンテキストに固有 residual を与えるか_ | 残余等価クラスタリング + WQO whistle/一般化 + コスト最適抽出                         |

### 13.1 値集合解析（問題：上流追跡をどこまでやるか → 解消）

1 つの定まった解析として実装する。「レベル」は置かない。

- **抽象ドメイン**：有限リテラル集合（[Value-Set Analysis, Balakrishnan & Reps] の特殊形）。
  join=和集合。**widening 上界は prop の TS union literal 型の濃度から導出**（型を超える値の仮定は
  そもそも unsound なので ⊤）。マジックナンバー不要。
- **条件付き（[SCCP, Wegman & Zadeck]）**：分岐到達可能性と値伝播を相互再帰で同時に解き、
  実行不能経路の値を集合に混ぜない（`variant∈{primary,secondary}` がタイトに出る）。`⊥`/集合/`⊤` の3層格子。
- **手続き間（[IDE, Sagiv-Reps-Horwitz]）**：prop=関数引数として境界・ローカル束縛・`{#each}`/snippet 引数を
  貫き、**meet-over-all-valid-paths 精度・多項式時間**で伝播。copy/linear 断片は IDE 精度、非分配演算
  （文字列連結・算術）は健全に ⊤。→「行けるところまで正確に」行く。
- **高階 / escape**：`<svelte:component this={X}>` やコンポーネント値渡しは [k-CFA] / Andersen points-to で
  「X が取り得るコンポーネント集合」に解決し、bail せず特殊化対象にする。
- **フロンティアの seed**：解析が見通せない境界では TS union 型を型システムの MOVP として初期値に使う。
  `as`/`any`/非strict は ⊤（明示的 trust boundary）。

> 残るノブは「集合 widening 上界（型濃度から導出）」と「CFA 文脈深さ k」のみ。**いずれも単調＝
> 上げれば精密になるだけで決して unsound にならない健全性保証つき精度パラメータ**であり、
> 「正しさと無関係なサイズを当て推量で削る」ヒューリスティックとは性質が異なる。

### 13.2 特殊化の判断（問題：複製は得か → 測定 + 最適化）

- **複製数は内在的に有界（count ノブ不要）**：[Selective / Identifying Profitable Specialization,
  Dean-Chambers-Grove] と PE のメモ化（[Christensen & Glück]）に従い、**特殊化が*厳密に異なる*
  residual を生むコンテキストだけ複製し、同一 residual のコンテキストはクラスタリングして共有**。
  変種数＝「相異なる残余プログラム数」で意味的に有界（瓜二つコピーは構成的に発生しない）。
- **終了・肥大の保証**：再帰コンポーネントやカスケード特殊化の爆発は、**整礎順序(WQO)の
  homeomorphic embedding whistle + 最一般一般化(msg)**（[Leuschel]）が検知して安全に畳む。
  「N で打ち切り」を理論的に置換。
- **「複製は得か」は予測でなく測定**：候補 residual を自前 printer で実体化し**実サイズ
  （必要なら minify/gzip 後）を測定**、共有 vs 特殊化を **equality saturation / e-graph の
  コストベース最適抽出（[egg]、ILP 抽出）**で*厳密最小*に解く。`minSavings` の当て推量を、
  測れる目的関数に対する最適解へ置換。

### 13.3 実装上の縮約（現実解）

フルの supercompiler / k-CFA は重い。だが本ツールの対象は「prop＝関数引数、値はほぼリテラル union」
という*極めて素直な分配的断片*なので、理論の必要部分だけに絞れる：
\*\*有限集合 IDE + SCCP 到達可能性 + 距離 k の `svelte:component` 解決 + residual 等価クラスタリング

- embedding whistle\*\*。Rust(OXC) と相性良好（`oxc_semantic` が SSA/参照、egg 系が e-graph を提供）。

#### owner-local 定数の seed（`scriptConstEnv`）

現状の縮約実装で「境界を貫く」局所束縛の入り口はこれ：各コンポーネントは module/instance の
`<script>` トップレベル宣言から **owner-local で証明可能な単一プリミティブ定数**を
`scriptConstEnv`（local 名→リテラル）に事前計算し、**owner の fold 環境へマージ**する。これにより
`<Child {count}/>`（`count` が未書き換えの `let count = $state(0)` や `const count = 0`）が、
コールサイトのリテラルと同様に子で畳める（constant fold / value-set narrowing の両方に効く）。
`$state(<arg>)` / `$state.raw(<arg>)` はラッパを剥がして `<arg>` を評価（引数なしの `$state()` は
`undefined`）。健全性は保守的な採否で担保する：**プリミティブのみ**（object/`$state({...})` は proxy 深
変更の余地があるので除外）、**書き換えられる名前は不可**（再代入 / `++` / `bind:`。instance/template に
加え module スクリプト内書き込みも走査）、**テンプレート束縛子や入れ子スコープが同名を束ねる名前は不可**
（scope-blind なコールサイト評価が別実体を読み得る＝§4.1 shadowing と同じ論拠。ファイル全体で束縛回数が
ちょうど 1 の名前だけ許す）、**`$derived` / `$props` / 他 rune は対象外**、**`export const` は解析グラフ外
から到達可能なので除外**。`scriptConstEnv` は plan 非依存の静的事実なので不動点の外で 1 回だけ計算し、
owner が bail していても子への forwarding には使える（bail は owner 自身の prop 可観測性の話で、
owner が渡す定数の真実性は変えない）。JS / Rust(WASM) 両エンジンが同一セマンティクスで実装し
byte 一致を保つ。

### 参考文献

- Selective Specialization for Object-Oriented Languages — Chambers, Dean, Grove (PLDI'95)
  <https://dl.acm.org/doi/10.1145/223428.207119>
- Identifying Profitable Specialization in Object-Oriented Languages — Dean, Chambers, Grove
  <https://www.researchgate.net/publication/2819254>
- Precise Interprocedural Dataflow Analysis (IDE) — Sagiv, Reps, Horwitz
  <https://link.springer.com/chapter/10.1007/3-540-59293-8_226>
- Constant Propagation with Conditional Branches (SCCP) — Wegman & Zadeck
  <https://www.cs.utexas.edu/~pingali/CS380C/2010/papers/p291-wegman.pdf>
- DIVINE / Value-Set Analysis — Balakrishnan & Reps
  <https://link.springer.com/chapter/10.1007/978-3-540-69738-1_1>
- Improving Homeomorphic Embedding for Online Termination — Leuschel
  <https://link.springer.com/chapter/10.1007/3-540-48958-4_11>
- Controlling Generalization and Polyvariance in Partial Deduction — Christensen & Glück
  <https://dl.acm.org/doi/pdf/10.1145/271510.271525>
- egg: Fast and Extensible Equality Saturation — Willsey et al.
  <https://dl.acm.org/doi/pdf/10.1145/3434304>
