<script lang="ts">
  import { base } from '$app/paths';
  import Playground from '$lib/Playground.svelte';
</script>

<svelte:head>
  <title>svelte-shaker — delete the Svelte code your bundler can't</title>
</svelte:head>

<main>
  <section class="hero">
    <div class="hero-top">
      <div class="hero-lead">
        <div class="tagline mono-label">whole-program · source-level · Svelte 5</div>
        <h1>
          Your bundler ships the component code your app
          <span class="strike">never runs</span>. svelte-shaker deletes it.
        </h1>
      </div>
      <img
        class="hero-logo"
        src="{base}/logo.png"
        alt="svelte-shaker — the Svelte logo shaking a cocktail shaker"
        width="200"
        height="195"
      />
    </div>
    <p class="lede">
      A design-system <code>&lt;Button&gt;</code> has 30 props; your app passes 5.
      The dead branches behind the other 25 — the <code>&lt;Spinner&gt;</code> and
      <code>&lt;Icon&gt;</code> they pull in, the reactive code, the
      <code>.btn-danger</code> CSS — all ship to your users anyway.
      <strong>svelte-shaker</strong> reads how your <em>whole app</em> actually
      calls every component and removes what can never run, at the source, before
      the compiler — without ever changing what renders.
    </p>
    <div class="why">
      <div class="why-card">
        <span class="k">A bundler can't remove this.</span>
        After Svelte compiles, a prop's value flows through the runtime — it isn't
        a static constant, so Rollup/terser can't fold an
        <code>{'{#if loading}'}</code> branch away, drop the
        <code>&lt;Spinner&gt;</code> module it guards, or delete a
        <code>.btn-danger</code> rule hiding behind <code>class="btn-{'{variant}'}"</code>.
      </div>
      <div class="why-card">
        <span class="k">Whole-program, so it cascades.</span>
        Folding a prop deletes a <code>&lt;Child/&gt;</code> call; that can make the
        child itself unused, which shrinks <em>its</em> profile, and so on. It
        iterates to a fixpoint — then hands slimmed source to the compiler, which
        compiles only what survives.
      </div>
    </div>
    <div class="levels">
      <span class="lv"><b>L0</b> unused props</span>
      <span class="lv"><b>L1</b> whole-app constants</span>
      <span class="lv"><b>L1.5</b> value-set + dead CSS</span>
      <span class="lv"><b>L2</b> monomorphize</span>
    </div>
  </section>

  <section id="playground" class="play">
    <div class="play-head">
      <h2>Try it</h2>
      <span class="play-sub"
        >The engine runs entirely in your browser. Edit the source — the shaken
        output updates live.</span
      >
    </div>
    <Playground />
  </section>

  <section id="how" class="how">
    <h2>How it works</h2>
    <div class="steps">
      <div class="step">
        <span class="num">01</span>
        <h3>Crawl every call site</h3>
        <p>
          Starting from your entry, it walks the component graph and records the
          value passed to every prop at every <code>&lt;Child/&gt;</code> — a
          literal, a default, or "unknown".
        </p>
      </div>
      <div class="step">
        <span class="num">02</span>
        <h3>Decide what's reachable</h3>
        <p>
          Props that are never passed fold to their default; props that are one
          constant app-wide fold to it; multi-valued props keep only the arms
          their value set can reach. It iterates to a whole-program fixpoint, so
          folds cascade.
        </p>
      </div>
      <div class="step">
        <span class="num">03</span>
        <h3>Slim the source, then compile</h3>
        <p>
          Dead branches, unused props, and unreachable CSS rules are deleted from
          the <code>.svelte</code> source. Svelte compiles only what your app can
          reach. Soundness is checked by server-rendering before vs after.
        </p>
      </div>
    </div>
    <p class="caveat">
      Sound by construction: when a transform can't be proven safe (spreads,
      <code>bind:</code>, dynamic components, shadowed names…), the code is left
      untouched. Build-time only; ships as a Vite / Rollup plugin.
    </p>
    <pre class="install"><span class="c"># Vite</span>
