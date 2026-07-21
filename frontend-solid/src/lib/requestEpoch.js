// Shared guard against stale async responses ("fetch epoch" pattern).
//
// Several views/stores fetch data keyed by a route param that can change while
// a request is still in flight; without a guard the late response clobbers the
// newer state. Usage:
//
//   const guard = createEpochGuard();
//   const load = async () => {
//     const token = guard.begin();          // supersedes any in-flight load
//     const data = await fetchStuff();
//     if (!guard.isCurrent(token)) return;  // a newer load started — discard
//     setState(data);
//   };
//
// For actions that should only apply while the current load's context is still
// valid (e.g. a follow toggle tied to the profile currently shown), capture
// `guard.current()` instead of `begin()` so the action does not invalidate the
// load itself. `invalidate()` marks every outstanding token stale without
// starting a new request (e.g. when clearing state on logout).
export function createEpochGuard() {
  let epoch = 0;
  return {
    begin() { return ++epoch; },
    current() { return epoch; },
    isCurrent(token) { return token === epoch; },
    invalidate() { ++epoch; }
  };
}
