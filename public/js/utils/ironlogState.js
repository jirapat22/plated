// What an /api/ironlog/today response actually means.
//
// The route answers `connected: false` for two situations that could not be
// more different: this profile has no IronLog at all, and IronLog is there but
// could not be reached right now. It used to pair that with
// `calories_burned: 0`, and Today believed it — so a blip between Railway and
// IronLog took the Eat Target ring off the screen and labelled the day a rest
// day, then put it back on the next successful poll. That is the "eat target
// keeps missing and coming back" you can watch happen.
//
// `last_synced` is the tell. It is only written once a sync has actually
// succeeded, so its presence means "there IS an IronLog here" no matter what
// this particular request managed to do.
//
// Lives in its own file rather than inside today.js so it can be tested without
// a DOM — the view cannot be imported outside a browser.

// data      → IronLog answered; use it.
// null      → no IronLog for this profile; any burn on screen is wrong, clear it.
// undefined → could not ask; a burn on screen is not wrong, only old.
export function classifyIronlog(data) {
  if (data?.connected) return data;
  return data?.last_synced ? undefined : null;
}