import &#123; shaker &#125; from <span class="s">'svelte-shaker/vite'</span>;
plugins: [shaker(&#123; include: [<span class="s">'src'</span>] &#125;), svelte()]</pre>
    <p class="caveat rust-note">
      <strong>Faster builds with the rsvelte (Rust) parser.</strong> Parsing is
      ~85% of the pipeline, so swapping <code>svelte/compiler</code> for rsvelte's
      native parser makes a real 474-component build <strong>~1.46x faster</strong>
      (parse alone ~2.2x). Install the optional peer
      <code>@rsvelte/vite-plugin-svelte-native</code> and opt in — soundness is
      unchanged:
    </p>
    <pre class="install"><span class="c"># opt in to the Rust parser</span>
plugins: [shaker(&#123; include: [<span class="s">'src'</span>], parser: <span class="s">'rsvelte'</span> &#125;), svelte()]</pre>
  </section>
</main>

<style>
  main {
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 clamp(16px, 4vw, 48px);
  }

  .hero {
    padding: clamp(48px, 9vw, 110px) 0 36px;
  }
  .hero-top {
    display: flex;
    align-items: center;
    gap: clamp(20px, 4vw, 56px);
  }
  .hero-lead {
    flex: 1;
    min-width: 0;
  }
  .hero-logo {
    flex-shrink: 0;
    width: clamp(120px, 17vw, 200px);
    height: auto;
    filter: drop-shadow(0 8px 22px rgba(255, 62, 0, 0.18));
    /* pivot near the feet so it reads as rocking while working the shaker */
    transform-origin: 52% 82%;
    animation: shake 2.6s ease-in-out infinite;
    will-change: transform;
  }
  /* hover: shake harder, like it heard the order */
  .hero-logo:hover {
    animation-duration: 0.85s;
  }
  @keyframes shake {
    0%,
    100% {
      transform: translateY(0) rotate(0deg);
    }
    18% {
      transform: translateY(-5px) rotate(-2.4deg);
    }
    38% {
      transform: translateY(0) rotate(1.9deg);
    }
    58% {
      transform: translateY(-3px) rotate(-1.4deg);
    }
    78% {
      transform: translateY(0) rotate(1deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .hero-logo {
      animation: none;
    }
  }
  .tagline {
    margin-bottom: 20px;
    color: var(--accent);
    opacity: 0.9;
  }
  h1 {
    font-size: clamp(30px, 5.4vw, 58px);
    line-height: 1.04;
    max-width: 18ch;
    letter-spacing: -0.035em;
  }
  h1 .strike {
    color: var(--del);
    text-decoration: line-through;
    text-decoration-thickness: 3px;
    text-decoration-color: color-mix(in srgb, var(--del) 60%, transparent);
  }
  .lede {
    margin: 26px 0 0;
    max-width: 66ch;
    font-size: 15px;
    color: var(--ink-dim);
    line-height: 1.75;
  }
  .lede strong {
    color: var(--ink);
  }
  code {
    color: var(--code-fg);
    background: var(--accent-bg);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.92em;
  }

  .why {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin: 34px 0 30px;
  }
  .why-card {
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--panel);
    padding: 16px 18px;
    font-size: 13.5px;
    color: var(--ink-dim);
    line-height: 1.7;
  }
  .why-card .k {
    display: block;
    color: var(--ink);
    font-weight: 700;
    margin-bottom: 6px;
  }

  .levels {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .lv {
    border: 1px solid var(--line-2);
    border-radius: 999px;
    padding: 5px 13px;
    font-size: 12.5px;
    color: var(--ink-dim);
  }
  .lv b {
    font-family: var(--display);
    color: var(--accent);
    margin-right: 5px;
  }

  .play {
    padding-top: 18px;
    scroll-margin-top: 64px;
  }
  .play-head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .play-head h2,
  .how h2 {
    font-size: clamp(22px, 3vw, 30px);
    letter-spacing: -0.02em;
  }
  .play-sub {
    color: var(--ink-faint);
    font-size: 13px;
  }

  .how {
    padding-top: 70px;
    scroll-margin-top: 64px;
  }
  .steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin: 26px 0 22px;
  }
  .step {
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--panel);
    padding: 20px;
  }
  .step .num {
    font-family: var(--display);
    font-weight: 800;
    font-size: 13px;
    color: var(--accent);
    opacity: 0.7;
  }
  .step h3 {
    font-size: 16px;
    margin: 10px 0 8px;
  }
  .step p {
    margin: 0;
    color: var(--ink-dim);
    font-size: 13px;
    line-height: 1.7;
  }
  .caveat {
    color: var(--ink-faint);
    font-size: 13px;
    max-width: 80ch;
    line-height: 1.7;
  }
  .rust-note {
    margin-top: 26px;
  }
  .rust-note strong {
    color: var(--ink);
  }
  .install {
    margin-top: 22px;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--bg-1);
    padding: 16px 18px;
    font-size: 13px;
    color: var(--ink);
    overflow-x: auto;
  }
  .install .c {
    color: var(--ink-faint);
  }
  .install .s {
    color: var(--code-fg);
  }

  @media (max-width: 760px) {
    .why,
    .steps {
      grid-template-columns: 1fr;
    }
    .hero-top {
      flex-direction: column-reverse;
      align-items: center;
      gap: 14px;
    }
    .hero-lead {
      width: 100%;
    }
    .hero-logo {
      width: 132px;
    }
  }
</style>
