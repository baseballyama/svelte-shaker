<script lang="ts">
  import '../app.css';
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  let { children } = $props();

  let theme = $state<'light' | 'dark'>('light');
  onMount(() => {
    theme = (document.documentElement.dataset.theme as 'light' | 'dark') || 'light';
  });
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* ignore */
    }
  }
</script>

<header class="site-head">
  <a class="wordmark" href="{base}/">
    <img class="mark" src="{base}/logo.png" alt="" aria-hidden="true" />
    svelte&#8209;shaker
  </a>
  <nav>
    <a href="#playground">playground</a>
    <a href="#how">how</a>
    <a
      class="gh"
      href="https://github.com/baseballyama/svelte-shaker"
      target="_blank"
      rel="noreferrer">GitHub ↗</a
    >
    <button
      class="theme-btn"
      onclick={toggleTheme}
      aria-label="Toggle dark mode"
      title="Toggle dark mode">{theme === 'dark' ? '☀' : '☾'}</button
    >
  </nav>
</header>

{@render children()}

<footer class="site-foot">
  <span
    >Built with the engine itself, running in your browser. No server. MIT.</span
  >
  <a href="https://github.com/baseballyama/svelte-shaker" target="_blank" rel="noreferrer"
    >github.com/baseballyama/svelte-shaker</a
  >
</footer>

<style>
  .site-head {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px clamp(16px, 4vw, 48px);
    border-bottom: 1px solid var(--line);
    background: var(--head-bg);
    backdrop-filter: blur(10px);
  }
  .theme-btn {
    background: transparent;
    border: 1px solid var(--line);
    color: var(--ink-dim);
    width: 28px;
    height: 28px;
    border-radius: 7px;
    font-size: 13px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      color 0.15s,
      border-color 0.15s;
  }
  .theme-btn:hover {
    color: var(--accent);
    border-color: var(--line-2);
  }
  .wordmark {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-family: var(--display);
    font-weight: 800;
    font-size: 15px;
    letter-spacing: -0.02em;
    color: var(--ink);
  }
  .wordmark:hover {
    text-decoration: none;
  }
  .mark {
    width: 26px;
    height: 26px;
    object-fit: contain;
    /* nudge so the tilted mascot sits optically centered on the baseline */
    margin-top: -2px;
  }
  nav {
    display: flex;
    align-items: center;
    gap: clamp(12px, 3vw, 26px);
    font-size: 13px;
  }
  nav a {
    color: var(--ink-dim);
  }
  nav a:hover {
    color: var(--ink);
    text-decoration: none;
  }
  nav .gh {
    color: var(--accent);
  }

  .site-foot {
    border-top: 1px solid var(--line);
    margin-top: 80px;
    padding: 28px clamp(16px, 4vw, 48px);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: space-between;
    color: var(--ink-faint);
    font-size: 12.5px;
  }
</style>
