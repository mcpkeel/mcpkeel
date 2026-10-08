# mcpkeel.app

The landing page: plain HTML, CSS and one small script in `public/`. No build step. Fonts are self-hosted, and `public/_headers` sets a strict Content-Security-Policy.

## Preview

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```

`wrangler.jsonc` attaches the site to `mcpkeel.app` and `www.mcpkeel.app` as custom domains. Because the zone is on the same Cloudflare account, the deploy creates the DNS records and certificates.
