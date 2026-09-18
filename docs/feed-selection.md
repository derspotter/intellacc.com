# Home feed selection and order

The home feed always displays selected posts newest first (`created_at DESC`,
then `id DESC`). Feed Mix weights affect inclusion, never display order.

For users with saved weights, the API considers five times the requested page
size in recent eligible posts (normally 100 candidates for a 20-post page,
bounded to 250 candidates). It scores accuracy, followers, likes and views using
the saved weights, with logarithmic engagement signals and per-window
normalization. It selects the highest-scoring page of posts, breaks score ties
by recency, and returns that selection in chronological order. A pool smaller
than one page is returned in full. Without saved weights, normal chronological
pagination applies with no score filtering.

Pagination advances past the entire candidate window, including posts not
selected. The next page therefore cannot surface a previously omitted post
above a post already displayed. Hidden/blocked-post restrictions are applied
before candidate selection. Only returned posts are recorded as viewed.

Both frontend layouts retain chronological order after local submission and
pagination. Newly submitted posts have no special ranking priority. Existing
Feed Mix settings and controls remain available.
