<script lang="ts">
  // Pattern 13: imported through the barrel re-export (index.ts).
  import {
    AliasedProp,
    Bindable,
    DynamicComponent,
    MultiCallSites,
    TernaryNestedFold,
    RestProps,
    ShorthandFold,
    Snippets,
    StyleStrip,
    TernaryFold,
    TypedProps,
  } from './patterns/index.ts';

  // Pattern 3: the real mode-watcher ModeWatcher component.
  // Rendered with no props so the shaker sees every prop at its default.
  // This is the component that triggered issue #37.
  import { ModeWatcher } from 'mode-watcher';
</script>

<!-- Pattern 3: real ModeWatcher from mode-watcher — exercises the
     aliased-prop + same-named-import bug (#37) against the actual library. -->
<ModeWatcher />

<!-- Pattern 1: shorthand prop fold + dead {#if} arm. -->
<ShorthandFold />

<!-- Pattern 2: local reproduction of the #37 aliased-prop pattern. -->
<AliasedProp />

<!-- Pattern 4: folded prop substituted inside a collapsed ternary arm. -->
<TernaryNestedFold />

<!-- Pattern 5: rest props + spread.  `hidden` folds to false; rest survives. -->
<RestProps hidden={false} id="box-1" class="rest-box" />

<!-- Pattern 6: same constant from two call sites → shaker folds. -->
<MultiCallSites variant="primary" />
<MultiCallSites variant="primary" />

<!-- Pattern 7: ternary folding. -->
<TernaryFold isActive={false} />

<!-- Pattern 8: CSS class stripping.  Two values keep primary/secondary rules;
     danger and ghost are dead and should be stripped. -->
<StyleStrip variant="primary" />
<StyleStrip variant="secondary" />

<!-- Pattern 9: snippets + {#each} with shadowing. -->
<Snippets />

<!-- Pattern 10: $bindable() prop (no bind: at call site). -->
<Bindable />

<!-- Pattern 11: dynamic component — engine bails, output unchanged. -->
<DynamicComponent />

<!-- Pattern 12: TypeScript-typed props with lang="ts" interface. -->
<TypedProps title="e2e test" />
