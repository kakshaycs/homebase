# Homebase

**Everything you open, in one place.**

A Chrome New Tab replacement: a drag-and-drop dashboard of resizable panels —
bookmarks, a board of grouped cards, GitHub PRs, clock, weather, tasks, quotes and
your next Google Calendar meeting — with an Arc-style ⌘K command bar over all of it.

Vanilla JS, no build step, no dependencies, no analytics. Everything is stored locally
in `chrome.storage.local`; the only network calls are to the APIs you explicitly connect.

![Homebase dashboard](docs/screenshot.png)

---

## Setup

### 1. Install the extension

```bash
git clone https://github.com/kakshaycs/homebase.git
```

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the cloned folder
4. Open a new tab — the first run builds a starter layout from your bookmark folders

> **The extension ID is pinned.** `manifest.json` carries a `key`, so Chrome always
> assigns the same ID no matter where the folder lives or which machine it is on. That
> means the folder can be moved without wiping `chrome.storage.local`, and the Google
> OAuth redirect URI only ever needs registering once.

After editing any file, press ↻ on the extension's card at `chrome://extensions`.

### 2. Optional integrations

Everything below is optional — the dashboard works without any of it. Panels that need
setup say so and link to the right screen.

| Panel | What you need | Where |
|---|---|---|
| 🐙 **GitHub PRs** | a classic PAT with the `repo` scope + your username | ⚙ Settings |
| ⛅ **Weather** | just a city name (Open-Meteo — no key, no account) | in the panel |
| 📅 **Next meeting** | a Google OAuth client ID, or a secret iCal URL | in the panel |
| 🖼 **Wallpaper** | a bundled image, a local file, or an https URL | ⚙ Settings |

<details>
<summary><b>GitHub PRs — token setup</b></summary>

1. github.com → Settings → Developer settings → **Personal access tokens (classic)**
2. Generate a token with the **`repo`** scope
3. Paste it into ⚙ Settings along with your GitHub username

The token is stored in `chrome.storage.local`, only ever sent to `api.github.com`, and
is stripped from exported layouts.
</details>

<details>
<summary><b>Next meeting — Google Calendar setup</b></summary>

