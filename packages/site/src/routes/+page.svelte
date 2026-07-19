<script lang="ts">
  import { base } from '$app/paths';
  import Playground from '$lib/Playground.svelte';
</script>

<svelte:head>
  <title>svelte-shaker — delete the Svelte code your bundler can't</title>
</svelte:head>

<main>
  <section class="hero">
    <div class="hero-lead">
      <div class="tagline mono-label">whole-program · source-level · Svelte 5</div>
      <h1>
        Your bundler ships component code your app
        <span class="strike">never runs</span>. svelte-shaker deletes it.
      </h1>
      <p class="lede">
        It reads how your whole app calls every component, folds props that
        never vary, and deletes the dead branches, CSS, and modules behind them
        — at the source, before the Svelte compiler. When a change can't be
        proven safe, the code is left untouched.
      </p>
    </div>
    <img
      class="hero-logo"
      src="{base}/logo.png"
      alt="svelte-shaker — the Svelte logo shaking a cocktail shaker"
      width="200"
      height="195"
    />
  </section>

  <section id="playground" class="play">
    <div class="play-head">
      <h2>Try it</h2>
      <p class="play-sub">
        The engine runs in your browser. The app only ever renders
        <code>&lt;Button variant="primary"&gt;</code> — so <code>loading</code>
        folds away, the <code>&lt;Spinner&gt;</code> it guarded drops from the
        bundle, and <code>.btn-danger</code> can never match. Edit either side
        of the story and watch the output update.
      </p>
    </div>
    <Playground />
  </section>

  <section id="how" class="how">
    <h2>How it works</h2>
    <ol class="steps">
      <li>
        <b>Crawl every call site.</b> From your entry, it records the value
        passed to every prop at every <code>&lt;Child/&gt;</code> — a literal,
        a default, or "unknown".
      </li>
      <li>
        <b>Decide what's reachable.</b> Props that never vary fold to their
        constant; only branches and CSS their values can reach survive. Folds
        cascade to a whole-program fixpoint.
      </li>
      <li>
        <b>Slim the source, then compile.</b> Dead code is deleted from the
        <code>.svelte</code> files, and Svelte compiles only what's left.
      </li>
    </ol>
    <p class="caveat">
      Sound by construction: anything unprovable (spreads, <code>bind:</code>,
      dynamic components…) bails and ships unchanged. Build-time only, as a
      Vite / Rollup plugin — <code>include</code> must cover the whole app.
    </p>
    <pre class="install"><span class="c"># vite.config.ts</span>
import &#123; shaker &#125; from <span class="s">'svelte-shaker/vite'</span>;
plugins: [shaker(&#123; include: [<span class="s">'src'</span>] &#125;), svelte()]</pre>
  </section>
</main>

<style>
  main {
    max-width: 1060px;
    margin: 0 auto;
    padding: 0 clamp(16px, 4vw, 48px);
  }

  .hero {
    display: flex;
    align-items: center;
    gap: clamp(24px, 5vw, 64px);
    padding: clamp(32px, 5vw, 64px) 0 48px;
  }
  .hero-lead {
    flex: 1;
    min-width: 0;
  }
  .hero-logo {
    flex-shrink: 0;
    width: clamp(120px, 17vw, 190px);
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
    margin-bottom: 18px;
    color: var(--accent);
  }
  h1 {
    font-size: clamp(30px, 5vw, 52px);
    line-height: 1.08;
    max-width: 20ch;
    letter-spacing: -0.03em;
  }
  h1 .strike {
    color: var(--del);
    text-decoration: line-through;
    text-decoration-thickness: 3px;
    text-decoration-color: color-mix(in srgb, var(--del) 60%, transparent);
  }
  .lede {
    margin: 24px 0 0;
    max-width: 58ch;
    font-size: 17px;
    color: var(--ink-dim);
    line-height: 1.75;
  }

  code {
    color: var(--code-fg);
    background: var(--accent-bg);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.9em;
  }

  h2 {
    font-size: clamp(22px, 3vw, 28px);
    letter-spacing: -0.02em;
  }

  .play {
    padding-top: 16px;
    scroll-margin-top: 64px;
  }
  .play-head {
    margin-bottom: 18px;
  }
  .play-sub {
    margin: 10px 0 0;
    max-width: 66ch;
    color: var(--ink-dim);
    font-size: 15px;
    line-height: 1.7;
  }

  .how {
    padding-top: 72px;
    scroll-margin-top: 64px;
    max-width: 74ch;
  }
  .steps {
    margin: 22px 0 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
  }
  .steps li {
    counter-increment: step;
    position: relative;
    padding: 0 0 18px 44px;
    color: var(--ink-dim);
    font-size: 15.5px;
    line-height: 1.7;
  }
  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 1px;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line-2);
    border-radius: 50%;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
  }
  .steps li b {
    color: var(--ink);
  }
  .caveat {
    margin: 6px 0 0;
    color: var(--ink-faint);
    font-size: 14.5px;
    line-height: 1.7;
  }
  .install {
    margin-top: 24px;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--bg-1);
    padding: 16px 18px;
    font-size: 14px;
    line-height: 1.7;
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
    .hero {
      flex-direction: column-reverse;
      align-items: center;
      gap: 18px;
      text-align: initial;
    }
    .hero-lead {
      width: 100%;
    }
    .hero-logo {
      width: 128px;
    }
  }
</style>
