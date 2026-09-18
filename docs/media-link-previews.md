# Post link previews

Both feed layouts and reposts display cards for up to three distinct HTTP(S)
links per post. Cards use existing `link_meta_*` fields when they match the
linked URL. Missing metadata falls back to the hostname. Existing posts do not
need to be edited to display cards.

YouTube links (including shortened, Shorts, live and timestamped URLs) get a
thumbnail even without saved metadata. Clicking Play mounts a privacy-enhanced
YouTube iframe. Vimeo links, including unlisted privacy hashes, also support
click-to-play. Direct MP4/WebM/OGV video and MP3/M4A/OGG/WAV/OGA audio links mount
native controls only on click. Other websites open from their preview card.

Playback survives unrelated post updates. Changing/removing the URL or closing
the player unmounts it. The original link remains available when a provider
restricts embedding or a file is unavailable. No arbitrary remote HTML is used
as an embed. Player iframe origins are restricted by URL construction to
YouTube and Vimeo. Their iframe referrer policy sends the embedding origin,
which YouTube requires even though the site defaults to `no-referrer`.

Validation:

- Container: `node --test src/lib/linkPreviews.test.js` and `npm run build`
  from the frontend package.
- Browser: `playwright test tests/e2e/media-link-previews.spec.js` against an
  isolated frontend dev server. The tests use mocked provider responses, cover
  both layouts, and do not create production posts or require real accounts.

Provider availability and actual remote playback are not asserted by the
mocked browser suite.

## Deployment

Commit `17bc708` was integrated into main and deployed on 2026-09-18 from
the isolated worktree after a successful container production build. The
previous release is backed up at
`/tmp/intellacc-before-media-previews-20260918T191556Z.tar.gz`.
Publication checked the previous live index and main revision before switching
the entry file, and retained older hashed assets for existing browser tabs.

All 50 public build files (index, service worker, JavaScript, CSS and WASM)
matched the release byte-for-byte. The entry is `index-Bbsl0rDj.js`.
The public API health check passed. The real Cybersocialism post, ID 2208,
displayed its YouTube thumbnail and opened/closed the inline player in the Van
layout without page errors or failed application assets. YouTube requested
sign-in for an anti-bot check in the server's browser, so remote playback itself
could not be confirmed. The terminal shell loaded without errors. Its feed
requires login, and its preview behavior was verified in the isolated browser
suite rather than with a production account. Both layouts passed the five
browser tests, alongside six URL unit tests, before deployment.

No backend restart or database migration was required. Unrelated backend
working-tree changes were preserved.
