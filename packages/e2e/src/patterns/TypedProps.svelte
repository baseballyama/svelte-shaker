<script lang="ts">
  // Pattern 12: TypeScript-typed props with lang="ts" and an inline interface.
  // `subtitle` and `featured` are never passed → fold to their defaults.
  // The `featured` fold makes `.featured` a dead CSS rule.
  interface CardProps {
    title: string;
    subtitle?: string;
    featured?: boolean;
  }

  let { title, subtitle = 'default subtitle', featured = false }: CardProps = $props();
</script>

<article class:featured>
  <h2>{title}</h2>
  <p>{subtitle}</p>
</article>

<style>
  .featured {
    border: 2px solid gold;
  }
</style>
