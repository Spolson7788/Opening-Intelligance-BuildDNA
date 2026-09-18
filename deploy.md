# Netlify Drop — this archive is the site root

Drag onto https://app.netlify.com/drop.

```
index.html           the app
portal.html          the facility portal (not renamed)
netlify.toml         publish = "." · functions = "netlify/functions"
netlify/functions/   vision.js · monthly-accuracy.js · overdue-inspections.js
accuracy.html  inspect.html  manifest.json  sw.js  icon-192.png  icon-512.png
```

## After the first deploy

**Site configuration → Environment variables**: add `ANTHROPIC_API_KEY` — all
capitals — with the **Functions** scope and the **Production** context, then
redeploy. Variables are read at function build time, so an existing deploy will
not pick up a newly added key. Names are case-sensitive on Linux.

## What is not here

Tests, the frozen Cal-Royal fixture, the evaluation corpus and the reports ship
in the separate private evaluation archive. Netlify Drop publishes every file in
the zip at a public URL, and the fixture contains customer photographs and their
verified ground truth. None of that belongs on a public site.
