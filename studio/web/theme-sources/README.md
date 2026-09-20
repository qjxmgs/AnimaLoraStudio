# Theme artwork sources

This directory keeps the full-resolution theme artwork outside `public/` so Vite does not
copy multi-megabyte source images into the runtime bundle.

The current character sources were copied from `dist/themes/{sakura,sky,star}/character.png`
on 2026-09-20, as requested by the maintainer. Scene sources came from the same directories.

After replacing any source image, regenerate the browser assets from `studio/web`:

```powershell
npm run assets:themes
```

The generated files under `public/themes/` are intentionally split by use case:

- `character-card.png`: complete transparent character artwork, scaled to 192 px high for the appearance gallery.
- `character-avatar.png`: 40 × 40 sidebar brand portrait.
- `character-avatar@2x.png`: 80 × 80 sidebar brand portrait for high-density displays.
- `character-hero.png`: 290 px high, standard-density welcome banner.
- `character-hero@2x.png`: 580 px high, high-density welcome banner.
- `scene-*-1280.jpg`: compact desktop scene.
- `scene-*-1920.jpg`: wide/high-density desktop scene.
