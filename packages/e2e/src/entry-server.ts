import { render as ssrRender } from 'svelte/server';
import App from './App.svelte';

// SSR entry exported for the differential oracle in tests/e2e.test.ts.
// Vite builds this file in SSR mode; the test imports the compiled bundle
// and calls render() to get observable HTML for comparison.
export function render(): { head: string; body: string } {
  return ssrRender(App, { props: {} });
}