See **[Next meeting (Google Calendar)](#next-meeting-google-calendar)** below for both
options. The OAuth route is live and accurate; the iCal route needs no Cloud project but
Google caches the feed.
</details>

### 3. Make it yours

- **✎ Edit** in the topbar adds panels and opens Wallpaper / Settings
- Drag panels by their header, resize from the edges, `⋯` for per-panel options
- **🔓 → 🔒** (or `l`) locks the layout once you are happy with it
- ⚙ Settings → **Export layout** gives you a JSON backup you can import on another machine

---

## Panel types
**✎ Edit** in the topbar opens the dashboard menu — every panel type, plus
**🖼 Wallpaper…** and **⚙ Settings…**:

| type | what it does |
|---|---|
| 🔖 **Bookmarks** | your icon+name link groups |
| 🐙 **GitHub PRs** | Created by me · Review requested · Assigned to me |
| 🕘 **Clock** | big time + long date + an optional focus line |
| ⛅ **Weather** | current temp, condition, feels-like, 5-day strip |
| ❝ **Quote** | quote of the day, or shuffle with `⟳` |
| ✓ **To-do list** | checkboxes, High/Medium/Low tags, completion bar |
| ▦ **Board** | one large panel holding small cards, with tabs |
| 📅 **Next meeting** | countdown to your next Google Calendar event |

### Clock
Menu (`⋯`): 24-hour time, show seconds, and edit the line under the clock.
Type scales with panel size via container queries — make it big and it gets big.

### Weather
Powered by **Open-Meteo — no API key, no account, no tracking.** On first add it
asks for a city, geocodes it, and remembers the coordinates. Menu: change location,
switch °C/°F, refresh. Cached 15 minutes.

### Quote
50 quotes bundled offline — no network call at all. Defaults to *quote of the day*
(stable for the whole calendar day); `⟳` shuffles and pins a random one. Menu can
switch back to daily or copy the quote.

### Tasks
`+` in the header (or `⋯ → Add a task`) focuses the input; `Enter` adds. Click the
checkbox to complete, click the **priority pill** to cycle High → Medium → Low,
double-click the text to edit. The footer tracks *“N of M tasks completed”* with a
progress bar. Menu: clear completed, sort by priority.

### Next meeting (Google Calendar)
Shows **“in 10 min”** / **“10 min ago”** / **“Happening now”** for your next event,
with its time range, a **Join →** button when the invite carries a Meet/Zoom/Teams/Webex
link, and the following few meetings underneath.

Two ways to connect, switchable from the panel menu.

#### A. Sign in with Google (recommended — live, no caching lag)

One-time setup at [console.cloud.google.com](https://console.cloud.google.com):

1. Create or pick a project
2. **APIs & Services → Library** → enable **Google Calendar API**
3. **OAuth consent screen** → *External* → add your own address under **Test users**
4. **Credentials → Create credentials → OAuth client ID → Web application**
5. Under **Authorised redirect URIs**, add the URI the panel shows (Copy button next
   to it). Thanks to the `key` pinned in `manifest.json`, this is **the same on every
   machine**, so you only register it once:
   `https://hhmpnnbmeeanjjelfoidbeplmondeeef.chromiumapp.org/`

   The field in ⚙ Settings is editable with a **Reset** button, in case you need to point
   at a different registered value. Note that Chrome only intercepts redirects on its own
   `chromiumapp.org` origin — a different host is flagged inline and sign-in will hang on
   it. Leave it blank to use the derived default.
6. Paste the generated **Client ID** into the panel and hit **Connect**

No client secret is involved: this uses `chrome.identity.launchWebAuthFlow` with the
implicit flow. Tokens last about an hour and are renewed silently while you have a
Google session; if renewal fails the panel shows a **Sign in with Google** button.
Scope requested is `calendar.readonly` — read-only, nothing else.

Menu: the connected account is shown at the top, plus **Switch Google account…**,
**Choose calendar…** (lists every calendar you can read), hide declined, hide all-day,
look ahead 6/12/24h, sign out.

> **"The user did not approve access"?** Chrome reports a Google-side error page
> identically to a real cancellation. Nine times out of ten it means the redirect URI
> shown in the panel's diagnostics is not registered on your OAuth client.
>
> **Several Google accounts in one browser?** Every explicit sign-in forces Google's
> account chooser: `prompt=select_account`, **no `login_hint`** (a hint makes Google skip
> the chooser), and the cached token is discarded first — otherwise a token for the wrong
> account is simply reused and no window ever opens. **Switch Google account…** also
> revokes the old grant at Google's end, so you get a clean choice.
>
> The connected address is read back from the primary calendar and shown at the top of
> the panel menu, and is used as a `login_hint` only for *silent* hourly renewals, to
> stop them drifting to the browser's default account.

> Because the consent screen is in *Testing*, Google shows an "unverified app" warning —
> **Advanced → Go to app** to proceed. That is expected for a personal-use extension.
> If your Workspace blocks third-party OAuth apps, create the project under a personal
> Google account, or fall back to the iCal option below.

#### B. Secret iCal URL (no Cloud project, but Google caches the feed)

1. Open `calendar.google.com` **on a computer** (the mobile app has no iCal address)
2. Left sidebar → **My calendars** → hover your calendar → **⋮** → **Settings and sharing**
3. Scroll to the bottom, to the **Integrate calendar** section
4. Copy **Secret address in iCal format** (click the eye icon to reveal it)

**If there is no “Secret address in iCal format”**, your Workspace admin has turned off
external calendar sharing — use option A instead.

Relative labels tick every 30 seconds; the feed is refetched every 5 minutes. Menu:
change URL, refresh, hide all-day events, look ahead 6/12/24h.

In OAuth mode the API expands recurrences server-side (`singleEvents=true`). In iCal
mode the bundled parser handles them — `RRULE` (daily/weekly/monthly/yearly with
`INTERVAL`, `BYDAY`, `COUNT`, `UNTIL`), `EXDATE` skips, `RECURRENCE-ID` overrides for a
moved instance, cancelled events, all-day events, and `TZID` timezone conversion.

> ⚠️ **Two caveats.** The secret iCal URL is a *bearer credential* — anyone holding it
> can read that calendar. It is stored in `chrome.storage.local` and stripped from
> exported layouts, but treat it like a password. Also, Google **caches** this feed:
> events created or moved in the last few hours may not appear immediately. Longstanding
> meetings are accurate; a meeting booked five minutes ago may not be.

### Moving your dashboard to another machine
The layout lives in `chrome.storage.local`, **not in the repo** — cloning the code on a
second laptop gives you a fresh, empty dashboard. To carry your setup across:

1. On the old machine: ⚙ Settings → **Export to file** (downloads a `.json`)
2. On the new one: ⚙ Settings → **Import from file**
3. Re-enter your GitHub token and calendar URL — those are deliberately never exported

The import verifies the write and reads it back, so it tells you if the save failed
rather than appearing to work until the next new tab. An *uploaded* wallpaper is not
included (it is a multi-megabyte data URL); re-pick it on the new machine.

### Small windows
**The dashboard never scrolls sideways.** When the layout is wider than the window, the
canvas is **scaled down to fit** — your saved panel geometry is never rewritten, so a
narrow window is a temporary view and the full-size layout returns the moment you widen
it again. Dragging and resizing account for the scale, and are clamped so overflow cannot
be created in the first place.

**Browser zoom is respected.** `Ctrl/Cmd +` makes everything bigger, as it should — the
auto-fit and the stacked breakpoint both step aside while you are zoomed, so zooming can
never rearrange the layout (it used to fight you: the auto-fit cancelled your zoom out
again). Pan horizontally while zoomed; `Ctrl/Cmd 0` then `0` returns to normal.

Below 900px, **at normal zoom**, the free canvas is abandoned and panels **stack into a
single column** —
fixed pixel coordinates laid out for a wide screen would otherwise just be clipped.
Dragging and resizing are disabled while stacked, and your saved positions are left
untouched, so widening the window restores the layout exactly.

### Locking the layout
The **🔓 / 🔒** button in the topbar (or `l`) locks the dashboard: panels can no longer be
**dragged, resized or deleted**, and the resize handles disappear. Everything *inside* a
panel still works — add and rename bookmarks, tick tasks, add board cards, switch tabs,
open the menu. Use it once you have the arrangement you want, so a stray drag can't
scatter it. The state persists.

### Per-panel filter
Every scrollable Bookmarks / Board / GitHub / To-do panel grows a **filter box** at the
top as soon as its content overflows. `⌕` in the header opens it on demand; `Esc`
clears it. The filter is per-panel and resets on a new tab.

### Renaming a bookmark
Hover a bookmark and click **✎**, or double-click its name. It edits **the name**, not
the URL, and the link stops navigating while you type. `Enter` saves, `Esc` cancels.
Useful for links dragged in from another tab, which arrive named after their hostname.

### Panel opacity
`⋯ → Opacity` slider (20–100%) per panel. Turn it down and the wallpaper shows through
that panel — **only the background fades**. Secondary text is interpolated the other
way (`--muted` moves toward `--fg` as opacity drops), so labels in dense panels like
GitHub and To-do stay readable instead of washing out. The setting is per-panel, so a quote card can float over the photo while a
dense board panel stays readable.

### Board — a panel that holds panels
The big middle card. It contains **cards**, each with an emoji icon, a name, a count
and its own links:

**Tabs are real sections** — each holds its own set of cards:

- **`+`** at the end of the tab strip adds a tab (and drops you straight into renaming it)
- **Double-click a tab** to rename it; **right-click a tab** for rename / add card / delete
- **+ Add card** adds a card to the *current* tab and opens its name for editing straight away (text pre-selected — just type)
- Drag bookmarks from the library **straight onto a specific card**; drag links
  between cards, and in or out of ordinary Bookmarks panels
- Click a card's emoji to change it, double-click its name to rename, `×` to delete
- Cards show **12 links** before **View all N →** (menu → *Links per card*: 6 / 12 / 25 / all)

### Headerless panels
`⋯ → Hide header` strips a panel's title bar so it reads as a plain surface — that's
how the quote panel gets the clean look in the reference design, and how you make a
panel that sits *behind* other panels as a background group.

A headerless panel still moves and configures: hover the top-right corner for the
**⠿ grip** — drag it to move, click it for the menu (`Show header` brings the bar back).

## Panels
- **✎ Edit** opens the dashboard menu
- Drag a panel by its **header**; resize from the **right edge, bottom edge, or bottom-right corner**
- Everything snaps to an 8px grid (configurable in Settings) and is saved instantly
- **Double-click the title** to rename; **⋯ or right-click the header** for the menu:
  list ⇄ icon-grid layout, color, sort A→Z, open all, duplicate, delete

## Adding bookmarks to a panel
Four ways:
1. **`+` in the panel header** — paste a URL, optional name, `Enter`. The form stays
   open so you can add several; `Done`/`Esc` closes it. A blank name falls back to a
   matching bookmark's title, else the hostname.
2. **`a`** opens that form on the last panel you clicked.
3. **Drag** a bookmark or a whole folder from the left **library** onto a panel.
4. **Drop a link** from any other tab/window onto a panel (or onto empty canvas to
   make a new panel around it).

An empty panel shows a dashed **click here to paste a URL** target.

## Moving things around
- Drag bookmarks or whole folders from the left **library** onto a panel
- Drag items **between** panels to move them, or within a panel to reorder
- Drag a link from any other tab/window and drop it on a panel — or on empty canvas to make a new panel
- Hover an item → **×** removes it

## GitHub panel
Open **⚙ Settings**, paste a classic PAT with the `repo` scope plus your username.
The panel then shows **Review requested / Assigned to me / Created by me**, each
toggleable from the panel menu, plus an optional custom query
(e.g. `org:syfe review:required`). Refreshes every 5 min, `⟳` for now, `r` refreshes all.

The token lives in `chrome.storage.local` and is only ever sent to `api.github.com`.
It is stripped from exported layouts.

## Command bar (Arc-style)
`⌘K` (or `/`, or click the pill) expands a search over: your dashboard panels →
all bookmarks → cached PRs → open-as-URL → Google fallthrough.
`↑`/`↓` to move, `Enter` to open, `Esc` to close.

## Other keys
`a` add link to the active panel · `n` new panel · `b` toggle library · `l` lock/unlock · `r` refresh GitHub · `Esc` close menus

## Wallpaper & greeting
> The reference layout — tall Tasks column, clock + weather across the top, board of
> cards below, headerless quote on the right — is what a **fresh install** seeds. On an
> existing dashboard, export your layout first if you want it, then Settings → Reset.

**⚙ Settings → Wallpaper.** Three ways to set one:

1. **Pick a built-in** — *Sunset Lake* ships with the extension (`img/sunset-lake.jpg`)
2. **Upload…** — choose any local image; it is downscaled to 2560px, re-encoded as
   JPEG and stored as a data URL, so it survives reloads and needs no server
3. **Paste an https URL**

A **dimming slider** (default 55%) keeps text readable over a photo — it previews live
as you drag. Pick **None** to go back to the theme's gradient wash.

Set your name in Settings too and the topbar greets you with the time of day.

## Themes
**⚙ Settings → Theme.** Six options, saved instantly:

| | |
|---|---|
| **Auto** | Mist on a light OS, Slate on a dark one |
| **Mist** | cool light grey-blue, indigo/cyan wash |
| **Paper** | warm light cream, amber wash |
| **Slate** | neutral dark, cool blue wash |
| **Midnight** | deep indigo, violet wash |
| **Espresso** | warm dark brown, amber wash |

Each theme is one block of CSS custom properties at the top of `css/newtab.css`
(`:root[data-theme="…"]`) — copy a block, change the values, add an entry to
`THEMES` in `js/store.js` and it shows up in the picker.

The background is a fixed three-blob radial gradient behind translucent,
backdrop-blurred panels; each panel's colour also tints its own header and
accent hairline.

## Settings
Theme, GitHub token/username, grid snap, **Export/Import layout** (JSON — move your
dashboard to another machine), **Reset** (rebuild panels from bookmark folders).

## Files
| file | role |
|---|---|
| `manifest.json` | MV3; `chrome_url_overrides.newtab` does the takeover |
| `js/store.js` | state model, persistence, first-run seeding |
| `js/panels.js` | panel render, move/resize, item drag & drop, context menu |
| `js/library.js` | bookmark sidebar + drag sources |
| `js/github.js` | GitHub search API + 4-min cache |
| `js/weather.js` | Open-Meteo geocoding + forecast, WMO code map, 15-min cache |
| `js/quotes.js` | the bundled quote list |
| `js/calendar.js` | iCal fetch, parser, recurrence expansion |
| `js/gcal.js` | Google Calendar API + OAuth via `chrome.identity` |
| `img/` | bundled wallpapers |
| `js/search.js` | command bar |
| `js/newtab.js` | bootstrap, topbar, settings, keyboard |

No analytics, no external scripts, no host permissions beyond `api.github.com`.
