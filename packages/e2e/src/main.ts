import { mount } from 'svelte';
import App from './App.svelte';

// Client entry used only in the smoke-build test to confirm that Vite's
// client-side bundler succeeds with the shaker applied.
mount(App, { target: document.body });
