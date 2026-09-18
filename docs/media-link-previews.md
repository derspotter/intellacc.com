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
