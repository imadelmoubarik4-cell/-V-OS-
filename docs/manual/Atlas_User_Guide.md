---
title: User Guide
subtitle: Restaurant & Hospitality Operating System
tagline: Everything your team needs to run the venue.
version: Atlas User Guide · Version 0.8 · September 2026
release: Based on Atlas production release 0.8.0 (main ef7c907, 26 September 2026)
footer: Atlas User Guide · Version 0.8 · September 2026
doc-title: Atlas User Guide
cover: full
chapter-start: right
---

# How to use this guide {#how-to-use}

This guide is for everyone who works in Atlas: owners, managers, bartenders and anyone who reads along. It explains what each part of Atlas is for, who can use it, and how to do the everyday jobs step by step.

You don't need to read it front to back. Start with **Getting started** and **Home**, then go straight to the chapter for the job in front of you.

## How the guide is laid out {#guide-layout}

Every chapter follows the same pattern:

- **An opener** that says in a sentence or two what the page is for.
- **Who uses it**, shown as role badges: :role[admin] :role[manager] :role[bartender] :role[viewer].
- **Key screens**, with a screenshot and, where it helps, numbered markers explained underneath.
- **How-tos**: numbered steps that name the exact buttons you press.
- **Tips and important notes** that save time or prevent a mistake.

## Conventions {#guide-conventions}

- Buttons, tabs and labels appear exactly as they read on screen, like :ui[Start stock count] or :ui[Mark as ordered].
- Where to go is written as a path, like :path[Data > Par levels].
- Keyboard shortcuts look like :kbd[Ctrl K]. On a Mac, use :kbd[⌘K] instead.
- "Managers" means both **Administrators** and **Managers** unless a step says otherwise.
- Screenshots use a demonstration venue, the Harbour Room in Reykjavík, with invented staff, suppliers and figures. Your own Atlas shows your venue's data.

:::tip Your screen may look a little different
What you see depends on your role. If a button in this guide isn't on your screen, your role probably doesn't include it. Chapter 3 explains who can do what.
:::

:::important Atlas shows only what it can prove
Atlas never guesses. If stock hasn't been counted, it says **Not counted** instead of showing zero. If opening hours aren't saved, it says so instead of inventing them. When you see a gap, it's a prompt to add the missing record, not a fault.
:::

::toc{depth=1}

:::chapter{number=1 icon=layout-grid}
# Welcome to Atlas {#welcome}
Atlas is the operating system for your venue: stock, recipes, orders, shifts, checklists, team and knowledge in one place, with an assistant that answers from your own records.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## What Atlas is {#welcome-what}

Atlas brings the everyday running of a bar or restaurant into one shared place that works on a computer, a tablet and a phone. The same account signs in on every device, and everyone sees the same, up-to-date picture.

It covers the whole service day:

- **Before service**: what needs attention, the opening checklist, fridge temperatures, who is on tonight.
- **During service**: recipes at the bar, what can and can't be served, quick messages to the team.
- **After service**: the closing checklist, a handover note for the next shift, a stock count.
- **Behind the scenes**: purchase orders and deliveries, the rota, the team directory, procedures and training, reports.

## The problems it solves {#welcome-problems}

:::cards{cols=2}
### One version of the truth {icon=badge-check}
No more stock numbers in one spreadsheet, recipes in another and the rota in a group chat. Every page reads from the same records.

### Stock you can trust {icon=package}
Stock comes from counts a manager has verified, plus every delivery and waste record since. Atlas never pretends to know what it hasn't counted.

### Less chasing {icon=bell}
**Needs attention** on Home and the notifications bell gather what is out, overdue or waiting for you, each with a button that takes you straight there.

### Answers in plain language {icon=atlas-bot}
Ask Atlas AI "What's low before tonight?" and get an answer built from your own records, with the sources shown.

### A shared record of who did what {icon=history}
Checklist ticks, counts, orders and approvals are saved with the person's name and the time, on every device.

### The right tools for each role {icon=users}
Bartenders see what they need behind the bar. Costs, orders and settings stay with managers.
:::

## Our philosophy {#welcome-philosophy}

Atlas is built around a few simple principles. You'll see them on every page.

- **Records, not guesses.** Stock, costs and availability come from real records. Where a record is missing, Atlas says **Not counted**, **Not set** or **Unknown** rather than filling the gap.
- **People decide.** Atlas AI can prepare an order, a count or a message, but a person approves it with a tap. It never changes stock, orders or shifts on its own.
- **Everything is traceable.** Changes are kept with who made them and when. Most things are deactivated, archived or retired rather than deleted, so history stays intact.
- **Calm by default.** Home shows what needs you first and leaves the rest a scroll away.

## How the parts fit together {#welcome-ecosystem}

::diagram[Every part of Atlas reads from and adds to one shared picture of your venue: a verified count updates Inventory, which updates recipe availability, the suggested order, Home and Atlas AI.]{src="assets/diagrams/atlas-ecosystem.svg"}

A few examples of how the pieces connect:

- A **stock count** that a manager verifies becomes the stock shown in **Inventory**. That tells **Recipes** what can be served tonight and tells **Purchasing** what is below par.
- **Receiving a delivery** in Purchasing raises stock straight away and, by default, updates the item's cost.
- **Publishing the week** in Shifts shows the rota to the team and fills the **Tonight** list on Home.
- **Atlas AI** reads all of this, but only what your role is allowed to see.

:::coming-later Accounting
Accounting is being built and is not part of this release. There is no Accounting page in Atlas yet, and Atlas doesn't keep ledgers, invoices for payment or VAT figures. Until it arrives, Reports gives you purchasing spend from costed deliveries, stock value from verified counts and theoretical recipe margins, and you can download them as CSV for your accountant.
:::

:::chapter{number=2 icon=log-out}
# Getting started {#getting-started}
Sign in, find your way around, and learn the handful of controls that are the same on every page.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## Getting access {#access}

Everyone signs in with their own email address and password. There are two ways a manager can give you access.

**1. A setup link.** When a manager adds you in **Team** with a login, Atlas makes a one-time setup link. No email is sent: your manager shares the link with you privately.

1. Open the link your manager sent you. The page reads **Set up your Atlas login**.
2. Enter a **New password** of at least 10 characters, and type it again in **Confirm password**.
3. Press :ui[Create login]. Atlas confirms: "Your password is set. You can now sign in to Atlas with your email and password."

**2. An email invitation.** A manager can also use :ui[Invite by email] in Team. Atlas emails you a secure invitation, and you choose your password from it.

:::important Email invitations need one more step from a manager
An account created from an email invitation starts **without Atlas access**. After you have set your password, a manager opens your profile in **Team**, chooses your **Role**, switches **Atlas access** on and presses :ui[Save access]. Until then, signing in shows a message that the account isn't an active staff profile and asks you to have an administrator review access.
:::

:::figure{src="assets/screenshots/signin-invitation-setup.png" device=desktop width=55% caption="Set up your Atlas login: the page a new team member sees when they open their setup link or invitation."}
:::

A setup link works once. If it has expired or was already used, you'll see "This invitation has expired or was already used. Ask your manager for a new one." A manager can create a fresh one with :ui[New setup link] on your profile.

## Signing in {#sign-in}

:::figure{src="assets/screenshots/signin-desktop.png" device=desktop caption="The sign-in screen. Once Atlas knows your venue's name on this device, the line under Welcome back reads “Sign in to” your venue."}
:::

1. Open Atlas in your browser.
2. Enter your **Email** and **Password**. Press the eye button to show or hide what you typed.
3. Press :ui[Sign in].

If Atlas says "Email or password is incorrect.", check both and try again, or use :ui[Forgot your password?] to get a reset link by email. After a reset you are signed out on every device and sign in again with the new password.

::::figures
:::figure{src="assets/screenshots/signin-phone.png" device=phone caption="The same account signs in on a phone browser."}
:::
::::

**Who can sign in.** Only people with an active profile and one of the four roles can open Atlas. When a manager switches off someone's **Atlas access**, that person is signed out on their next action.

**Signing out** with :ui[Sign out] signs out *this device only*. Your other phones and computers stay signed in.

:::note Atlas needs a connection
Atlas doesn't work offline. If your connection drops you'll see "You're offline. Changes can't be saved until you reconnect." Nothing is queued in the background, so reconnect and then save again.
:::

## Your Atlas home screen at a glance {#home-at-a-glance}

This is what an administrator sees after signing in. The numbers are explained underneath.

:::figure{src="assets/screenshots/home-admin.png" device=desktop caption="Home on a computer, 20 minutes before opening: what needs attention first, then Today’s briefing and who is on tonight."}
- [13%, 27%] **The sidebar.** Every part of Atlas your role can open, grouped into Venue, People and Business. The line under the logo shows your venue's name and city.
- [38%, 3%] **Search or ask Atlas.** Find any item, recipe, person or action, or ask Atlas AI a question. Shortcut :kbd[Ctrl K] or :kbd[⌘K].
- [90%, 3%] **Quick actions (+).** Opens the list of things you can create or do from anywhere.
- [97.5%, 7.5%] **Notifications.** A red dot means something is unread.
- [44%, 14.5%] **Greeting and today's status.** Whether you are open, when you close or open, and how many people are on shift tonight.
- [83%, 13%] **Opening checklist.** Goes straight to today's checklist. After last orders it becomes **Closing checklist**.
- [32.5%, 26%] **Needs attention.** Up to five things to act on first, each with its own button. **View all** shows the rest.
- [32.5%, 71.3%] **Today's briefing.** A short summary of the day built only from your records.
- [71.5%, 69%] **Tonight.** Who is on shift today, with their times.
- [15.5%, 95.8%] **Your account.** Your name and role. Opens the account menu.
:::

Chapter 4 describes Home in detail.

## Finding your way around {#navigation}

### The sidebar {#sidebar}

The sidebar on the left holds every page your role can open, always in the same order:

| Group | Pages |
| --- | --- |
| (top) | Home, Atlas AI, Messages |
| Venue | Operations, Inventory, Recipes, Purchasing |
| People | Shifts, Team, Knowledge |
| Business | Reports, Marketing, Data |
| (bottom) | Settings, then your account button |

Pages your role can't use are simply left out. Bartenders and viewers, for example, don't see Purchasing, Reports, Marketing or Data.

**Atlas AI** is marked with its robot :icon[atlas-bot]. The robot always means Atlas AI; the Atlas logo at the top stands for Atlas itself.

A number next to **Messages** counts unread messages. A number next to **Data** counts catalogue changes waiting for a manager's approval.

:::figure{src="assets/screenshots/shell-sidebar.png" device=desktop width=28% caption="The sidebar groups the pages by what they are for. Badges show unread messages and changes waiting for approval."}
:::

**Screen sizes.** On a wide screen, the button at the top left collapses the sidebar to a narrow rail of icons (:ui[Collapse sidebar] / :ui[Expand sidebar]); Atlas remembers your choice on that device. Hover over a rail icon to see its name. On a tablet the rail is the default, and the full sidebar opens over the page with :ui[Open navigation].

### The top bar {#topbar}

The top bar is the same on every page: the sidebar button, the page title, the search field **Search or ask Atlas**, the :ui[+]{icon=plus} **Quick actions** button (computers and tablets only) and the :ui[Notifications]{icon=bell} bell.

### Search or ask Atlas {#search-palette}

One box finds anything in Atlas and passes questions to Atlas AI. Open it in any of these ways:

- click **Search or ask Atlas** in the top bar,
- press :kbd[Ctrl K] (:kbd[⌘K] on a Mac), or :kbd[/] when you aren't typing in a field,
- on a phone, tap the search icon in the top bar,
- press :ui[+] **Quick actions** to open it straight on the list of actions.

:::figure{src="assets/screenshots/shell-palette.png" device=desktop caption="Type a few letters and results appear by group. Here “campari” finds the item, the recipes that use it and matching actions."}
:::

**Before you type**, Atlas shows **Suggested** actions for the page you're on (where there are none, the records you opened **Recent**ly), then the other actions your role can use.

**As you type**, results appear in groups: **Items**, **Recipes**, **Suppliers** (managers), **People**, **Articles**, then **Actions** and **Go to**. Items show their stock at a glance, for example "3 bottles · below par", or "Not counted — no verified stock". When your search names an item, actions such as **Count** that item appear too.

**To ask a question**, type it and choose **Ask Atlas "…"**, or press :kbd[Ctrl ↵] (:kbd[⌘ ↵] on a Mac). Atlas AI opens a new conversation with your question already sent.

Use the arrow keys to move, :kbd[↵] to open and :kbd[Esc] to close. The list of **Recent** records belongs to you and is cleared when you sign out.

:::tip Go straight to a sub-page
**Go to** results include sub-pages, such as "Inventory › Stock count", "Shifts › Time off" or "Data › Par levels". Type part of the name and press Enter.
:::

### Notifications {#shell-notifications}

The bell collects what needs you and what has changed:

- every **Needs attention** row from Home that your role can see,
- one entry for each Messages conversation with unread messages, for example "Sara Jónsdóttir in General" or "3 new messages in Operations", with an :ui[Open] button,
- updates that other parts of Atlas send.

Use **All** or **Needs action** at the top to filter. The **…** menu has :ui[Mark all as read] and :ui[Notification settings]. When there is nothing new you'll see "You're up to date".

:::figure{src="assets/screenshots/shell-notifications.png" device=desktop caption="The notifications panel. Each entry has a button that goes straight to the right page and marks it as read."}
:::

:::note Read status is kept per device
Marking a notification as read on your phone doesn't mark it as read on your laptop. Each device keeps its own list.
:::

Alerts on the device itself (push notifications) are a separate, per-device choice under :path[Settings > Notifications]. That page shows whether alerts can reach your device yet. On iPhone and iPad, Atlas must first be added to the Home Screen.

### Your account menu {#account-menu}

Click your name at the foot of the sidebar (on a phone: the account row at the top of **More**). The menu shows your photo or initials, your name and your role, and these options:

- **Your profile**: opens your own profile in Team.
- **Preferences**: your start page and reduced motion.
- **Notification settings**: alerts on this device.
- **Keyboard shortcuts** (computers only): the full list of shortcuts.
- **Sign out**: signs out this device only.

:::figure{src="assets/screenshots/shell-account-menu.png" device=desktop width=50% caption="The account menu, opened from your name in the sidebar."}
:::

Atlas shows your profile name everywhere. If no name has been set yet, you appear as "Team member". Your email address is never shown as your name.

:::quick-ref Keyboard shortcuts
| To do this | Press |
| --- | --- |
| Search or ask Atlas | :kbd[Ctrl K] / :kbd[⌘K] |
| Search (when you aren't typing) | :kbd[/] |
| Move in lists and menus | :kbd[↑] :kbd[↓] |
| Open the selected result | :kbd[↵] |
| Ask Atlas with what you typed | :kbd[Ctrl ↵] / :kbd[⌘ ↵] |
| Close a panel or dialog | :kbd[Esc] |
:::

## Atlas on a phone {#phone}

On a phone, a tab bar at the bottom replaces the sidebar. It is the same for every role:

- **Home**
- **Inventory**
- **Atlas**: the robot button in the middle opens Atlas AI
- **Recipes**
- **More**: everything else, with a badge for unread messages

**More** opens a sheet with your account row at the top, then every other page your role can open, then **Settings** (managers) or **Preferences** (bartenders and viewers), and **Sign out**.

::::figures
:::figure{src="assets/screenshots/phone-more-admin.png" device=phone caption="An administrator’s More sheet lists every other page."}
:::
:::figure{src="assets/screenshots/phone-more-bartender.png" device=phone caption="A bartender’s More sheet lists only the pages a bartender can use."}
:::
::::

A few phone differences worth knowing:

- The top bar shows the page title, a back arrow where there is one, the search icon and the bell. **Quick actions (+)** is only on larger screens.
- The tab bar hides while you are in an Atlas AI conversation, counting stock or working in a full-screen sheet, so you have the whole screen.
- Notifications open full screen. Press back to close them.

:::chapter{number=3 icon=shield-check}
# Roles & permissions {#roles}
Every person in Atlas has one of four roles. The role decides which pages they see and what they can change.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## The four roles {#roles-four}

:::cards{cols=2}
### Administrator {icon=shield-check}
Usually the owner. Everything a manager can do, plus the protected settings: role permissions in **Team access**, **Security** and **System health**. Only an administrator can make someone else an administrator.

### Manager {icon=user-cog}
Runs the venue day to day: verifies stock counts, orders and receives deliveries, plans and publishes shifts, manages recipes, the team and knowledge, and sees costs and reports.

### Bartender {icon=martini}
Works the bar: counts stock, ticks checklists, logs temperatures, reads recipes, messages the team, sees and confirms their own shifts, and asks Atlas AI.

### Viewer {icon=eye}
Read-only access to the everyday pages, for example for a trainee or an accountant. Can read messages and ask Atlas questions, but can't count, tick or post.
:::

There is also **Schedule only**. This isn't a role but a person on the shift roster *without* an Atlas login. They can be put on the rota, but they can't sign in or confirm shifts.

## Who can do what {#roles-matrix}

:::role-matrix What each role can do in each part of Atlas
| Area | admin | manager | bartender | viewer |
| --- | --- | --- | --- | --- |
| Home | Full | Full | Limited: no Purchasing tile; shows "My next shift" | Limited: greeting and Needs attention only |
| Atlas AI conversations | Full: approves every kind of proposal | Full | Limited: can approve counts, messages and catalogue suggestions; other proposals wait for a manager | Limited: questions and answers only |
| Atlas AI › Decisions | Full | Full | No | No |
| Messages | Full: posts Announcements, removes any message with a reason | Full | Limited: posts everywhere except Announcements | View: reads, pins, marks read |
| Operations | Full: incl. skip, target ranges and schedule | Full | Limited: tick, notes, complete, log temperatures | View |
| Inventory items | Full: add, edit, deactivate, waste, costs, suppliers | Full | Limited: count, identify, suggest a product or barcode; no costs or suppliers | View: can identify items |
| Inventory › Movements and Waste | Full | Full | No | No |
| Stock count | Full: start, count, submit, verify, send back, cancel | Full | Limited: start, count, submit, cancel own count | View: sees the Counts list; can't count |
| Recipes | Full: create, edit, archive, delete, costs, public menu | Full | View: specs and availability, no costs | View: same as bartender |
| Purchasing | Full | Full (some orders may need a different approver) | No | No |
| Shifts | Full: plan, publish, time off, confirmations | Full | Limited: own and team schedule, confirm, availability, time off | Limited: Schedule tab only |
| Team | Full, including the Administrator role | Full, except the Administrator role | Own: own profile, photo and emergency contacts; sees the directory | Own: same as bartender |
| Knowledge | Full: write, publish, retire | Full | Limited: read, required reading, training | Limited: same as bartender |
| Reports | Full (read and export) | Full | No | No |
| Marketing | Full | Full | No | No |
| Data | Full | Full | No | No |
| Settings | Full: every section | Limited: no Team access, Security or System health | Limited: Preferences and Notifications | Limited: Preferences and Notifications |
| Search, notifications, account menu | Yes | Yes | Yes | Yes |
:::

::::figures
:::figure{src="assets/screenshots/role-bartender-inventory.png" device=desktop caption="Inventory for a bartender: quantities, par and status, with Start stock count, but no supplier or cost columns."}
:::
:::figure{src="assets/screenshots/role-viewer-inventory.png" device=desktop caption="Inventory for a viewer: the same list to read, without Start stock count or Add item."}
:::
::::

## Good to know about roles {#roles-notes}

- **Roles are set on the person's profile.** A manager opens :path[Team > (person) > Access], chooses the **Role** and presses :ui[Save access]. Chapter 13 has the steps.
- **Managers can't create or change administrators.** Only an administrator can give or remove the Administrator role.
- **Nobody can change their own role** or switch off their own access. Ask another manager or an administrator.
- **At least one active manager or administrator must remain.** Atlas refuses a change that would leave the venue without one.
- **New people start small.** Someone added with a login in Team starts as a Bartender (Staff login) or a Viewer (Read-only login). To make someone a manager, add them first, then change their role.
- **Some approvals depend on your venue's rules.** An order may need approval before it is marked as ordered, and the rules can require an administrator, or a different manager from the one who submitted it.
- **Atlas AI follows your role.** It only reads what your role may see, and its proposals follow the same rules as the buttons in Atlas.
- **Links respect roles too.** If you open a link to a page that isn't for your role, Atlas explains that it's for managers and takes you to Home. Nothing is changed.

:::admin-only
Administrators also control what each role may do in :path[Settings > Team access]. A person's role and access are still changed on their profile in Team.
:::

:::chapter{number=4 icon=house}
# Home {#home}
In ten seconds: is today under control, and what needs me?
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

Home is the first page after you sign in, unless you've chosen another start page in **Preferences**. It reads your opening hours, shifts, checklists, stock counts, recipes and orders, and puts what matters most at the top.

:::figure{src="assets/screenshots/home-admin.png" device=desktop caption="Home for an administrator: the day’s status, Needs attention, Today’s briefing and Tonight."}
:::

## The top of the page {#home-head}

- **Date and greeting**, for example "Good afternoon, Katrín".
- **Today's status** from your saved opening hours: "Opens at 17:00 · opening checks in progress", "Open · closes at 01:00 (in 2 h 20 min)" or "Closed today · opens …". Next to it: how many people are on shift tonight.
- The :ui[Opening checklist]{icon=clipboard-check} button, which becomes :ui[Closing checklist] after last orders. It is shown to everyone who can tick checklists.

If opening hours aren't saved, Home says "Opening hours aren't set". Managers get a **Set hours** link. Everyone else sees "A manager can add them in Settings."

:::note What "today" means
Atlas follows your venue's opening hours. If you close after midnight, the early hours still belong to the previous business day, so the Friday closing checklist is still Friday's at 01:30.
:::

## Needs attention {#home-needs-attention}

A short list of what to deal with first, with a count next to the heading. Up to five rows are shown; **View all** opens the notifications panel filtered to **Needs action**.

Each row says what's wrong and offers one button. Typical rows:

| Row | Button |
| --- | --- |
| Stock isn't counted yet | :ui[Start stock count] |
| (Item): out of stock, with the recipes affected and whether it is already on an order | :ui[Add to order] (managers) or :ui[View item] |
| (Item) is below par / 6 items are below par | :ui[View items] |
| (Count) paused · 3 of 12 | :ui[Continue] |
| (Count) is waiting for verification (managers) | :ui[Review] |
| Opening checklist is 4 of 9 done | :ui[Open checklist] |
| 2 temperatures not logged today | :ui[Log reading] |
| (Recipe) can't be served | :ui[Open recipe] |
| Order from (supplier) needs approval (managers) | :ui[Review] |
| Delivery from (supplier) is due today / is overdue (managers) | :ui[Receive] |
| (Proposal) is waiting for your approval (approvers) | :ui[Review] |
| 3 catalogue changes are waiting for your approval (managers) | :ui[Review] |

When everything is handled you'll see "Nothing needs you right now", with the time Atlas last checked.

## Today's briefing {#home-briefing}

The Atlas AI robot :icon[atlas-bot] heads the briefing. It is a plain-language summary of the day in one or two sentences, for example: "You open at 17:00. 4 people are on tonight: Sara, Katrín, Gunnar and Elín. The opening checklist is 4 of 9 done."

The briefing is built only from your records. The line underneath says where it came from ("From opening hours, shifts, checklists, stock counts, recipes and orders"). If something is missing, the briefing says so, for example "Stock hasn't been counted yet, so Atlas can't tell what's low."

Press :ui[Ask a follow-up] to continue in Atlas AI with the briefing as context. The purchasing sentence, "N items are ready to order from …", appears for managers only.

## At a glance {#home-glance}

Lower down, tiles give quick numbers with a link to the full page:

- **Stock**: how many items are below par, how many are out or not counted, and when the last count was. Link: **View inventory**.
- **Recipes**: how many can't be served, or "All N recipes can be served". Link: **View recipes**.
- **Purchasing** (managers): how many items to order and from which suppliers. Link: **View orders**.
- **My next shift** (bartenders): your next shift's day, time and role. Link: **View shifts**.

:::figure{src="assets/screenshots/home-timeline-glance.png" device=desktop caption="Further down Home: the At a glance tiles and the Opening and closing timeline from your saved hours."}
:::

## Tonight and the day's timeline {#home-tonight}

- **Tonight** lists everyone on the published schedule for today, with their role, any note and their times. You are marked **You**. The **Shifts** link opens the rota. If the week isn't published yet, managers see "This week isn't published yet."
- **Opening and closing** is a timeline of the day from your saved hours, with checklist progress, for example "Opening checklist 3 of 8 done" or "Opening checklist done · Sara".

## What each role sees {#home-roles}

- **Administrators and managers** see everything described above, including the Purchasing tile and the purchasing sentence in the briefing.
- **Bartenders** see the same page without purchasing, and with a **My next shift** tile.
- **Viewers** see the greeting, today's status and **Needs attention** only.

:::figure{src="assets/screenshots/role-viewer-home.png" device=desktop caption="Home for a viewer: today’s status and Needs attention only. Buttons open records to read, such as View log instead of Log reading."}
:::

::::figures
:::figure{src="assets/screenshots/home-admin-phone.png" device=phone caption="Home on a manager’s phone keeps the same order."}
:::
:::figure{src="assets/screenshots/home-bartender-phone.png" device=phone caption="A bartender’s Home: tonight’s tasks, without costs or purchasing."}
:::
::::

:::note Not on Home yet
Reservations, events and sales aren't shown on Home, because no booking or till system is connected to Atlas.
:::

## Quick actions {#home-quick-actions}

On a computer or tablet, the :ui[+] **Quick actions** button in the top bar opens a list of everything you can start from anywhere, grouped as **Stock**, **Purchasing**, **Service**, **People**, **Business** and **More actions**. What's listed depends on your role: for example :ui[Log temperature], :ui[Write handover], :ui[Request time off], :ui[New order] or :ui[Add team member]. Type to narrow the list.

:ui[Reload data] is always there and refreshes what Atlas has loaded.

## Recommended morning routine {#home-routine .quick}

:::workflow{layout=vertical} A calm start to the day
1. Open Home — Read the status line: are you on time for opening, and who is on tonight?
2. Clear Needs attention — Work top to bottom. Each row's button takes you to the right place.
3. Read Today's briefing — Press Ask a follow-up if you want detail, for example what to order.
4. Run the opening checklist — Press Opening checklist and tick items as they're done. Your name and the time are saved.
5. Log fridge temperatures — Use Log reading for any point not logged today.
6. Check Messages — Read the Shift handover from last night and any Announcements.
7. Managers: check stock and orders — Receive deliveries that are due and review any orders or counts waiting for you.
:::

:::tip Make Home your own
If you mostly start somewhere else, for example Recipes behind the bar, change your **Start page** in :path[Preferences].
:::

:::chapter{number=5 art="assets/brand/atlas-bot.png" art-crop=left icon=atlas-bot}
# Atlas AI {#atlas-ai}
Ask a question in plain language, by typing, talking or showing a photo. Atlas answers from your venue's own records, and prepares changes for a person to approve.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## Meet the Atlas AI robot {#ai-robot}

The robot on this chapter's opening page is the face of Atlas AI. The Atlas logo stands for the whole product; the robot always means "this is Atlas AI". You'll find it:

- on **Atlas AI** in the sidebar and on **Atlas** in the middle of the phone tab bar,
- next to **Atlas** on every answer,
- on :ui[Ask Atlas]{icon=atlas-bot} and :ui[Ask Atlas about this]{icon=atlas-bot}, in **Search or ask Atlas**, and at the top of Home's **Today's briefing**.

When you start a new conversation, a larger robot stands above the greeting. It waves hello once, looks toward your pointer on a computer, and reacts when you tap or click it. The small robot next to **Atlas** moves gently while an answer is being written. During live voice, a robot next to the status follows the call: listening, thinking or speaking.

The robot is only decoration; you never need it to use Atlas AI. If your device can't show the moving robot, for example on an older phone or computer, or when your phone is set to save data, you see a still picture of it instead. With **Reduce motion** switched on, in Atlas or on your device, the robot holds still.

## What Atlas AI can help with {#ai-help}

:::cards{cols=3}
### Stock {icon=package}
What's low, what's out, when an item was last counted, what a barcode or photo is likely to be.

### Recipes {icon=martini}
What can and can't be made tonight and why. Managers also get cost per serve and margins.

### Ordering {icon=truck}
For managers: what to order and from whom, order status, cost changes, and whether a delivery matches the order.

### Shifts and team {icon=calendar-days}
Who is working today or tomorrow, and team profiles.

### Operations {icon=clipboard-check}
Checklist progress, open alerts and today's briefing.

### Knowledge {icon=book-open}
Your venue's procedures and policies, found and summarised.
:::

Atlas AI can also **prepare** things for you: a stock count, a draft purchase order, a shift draft, a team message or a Knowledge draft. It shows these as cards that a person approves with a tap (see *Atlas prepares, people approve* below).

:::important Atlas only knows what your role can see
Atlas AI reads the same records you can open, with the same limits. A bartender asking about costs gets an answer without costs, just like the Inventory page.
:::

## Ask Atlas {#ai-ask}

There are several ways in:

- **Atlas AI** in the sidebar, or **Atlas** in the middle of the phone tab bar.
- Type a question in **Search or ask Atlas** and choose **Ask Atlas "…"**, or press :kbd[Ctrl ↵].
- :ui[Ask a follow-up] on Home's briefing.
- :ui[Ask Atlas]{icon=atlas-bot} or :ui[Ask Atlas about this]{icon=atlas-bot} on an item, a recipe, a Knowledge article, a report or a scan result. The conversation starts with that record attached as context. The context chip above the box shows it; remove the chip if you want a general question.

:::figure{src="assets/screenshots/ai-empty.png" device=desktop caption="A new conversation. Suggestions fit your role; earlier conversations stay in the list on the left."}
:::

To ask:

1. Press :ui[New conversation].
2. Type in the box **Ask Atlas about stock, recipes, shifts…**, or tap one of the suggestions.
3. Press Send.

While Atlas works you'll see what it is doing, for example "Checking stock…". When it's finished, the steps fold into a short line such as "Checked stock". Press :ui[Stop generating] to stop; a stopped answer is marked "Stopped. This answer is incomplete."

:::prompts Suggestions you'll see in Atlas
- What's low before tonight? — Offered to everyone.
- Who's on tomorrow? — Offered to everyone.
- Which recipes can't we make tonight? — Offered to bartenders and viewers.
- Does this delivery match our order? — Offered to managers; opens the camera or photo picker.
- Count the back bar by voice — Offered to administrators, managers and bartenders; starts live voice.
- What's on today's checklist? — Offered to viewers.
:::

## Reading an answer {#ai-answer}

:::figure{src="assets/screenshots/ai-conversation.png" device=desktop caption="A conversation: the question, Atlas’s answer with its sources, links to the records it used, and a draft order waiting for approval."}
- [33.5%, 14.9%] **Conversations and Decisions.** Your conversations; managers can also switch to Decisions.
- [64.5%, 39.5%] **Linked records.** Tap one to open the item, recipe or supplier in Atlas.
- [55%, 45.2%] **How Atlas knows.** Every source behind the answer, and how sure Atlas is of each one.
- [62%, 70%] **A proposal card.** Something Atlas has prepared. Nothing happens until a person approves it.
- [47%, 88.5%] **Attach.** Add a photo or a file.
- [83.5%, 88.5%] **Voice.** Record a voice note, or start a live voice conversation.
- [48%, 93.3%] **The promise.** Atlas prepares changes for you to approve. It never changes stock, orders or shifts on its own.
:::

Every answer can show:

- **The answer text**, in plain language.
- **How Atlas knows**: the sources, each labelled by how sure it is.
  - **Verified**: from a verified record, such as a manager-verified count.
  - **Calculated**: worked out from verified records, such as serves per bottle.
  - **Estimate**: a best guess, clearly marked.
  - **Interpretation**: Atlas's reading of something, such as a photo.
  - **Missing**: information Atlas doesn't have. It says so instead of filling the gap.
- **Record links** to open the item, recipe, order, count, shift or article in Atlas.
- :ui[Copy answer], to paste it elsewhere.

If something goes wrong you'll see "Atlas couldn't finish this answer." with "Nothing was changed." and a way to try again.

## Conversations {#ai-conversations}

Your conversations are listed on the left (on a phone, tap **Conversations** at the top). They are grouped as **Pinned**, **Today**, **Previous 7 days** and **Earlier**. Use **Search conversations** to find an old one. A conversation with a proposal waiting shows "Waiting for approval".

Conversations are personal: other people can't read yours.

From the **…** **Conversation options** menu you can:

- :ui[Rename] (or click the title),
- :ui[Pin] / :ui[Unpin] to keep it at the top,
- :ui[Copy link],
- :ui[Archive] (with :ui[Undo]),
- :ui[Delete]. This removes its messages, photos and files. Orders, counts or messages that Atlas already created stay as they are.

## Photos and files {#ai-attachments}

Show Atlas a delivery note, a shelf or an invoice and ask about it.

1. Press :ui[+]{icon=plus} next to the box.
2. Choose :ui[Take photo] (phones), :ui[Choose from library] / :ui[Choose photo], or :ui[Attach file].
3. Pick a suggestion such as "Does this match our order?", "Count these bottles" or "What is this?", or type your own question.
4. Press Send.

:::figure{src="assets/screenshots/ai-attachment.png" device=desktop caption="A delivery-note photo attached, with suggested questions that fit a photo."}
:::

Atlas can read **photos, PDFs, text and CSV files**. Up to 4 files go with one message. Each file can be up to 25 MB, and photos and PDFs in one message up to 20 MB together.

:::important How Atlas treats photos
Atlas names a product from a photo only when it's sure, for example from an exact barcode match. A count from a photo is always an **estimate**, never a verified count. Photos and files need Atlas AI to be switched on.
:::

## Voice {#ai-voice}

There are two ways to talk to Atlas. Both appear in the box when your browser supports them.

### Voice notes {#ai-voice-notes}

For a quick question when your hands are busy:

1. Press :ui[Record a voice note]{icon=mic} and speak.
2. Stop the recording. Atlas shows "Transcribing…", then puts the text in the box: "Transcript ready. Check it, then send."
3. Correct anything that was misheard, then press Send.

Your message shows as "Voice note" with its length.

:::figure{src="assets/screenshots/ai-voice-note.png" device=desktop caption="Recording a voice note. The words appear in the box for you to check before sending."}
:::

### Live voice {#ai-live-voice}

For a spoken, back-and-forth conversation, for example while you count:

1. Press :ui[Talk to Atlas].
2. The first time, Atlas explains how it works: "Atlas listens only while this panel is open. Anything Atlas prepares appears as a card for you to approve with a tap." Press :ui[Start talking] and allow the microphone.
3. Talk normally. The panel shows **Listening**, **Thinking** or **Speaking**.
4. Use :ui[Mute] / :ui[Unmute], and :ui[Show transcript] to read along. End the session when you're done.

::::figures
:::figure{src="assets/screenshots/ai-live-voice-intro.png" device=desktop caption="Before live voice starts, Atlas explains that it listens only while the panel is open."}
:::
:::figure{src="assets/screenshots/ai-live-voice.png" device=desktop caption="A live voice session, with the transcript on screen."}
:::
::::

A live session runs on one device at a time. If it's still open on another device or tab, press :ui[Continue here] to move it. If the connection drops, use :ui[Reconnect] or :ui[Try again]; your conversation is saved.

During a stock count, **Count by voice** in the count's **…** menu opens Atlas AI with the count as context (where live voice is supported).

:::important Speaking never approves anything
Saying "yes, do it" doesn't approve a proposal. Approvals are always a tap on the card.
:::

## Atlas prepares, people approve {#ai-approvals}

When you ask Atlas to *do* something, for example "Order more Campari", it doesn't do it. It prepares a **proposal card** that shows exactly what would happen:

- the title and a short summary,
- the lines, with quantities, units and prices, and an **Estimated total** where it applies,
- any warnings or differences,
- **Will change** and **Will not change**,
- when it expires: "Expires today at 18:00" or "Expires tomorrow at …".

:::figure{src="assets/screenshots/ai-approval-card.png" device=desktop caption="A proposal card for a draft order. It spells out what will and won’t change, and waits for a tap."}
:::

On the card you can:

- press the main button (for example :ui[Create order]) to approve it,
- press :ui[Edit] to tell Atlas what to change ("Tell Atlas what to change"),
- press :ui[Dismiss] to drop it.

When it's done, the card shows a summary and a link such as :ui[View order] or :ui[View count].

| Atlas can prepare | Button | Who can approve |
| --- | --- | --- |
| A new purchase order (created as a Draft) | :ui[Create order] | Administrators, managers |
| Changes to a draft order | :ui[Update draft order] | Administrators, managers |
| Receiving a delivery (stock goes up) | :ui[Receive delivery] | Administrators, managers |
| A stock count, saved for review | :ui[Save count for review] | Administrators, managers, bartenders |
| A shift draft (not published) | :ui[Save as draft] | Administrators, managers |
| A team message | :ui[Send message] | Administrators, managers, bartenders (Announcements: managers) |
| A Knowledge draft (private) | :ui[Save as draft] | Administrators, managers |
| A new item name, a new item or a wrong-match report | :ui[Approve] | Administrators, managers, bartenders. This sends a request to a manager; nothing changes until a manager approves it in Data. |
| A settings or par-level suggestion | :ui[Open Settings] / :ui[Open par levels] | Administrators, managers. A link only: you make the change yourself. |

If your role can't approve a card, its button is disabled with "Only a manager can approve this.", and the card waits for a manager ("Waiting for a manager"). Managers also see it on Home as "… is waiting for your approval".

:::important Cards expire
A proposal expires 24 hours after Atlas prepares it. An expired card collapses to "Expired", and you can ask Atlas to prepare it again if it's still needed. If something changed in the meantime, for example the stock or the order, Atlas refuses the approval ("Something changed since Atlas prepared this. Nothing was changed.") so nothing is done on out-of-date information.
:::

::::do-dont
:::do
- Read **Will change** and **Will not change** before you tap.
- Use :ui[Edit] to adjust quantities in words: "Change the Campari to 4 bottles."
:::

:::dont
- Don't expect a spoken or typed "yes" to count as approval.
- Don't approve a stock count proposal expecting stock to change. It still has to be submitted and verified.
:::
::::

## Decisions {#ai-decisions}

::roles{roles="admin manager"}

**Decisions** is the record of what Atlas suggested, what was decided, by whom, and what happened next. Open it with **Decisions** at the top of the conversation list.

:::figure{src="assets/screenshots/ai-decisions.png" device=desktop caption="Decisions: open recommendations and past decisions, with who decided and the outcome."}
:::

- Filter by status (**Proposed**, **Approved**, **Dismissed**, **Expired**, **Done**), area (Stock, Purchasing, Shifts, Recipes) and period.
- The **Source** column shows whether a recommendation came from **Atlas AI** or from a fixed **Rule**.
- Open a row to see **What was recommended**, the **Evidence**, the **Decision** and the **Outcome**, with a link to **Open the conversation**.
- Use **Record a decision** (Approve, Dismiss or Decide later) and **Record what happened** to keep the record complete.

Recommendations are refreshed when a manager opens Home. Managers can also link a recommendation into a message in Messages.

## When Atlas AI is off {#ai-off}

Atlas AI is switched on by an administrator in :path[Settings > Atlas AI]. Until then, the page shows "Atlas AI isn't switched on yet".

Search still works, and Atlas still gives **quick answers** to common questions from your records, labelled "Quick answer". For example "What is low in stock?", "What needs ordering?", "Can we make a Margarita?" or "Who works tomorrow?". Photos and files need Atlas AI to be on.

## Daily limits {#ai-limits}

To keep things fair and fast, each person has a daily allowance. Your venue can change these in :path[Settings > Atlas AI]. The usual amounts are:

- about **200 questions** a day,
- **20 live voice sessions** and **60 minutes** of live voice a day,
- **100 files** a day.

If you reach a limit, Atlas tells you in plain words, for example "You've used today's live voice sessions. Voice notes and text still work." Limits reset within 24 hours. If you ask a lot in a short time, Atlas may ask you to wait a minute.

Photos and files are kept for 30 days by default. Voice recordings are deleted once they have been written down, unless your venue chooses otherwise.

## What Atlas AI will never do {#ai-never}

- Make a change without a person tapping approve.
- Invent stock, costs, sales, item names or barcodes. Missing information is shown as **Missing**.
- Send anything to a supplier or post to social media.
- Change settings, par levels, roles or recipes directly. It can only suggest and link.
- Show you anything your role isn't allowed to see.

:::chapter{number=6 icon=messages-square}
# Messages {#messages}
The team's shared channels for everyday updates, shift handovers and official announcements, with names, photos and read receipts.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## Channels {#messages-channels}

Messages has five channels, shared by the whole active team:

| Channel | What it's for |
| --- | --- |
| **General** | Everyday team communication and shared updates. |
| **Operations** | Cleaning, inventory, maintenance and service operations. |
| **Shift handover** | What the next shift needs to know before taking over. |
| **Announcements** | Official management notices for the whole active team. Only managers post here. |
| **Marketing** | Content ideas, campaigns, events and social-media coordination. |

The list on the left shows each channel with the last message ("Sara: …"), the time and a blue badge for unread messages. Use **Search conversations** to find a channel. Pin the ones you use most with the pin button at the top of the thread; they move to **Pinned** (just for you).

:::figure{src="assets/screenshots/messages-channel.png" device=desktop caption="The General channel: channels with unread counts on the left, each message with its sender’s name and photo, and a line where new messages start."}
:::

::::figures
:::figure{src="assets/screenshots/messages-list-phone.png" device=phone caption="On a phone, Messages opens on the channel list."}
:::
:::figure{src="assets/screenshots/messages-thread-phone.png" device=phone caption="A thread on a phone: your messages on the right, everyone else’s on the left."}
:::
::::

## Names and photos {#messages-identity}

Every message shows who sent it: their photo (or initials), their name and their role, for example "Manager". The name is the one set on the person's profile in Team (**Name shown in Atlas**), so if someone changes their preferred name, their messages show the new name. Someone who has left is marked "· no longer active". An email address is never shown as a name.

Messages that Atlas posts, such as a newly published required reading, come from **Atlas**.

## Sending a message {#messages-send}

1. Open a channel.
2. Type in the box **Message (channel)**.
3. Press Send, or Enter on a keyboard (Shift + Enter for a new line).

Your message appears straight away. Everyone in the channel can see it. If it doesn't go through, it is marked **Not sent** with :ui[Retry].

:::note Posting depends on your role
Administrators, managers and bartenders can post in every channel except **Announcements**, which is for managers. Viewers can read everything but not post: their box reads "You can read messages. Ask a manager if you need to post."
:::

### Link a record {#messages-link}

Point the team to something in Atlas instead of describing it:

1. Press the paperclip, :ui[Link a record]{icon=paperclip}.
2. Choose **Item**, **Checklist** or **Shift**. Managers can also link a **Recommendation** from Atlas AI Decisions.
3. Search, choose the record and press :ui[Attach].
4. Send your message. The record appears as a chip anyone can tap to open.

:::figure{src="assets/screenshots/messages-read-receipts.png" device=desktop width=70% caption="A message with a linked inventory item. “Read by” counts how many people have seen it."}
:::

Messages carry text and linked Atlas records. Photos and files can't be attached to a message in this release.

### Handover notes {#messages-handover}

At the end of a shift, write a structured note for the next team:

1. Open **Shift handover** and press :ui[Write handover]. (It's also in Shifts, and in Quick actions.)
2. Fill in **What happened**, and if needed **Stock issues** and **For the next shift**. At least one section is required.
3. Press :ui[Post handover].

:::figure{src="assets/screenshots/messages-handover.png" device=desktop caption="Write handover posts a short, structured note in Shift handover for the next team."}
:::

### Announcements {#messages-announcements}

Use **Announcements** for official notices everyone should see. Only managers can post; bartenders see "Only managers can post in Announcements. You can read everything here."

:::figure{src="assets/screenshots/messages-announcements.png" device=desktop caption="Announcements: official notices from managers, and notices from Atlas such as newly published required reading."}
:::

## Unread messages and read receipts {#messages-unread}

- **Unread counts** show on **Messages** in the sidebar, on the phone's **More** tab and next to each channel.
- Inside a channel, a **New** line marks where unread messages start, and a button jumps to "N new messages".
- Opening a channel marks it as read.
- **Read receipts** appear on your own messages only: **Sent** until someone reads it, then **Read by N**. Hover to see the names.
- The **notifications bell** (and Home's feed) gets one entry per channel with unread messages, for example "Gunnar Karlsson in Shift handover" or "3 new messages in General". It shows the sender's current name.

:::note Phone alerts for messages
Device alerts for new messages are switched on per device in :path[Settings > Notifications]. That page tells you whether alerts can reach your device yet. Until they do, the bell and the unread badges are how you'll know.
:::

## Editing and removing messages {#messages-edit}

- You can **edit** or **delete** your own message within **15 minutes** of sending it. Use :ui[Edit] or :ui[Delete] on the message (on a phone, through **Message options**).
- A deleted message is replaced by "Message deleted" for everyone. A record is kept in the history.
- **Managers can remove any message at any time**, and must give a **Reason**, which is kept in the history.

:::tip Keep it steady
If you send many messages very quickly, Atlas asks you to wait a moment. The limit is 20 messages a minute per person.
:::

:::chapter{number=7 icon=clipboard-check}
# Operations {#operations}
Today's shared opening and closing checklists, routines and the fridge and freezer temperature log, each tick saved with who did it and when.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## The Today tab {#operations-today}

**Operations** opens on **Today**: the business date and how many checklists are done, then one row for each checklist or routine that's due today.

:::figure{src="assets/screenshots/operations-today.png" device=desktop caption="Today’s checklists and routines, each with its status and progress."}
:::

- **Opening checklist** and **Closing checklist** show when they're due ("after last orders at …"), progress, or "completed … by (name)".
- Other routines show "Due … · N of M done".
- **Temperature log** shows how many points are logged today and any readings out of range.
- Status pills: **Not started**, **In progress**, **Done**, **Skipped**, **Overdue**.

Press :ui[Open], :ui[Continue] or :ui[View] on a row.

Checklists are shared: "Shared with the team. Every tick records who and when." Nothing is kept on one device.

## Working through a checklist {#operations-checklist}

::roles{roles="admin manager bartender"}

1. Open **Operations** (or press :ui[Opening checklist] on Home) and press :ui[Open] on the checklist.
2. Tap each item as you do it. It is saved straight away, with your name and the time.
3. To add detail, press :ui[Add note]. Notes are "Visible to the team with your name." Leave a note empty to remove it.
4. When you're finished, press :ui[Complete checklist]. Add an optional note, then confirm.

If some items aren't ticked, Atlas asks "N items aren't ticked. Complete anyway?". The unticked items stay visible in the history as not done.

:::figure{src="assets/screenshots/operations-tick-item.png" device=desktop caption="The opening checklist in progress. Each ticked item shows who ticked it and when, and progress moves on."}
:::

::::figures
:::figure{src="assets/screenshots/operations-checklist-phone.png" device=phone caption="Tick items on your phone as you go."}
:::
::::

**Managers** can also press :ui[Skip with reason]. The reason is required and kept in the history with the manager's name.

:::note Earlier days are closed
Checklists belong to the business date. Once the day is over, "This checklist day is closed. Earlier days can't be changed." Viewers can open checklists but not tick them ("View only — your role can't tick checklists.").
:::

## Temperature log {#operations-temperature}

The **Temperature** tab lists each fridge and freezer point with its **Target range**, today's reading, who logged it and when, and a status: **In range**, **Out of range**, **Logged** or **Not logged**.

:::figure{src="assets/screenshots/operations-temperature.png" device=desktop caption="The temperature log: which points are logged today, who logged them, and any reading outside its target range."}
:::

To log a reading:

1. Press :ui[Log temperature] at the top, or :ui[Log reading] on a point.
2. Choose the **Point** and enter the **Temperature (°C)**.
3. If the reading is outside the target range, Atlas asks what you did about it. **What you did** is required.
4. Press :ui[Save reading].

**Managers** set or change a point's range with :ui[Edit range]. Atlas never invents food-safety limits: leave a value empty if there isn't one. Until a range is set, readings are saved but Atlas can't say whether they're in range.

## Schedule {#operations-schedule}

::roles{roles="admin manager"}

The **Schedule** tab lists the routines, with the days they run, when they're due, who does them (for example "Anyone on shift") and whether they're **Active** or **Paused**. Press :ui[Edit] to change a routine's name, days, **Available from**, **Due by** and **Who does it**. Changing the schedule never deletes past checklists.

:::note Setting up new checklists
New routines and new temperature points aren't created from these screens. Once they exist for your venue, managers change their days, times and ranges here. If Operations says "Opening and closing checklists aren't set up on the server yet", ask your administrator.
:::

## On Home {#operations-home}

Operations adds rows to **Needs attention**: a checklist that isn't started or isn't finished, a routine that is due or overdue, a reading out of range, or temperatures not logged today, each with a button to open it.

:::chapter{number=8 icon=package}
# Inventory {#inventory}
Every item the bar stocks, with its verified stock, par level, status and cost. It's the starting point for counts, waste and item changes.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## The Items list {#inventory-list}

:::figure{src="assets/screenshots/inventory-list.png" device=desktop caption="The Items list: what’s on hand against par, with out, almost out and below-par items sorted to the top."}
- [76.5%, 14%] **Start stock count**, and **Add item** for managers.
- [40%, 20%] **Tabs.** Items and Counts for everyone; Movements and Waste for managers.
- [38.5%, 26.5%] **Search** by item name, supplier or code.
- [71%, 26.5%] **Filters**: Status, Category, Type, Supplier (managers) and More filters.
- [98%, 26.5%] **More inventory actions**: Identify item, and for managers Add product by camera and Download as CSV.
- [59.5%, 32%] **On hand**: verified stock, with a bar showing it against par.
- [77.5%, 32%] **Status**: Out, Almost out, Below par, Not counted or In stock.
:::

The subtitle tells you how many active items there are and when stock was last counted, for example "26 active items · counted Tuesday 22 September".

**Columns:** **Item** (with unit, pack and location), **Category**, **Supplier** (managers), **On hand**, **Par**, **Status**, **Unit cost** (managers) and **Counted**. Click a column heading to sort.

At the foot of the list: "Quantities are from the last verified count plus recorded movements."

**Download as CSV.** Managers can choose :ui[Download as CSV] from the **…** menu for a spreadsheet of the list: item, category, supplier, on hand, unit, par, status, unit cost and last counted.

::::figures
:::figure{src="assets/screenshots/inventory-list-phone.png" device=phone caption="On a phone, each row shows the item, its quantity against par and its status."}
:::
::::

### Search and filters {#inventory-filters}

- **Search items, suppliers or codes** finds items by name, supplier, barcode or SKU.
- **Status**: **Below par**, **Out or almost out**, **Not counted**.
- **Category**: Spirits, Wine, Beer, Mixers, Syrups, Bitters, Fresh fruit, Fresh herbs, Garnish, Bar ingredients, Consumables, Bar equipment, Coffee, Other, each with a count.
- **Type**: the kind within a category (Wine is always Red, White, Rosé or Sparkling).
- **Supplier** (managers).
- **More filters**: location, and **Active items**, **Inactive items** or **All items**.

When filters hide items, Atlas says how many, with :ui[Clear filters].

:::figure{src="assets/screenshots/inventory-filter-menu.png" device=desktop width=60% caption="The Status filter: show only items that are below par, out or almost out, or not counted."}
:::

### Status {#inventory-status}

| Status | What it means |
| --- | --- |
| **Out** | Verified stock is 0. |
| **Almost out** | At or under a quarter of par. It also counts as below par. |
| **Below par** | Verified stock is under the par level. An item exactly at par isn't below par. |
| **In stock** | Counted, and not below par. |
| **Not counted** | No current verified count. On hand shows "—", never 0. |
| **Unknown** | Stock couldn't be loaded, so Atlas shows no numbers at all rather than partial ones. |
| **Inactive** | Kept for history, out of counts, orders and search. |

An item can also show **Recount due** when its count is getting old.

## Live stock, imported quantities and stock-count evidence {#stock-truth}

This is the most important idea in Inventory. Atlas keeps three kinds of number apart.

::diagram[Where your stock numbers come from. Only a count that a manager has verified, plus the movements recorded since, becomes live stock.]{src="assets/diagrams/stock-truth.svg"}

- **Live stock** is what Atlas treats as on hand now: the **last verified count plus every recorded movement since**, such as deliveries received and waste recorded. This is the number in **On hand**, and the one Home, Recipes, Purchasing, Reports and Atlas AI all use.
- **Stock-count evidence** is what your team counted on the shelf, with who counted and when. It becomes live stock only when a manager **verifies** the count (Chapter 9).
- **Imported quantities** are numbers that came in from a file or another system, for example an old spreadsheet.

:::important Imported quantities are evidence, not automatically your current stock.
Importing a file never sets your stock. Only a verified count, plus the movements recorded after it, does. To get your first live numbers, start a stock count and have a manager verify it.
:::

A few rules follow from this:

- **Not counted is not zero.** An item that has never been verified shows **Not counted**, and recipes that use it can't be shown as available.
- **Verified counts expire.** A verified count is used for a set number of days (usually 7). After that the item goes back to **Not counted** until it is counted again.
- **No partial numbers.** If counts or movements can't be loaded, all stock shows as **Unknown** with "Stock figures are incomplete". Press :ui[Try again]. Nothing was changed.
- **Selling doesn't lower stock.** No till system is connected, so drinks sold don't reduce stock. That's why regular counts matter.

There is no "adjust stock" or "set quantity" button in Inventory. Stock changes only through:

1. a verified stock count,
2. waste recorded by a manager,
3. deliveries received in Purchasing.

## Item details {#inventory-item}

Click an item (or tap it on a phone) to open its details.

:::figure{src="assets/screenshots/inventory-item-detail.png" device=desktop caption="Item details for Campari: stock on hand against par, supplier, cost, location, the recipes that use it, codes and recent movements."}
- [66.5%, 10.5%] **Status**, plus **Recount due** when the count is getting old.
- [80.5%, 20.4%] **On hand** in large type, and where the number comes from.
- [76.5%, 50.5%] **Par levels are changed in Data › Par levels.** (Shown to managers.)
- [65%, 59.3%] **Used in**: the recipes that use this item.
- [72.5%, 95.8%] **Ask Atlas**, **Count this** and, for managers, **Edit details**.
:::

The details show **On hand**, **Par** ("Not set" if there isn't one), **Location**, **Supplier** and **Unit cost** (managers), **Pack**, **Last counted** ("Never") and **Category**. Below that:

- **Used in**: recipe chips, or "Not used in any recipe."
- **Codes**: **Barcode**, **SKU** and (managers) **Supplier number**. Managers can :ui[Add a barcode]; bartenders can :ui[Suggest a barcode] for a manager to approve.
- **Recent movements**: the last 10 stock changes, with type, date, note and quantity.
- **Counts**: the counts this item has been part of.

The **…** menu has :ui[Edit details], :ui[Add to an order], :ui[Record waste], :ui[Ask Atlas about this] and :ui[Deactivate] (managers).

### Units, pack and supplier {#inventory-units}

- **Counted in** is the unit you count in: bottles, cans, each, kg, g, litres, ml, cases, boxes, bags, packs, jars or kegs.
- **Unit size** and **Units per case** describe the pack, for example "1 L · 6 per case". With these set, a count can be entered in bottles, cases or litres and Atlas works out the rest.
- **Supplier** links the item to one of your suppliers. An item without a supplier can't go on a suggested order.
- **Cost per unit** (kr) is used for recipe costs and stock value. By default, receiving a delivery updates it to the delivery's cost.

### Par levels {#inventory-par}

The par level is "the quantity you want on hand after a delivery". Items under par are flagged **Below par** and suggested for ordering.

:::important Par is changed in Data › Par levels
You can set a par level when you add a new item. After that, par isn't changed on the item: managers change it in :path[Data > Par levels], where you can also let Atlas suggest pars from your verified counts and deliveries.
:::

## Adding and editing items {#inventory-add}

::roles{roles="admin manager"}

### Add an item {#inventory-add-item}

1. Press :ui[Add item]. New items start as **Not counted**.
2. Enter the **Name** (required), **Category** and **Counted in**.
3. Optionally fill in **Product details**: **Brand**, **Variant or flavour**, **Unit size**, **Units per case** and **Package**.
4. Under **Stock and cost**, choose the **Supplier**, and enter **Cost per unit**, **Par level (optional)** and **Location**.
5. Under **Codes and other names**, add a **Barcode**, **SKU or supplier number**, or **Also known as** (names the team or suppliers use).
6. Press :ui[Add item].

:::figure{src="assets/screenshots/inventory-add-item.png" device=desktop caption="Add item. Atlas checks for likely duplicates before the item is created."}
:::

**Duplicate check.** Atlas compares the new item with existing ones. If it finds **Possible existing matches**, choose :ui[Use existing item], or explain "Why is it different from …?" (for example "Different size: 70 cl vs 1 L") and press :ui[Create anyway]. Some clashes, such as a code already in use, can't be created at all.

**From a photo.** :ui[Scan product] in the Add item sheet (or **Add product by camera** in the … menu) reads the front label and fills in a **Review draft**. Check every field: readings Atlas wasn't sure about are left empty, and nothing is saved until you add the item.

:::note Bartenders suggest, managers decide
Bartenders don't see **Add item**. They can use **Suggest a new product** instead: "A manager checks it before it's added. Nothing changes until then." The suggestion waits in :path[Data > Waiting for approval].
:::

### Edit an item {#inventory-edit-item}

1. Open the item and press :ui[Edit details].
2. Change the name, category, unit, pack, **Supplier**, **Location**, **Cost per unit**, **Case cost**, **Minimum order** or **Lead time (days)**.
3. Press :ui[Save changes].

Changes are recorded with your name. Editing never changes stock, and par isn't edited here.

:::figure{src="assets/screenshots/inventory-edit-item.png" device=desktop caption="Edit details: name, category, unit, supplier, cost and ordering details. Par and stock aren’t changed here."}
:::

## Waste {#inventory-waste}

::roles{roles="admin manager"}

Record anything lost, so stock and reports stay accurate. Waste lowers stock straight away and is kept in the movement history.

1. Press :ui[Record waste] (on the **Waste** tab, or in an item's … menu).
2. Choose the **Item**. Only counted items with stock can be recorded as waste.
3. Enter the **Quantity** (up to what's on hand).
4. Choose a **Reason**: Spoilage, Breakage, Spill, Expired, Preparation waste or Other.
5. Write a **Note** (required): what happened and where.
6. Press :ui[Record waste].

:::figure{src="assets/screenshots/inventory-waste.png" device=desktop caption="Record waste with a reason and a note. Stock goes down straight away."}
:::

If Atlas says "Waste may not have been recorded", open **Movements** and check before trying again, so nothing is recorded twice.

The **Waste** tab lists only waste you record. Atlas never treats other adjustments as waste.

## Deliveries and movements {#inventory-movements}

Deliveries are received in **Purchasing** (Chapter 11). Receiving raises stock straight away.

The **Movements** tab (managers) is the history of every stock change, newest first: **Restock**, **Waste**, **Adjustment**, **Count**, **Sale** and **Transfer**, with date, item, change and note. Search by item or note and filter by type.

:::figure{src="assets/screenshots/inventory-movements.png" device=desktop caption="Movements: every recorded stock change between counts, newest first."}
:::

## Identify an item with the camera {#inventory-identify}

Anyone can use **Identify item** to find out which item a bottle is:

1. Tap the scan icon in the phone top bar, or choose :ui[Identify item] from the **…** menu.
2. Point the camera at the product or its barcode, or use :ui[Upload photo] or :ui[Type code].
3. Atlas shows its **Likely match** and how sure it is (**Sure**, **Check**, **Not sure** or **Not read**), with the verified stock.
4. Choose :ui[Open item], :ui[Count item], :ui[View recipes] or :ui[Ask Atlas], or :ui[Wrong product] if it's wrong.

::::figures
:::figure{src="assets/screenshots/inventory-identify.png" device=phone caption="Identify item recognised a syrup bottle. Identifying never changes stock or items."}
:::
::::

Identifying never changes stock or items. If Atlas can't tell, it says so and offers to search, show possible matches, or create a new product draft for a manager to check. If photo recognition isn't set up for your venue, scan the barcode or search instead.

## Deactivating and reactivating {#inventory-deactivate}

::roles{roles="admin manager"}

Items are never deleted. When you stop stocking something, deactivate it: it leaves counts, ordering and search, and its history and recipe links are kept.

1. Open the item's **…** menu and choose :ui[Deactivate].
2. Atlas checks what depends on the item first.
   - **It can't be deactivated yet** if it is on an open purchase order ("Receive or cancel it first.").
   - **Check before you continue** warns you, for example if active recipes use it ("Those recipes will show it as unavailable.").
3. Add an optional **Reason** and press :ui[Deactivate].

To bring it back, open it (filter **Inactive items**) and press :ui[Reactivate]. It comes back into counts, orders and recipes, and its history is unchanged.

:::chapter{number=9 icon=list-checks}
# Stock count {#stock-count}
Count what is physically on the shelf, one item at a time. When a manager verifies the count, it becomes the stock Atlas shows.
:::

::roles{roles="admin manager bartender" label="Who uses it"}

:::workflow The four steps of a stock count
1. Start — Choose the whole bar, one area or one category.
2. Count — Enter what's on the shelf, item by item. Pause and continue on any device.
3. Review — Check anything not counted or very different, then submit.
4. Verify — A manager checks the differences and verifies. Only now does stock update.
:::

:::important Only verification changes stock
Counting doesn't change stock, and submitting doesn't change stock. When a manager verifies the count, the counted quantities become the stock Atlas shows everywhere.
:::

## The Counts tab {#count-list}

Open :path[Inventory > Counts]. Choose **In progress**, **Verified** or **All**. Each count shows its area, status, who counted, how many items are done ("X of Y"), the differences and the date.

| Count status | Meaning |
| --- | --- |
| **In progress** | Being counted. |
| **Needs review** | Submitted, waiting for a manager. |
| **Verified** | Checked by a manager. It is now the stock Atlas shows. |
| **Sent back** | A manager asked for corrections. |
| **Cancelled** | Stopped. Nothing it counted changed stock. |

:::figure{src="assets/screenshots/count-list.png" device=desktop caption="The Counts tab with All selected: the count in progress, earlier verified counts and a cancelled one. Stock changes only after a manager verifies."}
:::

## 1. Start a count {#count-start}

1. Press :ui[Start stock count] (on Inventory, Home or in Quick actions).
2. Under **What are you counting?**, choose **Full count**, an **Area** (such as the back bar) or a **Category**. Each option shows how many items it covers.
3. Optionally give it a **Name**, such as "Back bar count".
4. Press :ui[Start count].

:::figure{src="assets/screenshots/count-start.png" device=desktop caption="Start stock count: count the whole bar, or one area or category at a time."}
:::

:::tip Count one area at a time
Smaller counts are quicker to finish and easier to check. You can pause and continue on any device.
:::

## 2. Count {#count-counting}

The count shows one item at a time, made for counting at the shelf.

:::figure{src="assets/screenshots/count-counting-phone.png" device=phone caption="Counting on a phone: one item at a time, with large buttons and the next items below."}
- [77%, 8.9%] **Progress**: how many are counted, and who started the count.
- [63%, 13.7%] **Pause**, and the **…** menu with more options.
- [73%, 32.2%] **Last verified** quantity and the par level, for reference.
- [29.5%, 40.2%] **One less / one more**, or type the number.
- [36.2%, 48.5%] **Part bottles**: add a quarter, half or three quarters.
- [48%, 58.6%] **Skip** or **Open item**.
- [20%, 96%] **Scan item** and **Save and next**.
:::

For each item:

1. Count what's on the shelf. Use the number, **One less** / **One more**, or the part-bottle buttons **+ ¼**, **+ ½**, **+ ¾**. Where the pack size allows, you can switch the unit, for example to cases or litres.
2. Press :ui[Save and next]. Atlas confirms "Saved … " with :ui[Undo], and moves on.
3. If you can't count an item, press :ui[Skip] and give a **Reason** (for example "Couldn't reach it"). A manager sees the reason.

If an item was already saved, the card says "Saved N by (name). Saving again replaces it."

**Scan instead of searching.** Press :ui[Scan item] and point the camera at the barcode or bottle. Atlas uses a match only after you confirm it ("Nothing is counted until you save"). If the item isn't in this count you can :ui[Add to this count]. If it was counted earlier, choose :ui[Add more] or :ui[Replace]. **Rapid scan** in the … menu keeps the camera open between items.

**See everything.** :ui[Show all items] lists the whole count with **Not counted**, **Counted** and **All** filters. On a computer, the **List** view lets you count row by row; changes save as you move to the next row.

**Count by voice.** Where live voice is supported, **Count by voice** in the … menu opens Atlas AI with the count as context.

:::figure{src="assets/screenshots/count-counting.png" device=desktop caption="Counting the back bar on a computer: 2 of 6 counted, entering the next quantity."}
:::

**Pause** at any time. Atlas shows "(Count) paused · X of Y counted". Continue later from **Continue** on Home or from the Counts tab, on any device.

## 3. Review and submit {#count-submit}

1. Press :ui[Finish count] in the … menu.
2. Atlas shows what's **Counted**, **Skipped** and **Not counted yet**, and any **Big differences**: items more than 10% away from the last verified count (your venue may set a different figure). Use :ui[Count now] or :ui[Recount] to fix them.
3. Press :ui[Submit for verification]. It's available once every item is counted or skipped.
4. Confirm. After you submit you can't change the count.

:::figure{src="assets/screenshots/count-finish.png" device=desktop caption="Finishing a count: what’s counted, skipped or not counted yet, and big differences to recount before submitting."}
:::

Managers now see "(Count) is waiting for verification" on Home, with :ui[Review].

## 4. Verify {#count-verify}

::roles{roles="admin manager"}

1. Open the count from Home (:ui[Review]) or from the Counts tab.
2. Check each line: **Last verified**, **Counted** and the **Difference** ("No difference", "No earlier count", or plus or minus a number).
3. Press :ui[Verify count] and confirm. Atlas shows "Count verified".

:::figure{src="assets/screenshots/count-review.png" device=desktop caption="A submitted count waiting for a manager. Differences are highlighted; Verify count makes it the stock Atlas shows."}
:::

**If stock moved during the count**, for example a delivery was received while you counted, Atlas shows "Stock changed during this count". Each counted quantity is kept as the stock at the moment it was counted, and anything recorded after that is added on top, so nothing is erased. You can press :ui[Verify anyway].

**If something is wrong**, press :ui[Send back] and say **What needs fixing?**. The team can correct it and submit again.

**To stop a count**, press :ui[Cancel count]. Nothing counted so far changes stock; the count is kept as cancelled. A manager can cancel any count; the person who started a count can cancel their own.

:::important You don't need "Prepare stock update"
After verifying, managers may see a **Prepare stock update** button. You can ignore it. Verifying the count has already updated the stock Atlas shows. That button belongs to a step that isn't switched on in this release; if you press it, Atlas may say the stock update is blocked. Nothing is wrong with your count.
:::

## Who can count {#count-roles}

- **Administrators and managers** can start, count, submit, verify, send back and cancel.
- **Bartenders** can start, count, submit and cancel their own counts, unless starting or submitting has been switched off for staff at your venue.
- **Viewers** can't count: "Counting is for bar staff and managers."

::::do-dont
:::do
- Count what's physically on the shelf, not what you expect to be there.
- Skip with a reason rather than guessing.
- Verify counts promptly, so stock stays fresh.
:::
:::dont
- Don't copy last week's numbers.
- Don't worry about verifying while deliveries come in. Later movements are added on top.
:::
::::

:::chapter{number=10 icon=martini}
# Recipes {#recipes}
The drinks and food you serve, each linked to inventory items, so Atlas can tell you what can be served tonight and, for managers, what each serve costs.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## The recipe gallery {#recipes-gallery}

:::figure{src="assets/screenshots/recipes-gallery.png" device=desktop caption="The recipe gallery: every recipe with whether it can be served tonight, based on verified stock."}
:::

The subtitle shows how many recipes you have and how many are unavailable tonight.

- **Search recipes or ingredients** looks through names, categories, glassware and ingredients.
- Filter with **All**, **Available** or **Unavailable** (managers also see **Drafts**), and the **Category** menu.
- Switch between **Grid** and **List**. In the list, managers also see **Cost**, **Price** and **Margin**.

::::figures
:::figure{src="assets/screenshots/recipes-gallery-phone.png" device=phone caption="Behind the bar, open Recipes from the tab bar to check a spec or what’s unavailable."}
:::
::::

## Availability {#recipes-availability}

Atlas works out availability from the **verified stock** of each linked ingredient:

| Pill | What it means |
| --- | --- |
| **Available** | Every ingredient is counted and in stock. |
| **Low · N left** | Fewer than 12 serves left, or an ingredient is below par. |
| **Unavailable** | An ingredient is out, for example "Olmeca Blanco Tequila: out of stock". |
| **Not counted** / **Setup incomplete** | Atlas can't check yet: an ingredient isn't counted, isn't linked to an item, or its unit or pack size doesn't match. The line underneath says which. |
| **Draft** | Archived: off service and off the menu. |

A recipe is never shown as available on a guess. Open it and look at **Why availability is unknown** to see exactly what's missing.

:::note Selling doesn't lower stock
No till system is connected to Atlas, so serving a drink doesn't reduce stock. Availability updates when stock is counted, received or recorded as waste.
:::

## A recipe {#recipes-detail}

:::figure{src="assets/screenshots/recipes-detail.png" device=desktop caption="The Negroni: availability, the build with each ingredient linked to stock, method, glass and garnish, and, for managers, cost and margin."}
:::

Each recipe shows:

- **Availability**, with how many serves you can make: "About N serves from counted stock", "None tonight", or "Unknown until every ingredient is counted and linked".
- **Build**: each ingredient with its quantity, the inventory item it uses and that item's stock (**In stock**, **Below par**, **Out**, **Not counted**, **Not linked**). Tap an ingredient to open the item.
- **Method**: numbered steps.
- **Glass**, **Garnish**, **Makes** and **Notes**.
- For managers, **Cost and price**: **Cost per serve**, **Menu price** and **Theoretical margin**.

Bartenders and viewers see everything except the cost, price and margin.

Press :ui[Ask Atlas] to ask about the recipe. While a recipe is open, Atlas keeps your phone's screen awake where the phone allows it.

:::note Margins are theoretical
Margins come from recipe costs and the menu price. Realised margin needs sales data, and no sales system is connected.
:::

## Creating and editing recipes {#recipes-edit}

::roles{roles="admin manager"}

1. Press :ui[New recipe] (or :ui[Edit] on a recipe).
2. **Details**: the **Name**, **Category** and an optional **Photo** (JPEG, PNG or WebP, up to 10 MB).
3. **Ingredients**: search for an item, choose it, enter the **Quantity** and **Unit**, and press :ui[Add]. Link every ingredient to an item so availability and cost stay current.
4. **Method**: one step per line. They show numbered at the bar.
5. **Service**: **Glass**, **Garnish**, **Makes**, **Notes**, and the boxes **On service** and **Show on the public menu**.
6. **Price**: the **Menu price**. Atlas shows the **Recipe cost**, **Cost per serve**, **Cost %** and **Profit per serve** as you type.
7. Press :ui[Save recipe]. Changes apply to service as soon as you save.

:::figure{src="assets/screenshots/recipes-edit.png" device=desktop caption="Editing a recipe: ingredients linked to inventory items, method, service details and price."}
:::

:::tip Cost needs complete items
The cost per serve appears once every ingredient has a cost and a pack size in Inventory.
:::

### Archive, restore and delete {#recipes-archive}

- :ui[Archive] takes a recipe off service and off the menu but keeps its ingredients and history. :ui[Restore to service] brings it back.
- Only archived recipes can be deleted. :ui[Delete permanently] asks you to type the recipe's name to confirm. It removes the recipe and its ingredient links; items and stock aren't changed.

### Public menu {#recipes-public-menu}

Recipes marked **Show on the public menu** appear on a public menu page for guests. Press :ui[Public menu], then :ui[Copy link] to share it.

:::important The public menu is public
Anyone with the link can see the recipes on the menu, without signing in. Only tick **Show on the public menu** for recipes you want guests to see.
:::

:::chapter{number=11 icon=truck}
# Purchasing {#purchasing}
Create purchase orders from what is below par, track approval and delivery, and receive deliveries into stock.
:::

::roles{roles="admin manager" label="Who uses it"}

Purchasing is for managers. Bartenders and viewers don't see it; a link to it shows "Purchasing is for managers".

:::important Atlas never sends orders
Atlas doesn't send orders to suppliers. Send the order as you usually do, by phone, email or the supplier's portal, then press :ui[Mark as ordered] in Atlas.
:::

## The Orders tab {#purchasing-orders}

The subtitle shows how many orders are open and how many are waiting for approval. The tabs are **Orders**, **Deliveries** and **Suppliers**.

:::figure{src="assets/screenshots/purchasing-orders.png" device=desktop caption="Orders, each with its status, total and expected delivery. Overdue deliveries stand out."}
:::

At the top, **Suggested order** says how many items are below par across how many suppliers, with :ui[Review suggestions]. Items already on an order aren't suggested again, and the card says why.

Below it, every order: when it was created and what's on it, the **Supplier**, **Status**, **Lines**, **Total** and **Delivery**. Filter by **Status** and **Supplier**.

## Order statuses {#purchasing-statuses}

::diagram[The life of a purchase order. Needs approval and Approved apply only when your venue’s rules ask for approval; a delivery that arrives in part keeps the order open as Partly received.]{src="assets/diagrams/purchase-order-lifecycle.svg"}

| Status | What it means |
| --- | --- |
| **Draft** | Being prepared. It can be changed freely. |
| **Needs approval** | Waiting for an approver. Only when your venue's approval rules apply. |
| **Approved** | Approved and ready to send. |
| **Ordered** | You've sent it to the supplier and marked it as ordered. |
| **Partly received** | Some of it has arrived. The rest is still expected. |
| **Received** | Everything has arrived. |
| **Cancelled** | Stopped before anything was received. Kept in the history. |

Two extra labels can appear: **Overdue**, when an ordered delivery is past its expected date, and **Closed short**, when the rest of a partly received order is no longer expected.

## Creating an order {#purchasing-new}

### From the suggested order {#purchasing-suggested}

The quickest way to order what's below par.

1. On the **Orders** tab, press :ui[Review suggestions].
2. Atlas groups the items by supplier, showing **On hand**, **Par** and a suggested **Order** quantity. The suggestion brings stock back up to twice the par level, rounded up to whole cases where the item has a case size.
3. Untick anything you don't want and change quantities.
4. Press :ui[Create N orders]. Atlas creates one **Draft** order per supplier.

:::figure{src="assets/screenshots/purchasing-suggested-order.png" device=desktop width=62% caption="The Suggested order sheet: below-par items grouped by supplier, with quantities you can change before creating the draft orders."}
:::

Items that aren't linked to a supplier can't go on an order: "These items aren't linked to a supplier in Atlas yet". Link a supplier in the item's **Edit details**.

### A new order by hand {#purchasing-manual}

1. Press :ui[New order].
2. Choose the **Supplier**, and an **Expected delivery** date if you know it.
3. Add **Lines**: **Item**, **Quantity** and **Unit cost** (filled in from the item's cost). Use :ui[Add line] for more.
4. Add a **Note** if needed. The running **Total** updates as you go.
5. Press :ui[Create order]. The order is saved as a **Draft**.

You can also start an order from Inventory (:ui[Add to an order] on an item, or :ui[Add to order] for ticked rows), from Home (:ui[Add to order] on an out-of-stock row), or ask Atlas AI to prepare one.

:::figure{src="assets/screenshots/purchasing-order-draft.png" device=desktop caption="A draft order. It can still be changed; send it for approval or mark it as ordered when it’s ready."}
:::

## Approval {#purchasing-approval}

Your venue's rules decide whether an order needs approval before it is ordered, for example above a certain total. When approval applies:

1. On the draft, press :ui[Submit for approval]. Home shows the approver "Order from (supplier) needs approval".
2. The approver opens the order and presses :ui[Approve], or :ui[Send back] with a reason, which returns it to **Draft**.

:::figure{src="assets/screenshots/purchasing-order-approval.png" device=desktop caption="An order waiting for approval. The approver can approve it or send it back with a reason."}
:::

The rules can require an administrator ("Only an administrator can approve this order.") or someone other than the person who submitted it ("You submitted this order, so another manager needs to approve it.").

## Marking an order as ordered {#purchasing-mark-ordered}

1. Send the order to the supplier yourself.
2. In Atlas, open the order and press :ui[Mark as ordered].
3. Confirm. The order moves to **Ordered** and appears on the **Deliveries** tab.

To change the date, press :ui[Change] next to **Expected delivery**.

## Receiving a delivery {#purchasing-receive}

Receiving is what puts stock on the shelf in Atlas.

1. Open the order and press :ui[Receive delivery] (or :ui[Receive] on Home's "Delivery from … is due today" row).
2. For each line, check the quantity. It starts at what's still expected; change it to what actually arrived. Tick **Short** or **Damaged** where it applies.
3. Press :ui[Receive X of Y lines]. Atlas confirms "Received N lines · stock updated".

:::figure{src="assets/screenshots/purchasing-receive.png" device=desktop caption="Receiving a delivery: enter what actually arrived. Here the ginger beer came short, 12 of 24."}
:::

What happens:

- **Stock goes up straight away** for everything you received.
- **The item's cost is updated** to the cost on the delivery, unless your venue has chosen to record costs only.
- If only part arrived, the order becomes **Partly received** and the rest stays open.
- Trying again after a connection problem is safe: "it won't be counted twice".
- Atlas refuses quantities well beyond what was ordered: "That's more than was ordered. Check the quantities."

:::figure{src="assets/screenshots/purchasing-order-partial.png" device=desktop caption="A partly received order shows what has arrived and what is still to come."}
:::

:ui[Receive all] receives everything that's left at the ordered cost in one step.

:ui[Close short] ends a partly received order when the rest isn't coming: "What arrived stays received. The rest is no longer expected." Give a reason. If closing short is switched off for your venue, Atlas says so.

**Check with a photo (optional).** In the receive sheet, :ui[Scan delivery] matches a photo of the delivery to the order lines. You still confirm every line.

### A delivery without an order {#purchasing-no-order}

1. Press :ui[Receive delivery] at the top of Purchasing.
2. Open **No order? Record a delivery without one**.
3. Enter the **Item**, **Quantity received**, **Supplier**, and optionally **Unit cost** and **Discount**.
4. Press :ui[Record delivery]. Stock goes up straight away.

### Cancelling {#purchasing-cancel}

:ui[Cancel order] is available until anything has been received. Nothing is received, stock doesn't change, and the order stays in the history as cancelled. Once part of an order has arrived it can't be cancelled; use :ui[Close short] instead.

## Deliveries and Suppliers {#purchasing-deliveries}

- **Deliveries** lists the deliveries you're waiting for and what has arrived, with the expected date.
- **Suppliers** lists each supplier with contact, number of items, open orders, last delivery and **Spend 30 days** (only deliveries recorded with a cost count). Open one for contact details, ordering notes, its items and orders, and :ui[New order].

:::figure{src="assets/screenshots/purchasing-suppliers.png" device=desktop caption="Suppliers: contacts, items, open orders and recent spend together."}
:::

To add a supplier, press :ui[Add supplier] on the Suppliers tab and enter the **Name**, and optionally a **Contact person**, **Phone**, **Email** and **Ordering notes** (delivery days, account number, minimum order). Suppliers can't be edited or removed from Purchasing in this release.

:::chapter{number=12 icon=calendar-days}
# Shifts {#shifts}
Managers plan and publish the rota. Everyone sees their shifts, confirms them, sets their availability and asks for time off.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## The schedule {#shifts-schedule}

Shifts opens on the current week. Use the arrows and **Today** to move, and **Week** / **Month** to change the view. On a computer or tablet, a strip above the schedule shows who's working **Today** and **Tomorrow**. Next to it, managers and bartenders have a :ui[Handover] button that opens the Shift handover channel.

:::figure{src="assets/screenshots/shifts-week.png" device=desktop caption="The manager’s week: people down the side, days across. Dashed shifts aren’t published yet."}
:::

Managers see each person as a row with their hours, and each shift as a chip with the time and role. Chips can carry a warning: **Overlap**, **Not free** (outside their availability), **Time off** or **Change** (a change was requested). Dashed chips aren't published yet.

On a phone, the schedule reads as a list of days instead of a grid.

::::figures
:::figure{src="assets/screenshots/shifts-bartender-phone.png" device=phone caption="A bartender’s own week on a phone, with shifts waiting to be confirmed."}
:::
::::

**Month** shows the whole month with names and times. Click a day to see everyone working it and add a shift.

::::figures
:::figure{src="assets/screenshots/shifts-month.png" device=desktop caption="The month view."}
:::
:::figure{src="assets/screenshots/shifts-day.png" device=desktop caption="One day opened from the month."}
:::
::::

:::note Viewers and schedule-only people
Viewers see the **Schedule** tab only. People who are "schedule only" can be put on the rota but can't sign in, so they can't confirm shifts. Shifts aren't sent to any payroll or till system.
:::

## Planning the week {#shifts-plan}

::roles{roles="admin manager"}

### Add a shift {#shifts-add}

1. Press :ui[Add shift] (or **+** in a day).
2. Choose the **Person**. People without a login show "(schedule only)".
3. Add a **Role** if useful ("Bartender, opening, closing"), the **Date**, **Start** and **End**. Start defaults to the day's opening time; an end before the start means it ends the next day.
4. Add a **Break** and a **Note** if needed.
5. Press :ui[Add shift]. It's saved as a draft: "The team sees it after you publish."

:::figure{src="assets/screenshots/shifts-add.png" device=desktop width=65% caption="Add shift: choose the person, the day and the times. Atlas warns if the shift falls outside their availability."}
:::

Use :ui[Copy last week] to start from last week's rota: every shift is copied in as a draft, and nothing is published.

### Publish {#shifts-publish}

Nothing is visible to the team until you publish. The status shows **Draft · not visible to the team**, **Unpublished changes** or **Published**.

1. Press :ui[Publish week] (or :ui[Publish month]).
2. Add a **Note to the team** if you like.
3. Confirm. The team sees the schedule straight away and is asked to confirm their shifts.

Changes to a published shift reach the team only when you publish again.

## Your shifts {#shifts-mine}

::roles{roles="admin manager bartender"}

- Switch between **Mine** and **Team**.
- On each of your shifts, press :ui[Confirm], or :ui[Request change] and say what you'd like changed ("For example: can I start at 19:00?"). Your manager sees your note.
- Your response shows as **Needs confirmation**, **Confirmed**, **Change requested** or **Declined**.

If you see "Your account isn't linked to the shift roster yet", ask a manager to add you in Team.

### Availability {#shifts-availability}

On the **Availability** tab, set your usual week: for each day, **Available** or **Unavailable**, from and until times, and a **Note**. Press :ui[Save]. Managers see a warning when a shift falls outside it.

### Time off {#shifts-time-off}

1. On the **Time off** tab, press :ui[Request time off].
2. Choose the **Type** (Vacation, Unavailable, Sick, Other), the **First day** and **Last day**, and add a note.
3. Press :ui[Send request]. Your manager is asked to approve it.

The request shows as **Pending**, then **Approved** or **Declined**.

## Managing responses {#shifts-manage}

::roles{roles="admin manager"}

- **Confirmations** lists each confirmation and change request for the week. Close a change request with :ui[Resolve] or :ui[Decline]; a note is required and is shown to the person.
- **Time off**: :ui[Approve] or :ui[Decline] requests. Shifts on approved days show a warning. :ui[Record time off] adds time off that is approved straight away.
- **Activity** is the history of publishing, changes, requests and decisions.

:::chapter{number=13 icon=users}
# Team {#team}
Everyone who works at the venue, with or without an Atlas login: profiles, photos, contacts, onboarding and, for managers, roles and access.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

## The team directory {#team-directory}

:::figure{src="assets/screenshots/team-directory.png" device=desktop caption="The team directory: each person’s role, whether they’re on today, and for managers, training and emergency contacts."}
:::

Each row shows the person's photo or initials, name, **Role** (Administrator, Manager, Bartender, Viewer or **Schedule only**) and **On shift today**. Managers also see **Training** progress and whether an **Emergency contact** is saved, and can filter by **Active**, **All** or **Inactive**, **Training due** and **Contact missing**.

## A profile {#team-profile}

Click a person to open their profile. Open your own from the account menu with **Your profile**.

:::figure{src="assets/screenshots/team-profile.png" device=desktop caption="A profile, as a manager sees it: photo, contact details, emergency contact, this week’s shifts and onboarding."}
:::

A profile holds:

- **Photo**, name, job title and role.
- **Contact**: phone and, for managers and the person themselves, email, department, employment and start date. Phone numbers are shared with managers only unless the person chooses **Everyone on the team**. Email addresses are only visible to managers.
- **Emergency contact**: visible only to the person and to managers. Managers see "N contacts saved. Shown only when needed." and press :ui[Show emergency contact] to see them.
- **Shifts this week**.
- **Onboarding**: required and optional steps, ticked off by a manager.
- On your own profile, **Required reading**, with a link to Knowledge.
- For managers: a private manager note, **Access** and **History**.

## Your name and photo {#team-name-photo}

The name you set is the name everyone sees.

1. Open your profile (account menu › **Your profile**) and press :ui[Edit profile].
2. Set **Name shown in Atlas**, your **Phone**, **Who can see the phone number** and your **Language**.
3. Press :ui[Save profile].

:::figure{src="assets/screenshots/team-profile-edit.png" device=desktop caption="Edit profile: Name shown in Atlas is the name everyone sees, including in Messages and Shifts."}
:::

Your **Name shown in Atlas** is the name your team sees in Team, Shifts and **Messages**, including on messages you sent before you changed it.

**Add a photo:**

1. On your profile, press :ui[Add photo] (or :ui[Change photo]).
2. Take a photo or choose one (JPEG, PNG or WebP). Atlas resizes it on your device.
3. Atlas confirms "Photo saved".

Your photo appears in Team, Shifts, Messages and on your account button. To remove it, press the bin: initials are shown instead. Photos are private to your team. Managers can change or remove anyone's photo.

**Emergency contact:** press :ui[Add], enter the **Name**, **Relationship**, **Phone** and **Order to call**, then :ui[Save contact]. Only you and managers can see it.

## Adding people {#team-add}

::roles{roles="admin manager"}

### Add a team member {#team-add-member}

1. Press :ui[Add team member].
2. Enter the **Name** and **Job**.
3. Choose **Atlas access**:
   - **No login — on the schedule only**,
   - **Staff login** (Bartender), or
   - **Read-only login** (Viewer).
4. For a login, enter their **Email**.
5. Press :ui[Add team member]. They appear in Team and Shifts straight away.

With a login, Atlas shows **Share the setup link**. Press :ui[Copy link] and send it to them privately. No email is sent. They use it once to choose a password.

To make someone a manager or administrator, add them first, then change their role under **Access**.

### Invite by email {#team-invite}

1. Press :ui[Invite by email].
2. Enter their **Email** and, optionally, their **Name**.
3. Press :ui[Send invitation]. Atlas emails them a secure invitation.

:::important After they accept, turn their access on
An invited person arrives with **Atlas access** off. Once they've set their password, open their profile, choose their **Role** under **Access**, switch **Atlas access** on and press :ui[Save access]. Until you do, they can't sign in.
:::

## Roles and Atlas access {#team-access}

::roles{roles="admin manager"}

The **Access** section on a profile controls what the person can do.

1. Open the person's profile and scroll to **Access**.
2. Choose the **Role**: Administrator, Manager, Bartender or Viewer.
3. Switch **Atlas access** on or off. When it's off, they're signed out on their next action.
4. Press :ui[Save access].

:::figure{src="assets/screenshots/team-profile-access.png" device=desktop width=55% caption="The Access section of a profile: role, the Atlas access switch, New setup link and Save access."}
:::

- Turning access off asks you to confirm. The person can't open Atlas until access is turned on again; their history stays.
- :ui[New setup link] makes a fresh one-time link if the first one expired.
- You can't change your own role or switch off your own access. Only an administrator can change an administrator.
- People are never deleted. Switching off access is how someone leaves; their history is kept.

:::tip Onboarding
Managers tick off onboarding steps on a person's profile. Tap a step to mark it as done or reopen it; changes are kept in the history.
:::

:::chapter{number=14 icon=book-open}
# Knowledge {#knowledge}
Your venue's procedures, policies and training in one library, with required reading that each person confirms.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

Knowledge is where the team finds out how things are done at your venue: how to open the bar, how a cocktail should leave the pass, what to do about allergens. Everyone can read the articles shared with their role. Managers write, publish and retire them.

Every article is versioned. When a manager publishes a new version of a required article, it becomes due again for everyone who must read it, so the team always confirms the version that is live now.

:::figure{src="assets/screenshots/knowledge-library.png" device=desktop caption="The Knowledge library. Categories on the left, search at the top and a Read or Draft pill on each article."}
- [28%, 20%] **Required reading** lists what you still need to read and confirm.
- [56%, 26.5%] Search looks through the articles you are allowed to read.
- [94.5%, 45.6%] A pill shows your status: Read, Required · not read or Draft.
- [93%, 14%] **New article** is shown to managers only.
:::

## The Knowledge tabs {#knowledge-tabs}

| Tab | What it shows | Who sees it |
| --- | --- | --- |
| Library | Every published article you may read, by category, with search | Everyone |
| Required reading | Articles you must read and confirm, with a count of what is due | Everyone |
| Training | Your onboarding steps and progress. Managers also see the team's progress | Everyone |
| Sources | Where articles come from (for example a Google Drive document), recorded by hand | Managers |
| Activity | Who published, read, retired or changed what | Managers |

If a bartender or viewer opens a manager tab from a link, Atlas explains: "This part of Knowledge is for managers."

## Finding and reading an article {#knowledge-read}

1. Open :path[Knowledge] from the sidebar (on a phone, :path[More > Knowledge]).
2. Choose a category on the left, or type in the search field. Search covers the full text of every article you may read.
3. Open an article. The line under the title shows its category, type, when it was updated, the reading time and the **version**.
4. Read to the end. Tick-boxes inside an article are personal checklists for you; ticking them does not change anything for anyone else.
5. If the article is required for you, press :ui[Mark as read]{icon=check}. Atlas confirms with "Marked as read", and the article shows "You've read version N."

:::figure{src="assets/screenshots/knowledge-acknowledge.png" device=desktop width=85% caption="A bartender reading a required article. Mark as read confirms this version; Ask Atlas about this opens Atlas AI with the article as context."}
- [38%, 24%] **Required · not read** until you confirm it.
- [38%, 94%] **Mark as read** confirms that you have read this version.
- [49.5%, 94%] **Ask Atlas about this** lets you ask a question about the article.
:::

:::tip Ask about an article
Not sure how a procedure applies tonight? Press :ui[Ask Atlas about this]{icon=atlas-bot} at the bottom of the article. Atlas AI answers using the article and the records your role can see.
:::

Article types are **Policy**, **Procedure**, **Checklist**, **Training**, **Reference** and **Live resource**. Some articles include a link such as :ui[Open Operations] that takes you straight to the part of Atlas the article talks about.

If search is temporarily limited, Atlas says: "Full-text search is unavailable right now, so only titles and summaries are searched." Try again a little later.

## Required reading {#knowledge-required}

The :ui[Required reading] tab shows what is due for you under **To read**. When everything is confirmed it says "You're up to date."

Required reading follows the published version. When a manager publishes a new version of a required article, it is due again. Your earlier confirmation is kept in the history against the earlier version.

## Training {#knowledge-training}

The :ui[Training] tab shows **Your training**: how many required onboarding steps are done, for example "3 of 5 required steps done." Your manager confirms each step on your profile in Team, so you cannot tick training steps yourself.

Managers also see **Team onboarding progress**, a table of every person with their required steps.

## Writing and publishing articles {#knowledge-manage roles="admin manager"}

Articles are written as private drafts. Nothing reaches the team until you publish.

### Write a new article

1. In :path[Knowledge], press :ui[New article]{icon=plus}.
2. Fill in **Title**, an optional **Summary** and the **Article** text. Start a line with `- [ ]` to make a tick-box.
3. Choose the **Category** and **Type**.
4. Under **Who can read it**, choose All, or the roles that should see it.
5. Turn on **Required reading** if everyone who can read it must confirm each published version.
6. Optionally choose **Links to** (Operations, Recipes, Inventory, Shifts, Team or Marketing) and the **Training steps it supports**.
7. Press :ui[Save private draft]. Atlas confirms: "Draft saved. Staff visibility has not changed."

:::figure{src="assets/screenshots/knowledge-edit.png" device=desktop width=70% caption="Editing an article. Changes stay in a private draft until you publish a new version."}
:::

### Publish a version

1. Open the article. A banner reads **Private draft**: only managers see it, and the team keeps reading the published version.
2. Press :ui[Publish version].
3. Add a short note under **What changed**. Everyone it is shared with sees it straight away. If it is required reading, they are asked to read it again.
4. Atlas confirms: "Version published to the team".

Below each article, managers see **Who has read this version** and the **Version history**.

### Retire an article

Press :ui[Retire], give a reason and confirm with :ui[Retire article]. The article disappears from the library for everyone. Its versions and confirmations are kept. There is no permanent delete.

### Record a source

Press :ui[Add source] on an article to record where it comes from: its **Type** (Google Drive, Atlas page, Imported file, Written by hand or Other link), **Name**, **Reference** and an optional private link. Source links are visible to managers only; you can choose to show the source name to staff.

:::note
Atlas does not sync Google Drive documents automatically. Sources are recorded by hand, and a Drive source shows as connected or not connected in the :ui[Sources] tab.
:::

:::chapter{number=15 icon=chart-no-axes-column}
# Reports {#reports}
A read-only view of how the business is doing: stock value, purchasing spend, waste, recipe margins and scheduled labour.
:::

::roles{roles="admin manager" label="Who uses it"}

Reports turn the records your team already keeps into figures for a period you choose. Nothing can be edited here, so you can explore freely. Reports are for managers and administrators; staff who follow a link see "Reports are for managers".

Reports only show what Atlas actually knows. Where a figure depends on something that is missing, such as a count or a cost, Atlas says so instead of guessing.

:::figure{src="assets/screenshots/reports-overview.png" device=desktop caption="The Reports overview for the last 30 days, compared with the previous period."}
- [63.5%, 14%] **Period**: choose the dates the report covers.
- [74.6%, 14%] **Comparison** with the previous period, or none.
- [84.9%, 14%] **Export** as CSV, PDF or a copied summary.
- [24%, 35%] The headline figures, each with a line that explains it.
:::

## Choosing the period {#reports-period}

At the top of every report:

- **Period**: Today, Last 7 days, Last 30 days (the default), This month, Last month, Year to date, or Custom dates with **From** and **To**.
- **Comparison**: "vs previous period" or "No comparison". With a comparison, figures show a change such as "▲ 12 % up", "▼ 5 % down", "Same as before" or "No comparable figure".
- **Export**: :ui[Download CSV], :ui[Print or save as PDF] or :ui[Copy summary].
- :ui[Ask Atlas]{icon=atlas-bot}: opens Atlas AI with the report as context.

The line under the page title says when the figures were updated and how many data sources are connected.

## The report tabs {#reports-tabs}

| Tab | Headline figures | Detail table |
| --- | --- | --- |
| Overview | Inventory value, Purchasing spend, Waste, Recipe margin | Needs attention, Money, Data completeness |
| Stock | Stock value, Below par, Out of stock, Counted recently | Item, Category, On hand, Par, Status, Unit cost, Value |
| Purchasing | Spend, Deliveries | Date, Item, Supplier, Quantity, Unit cost, Total |
| Recipes | Available, Running low, Unavailable, Setup incomplete | Recipe, Availability, Price, Cost per serve, Margin, Serves |
| Waste | Entries, Value | Date, Item, Type, Quantity, Value, Note |
| Labour | Shifts, Scheduled hours, Not published | Start, Person, Role, End, Hours, Published |

Each tab has a chart where there is enough data, and a table you can sort by any column, 25 rows per page.

## How to read the figures {#reports-reading}

**Inventory value** (Overview) and **Stock value** (Stock tab) are counted stock at unit cost, as it stands now. They are a snapshot of today, not of the period you chose. Atlas shows a single value only when every active item is counted and has a cost. Otherwise you see what is known, for example "At least 184 000 kr — 6 not counted · 2 without a cost", or "Unknown until every item is counted and costed".

:::important Not counted is not the same as out of stock
An item marked **Not counted** has no current verified count. Atlas does not know how many you have, so it leaves the item out of the value and never treats it as zero. Only a verified count of zero makes an item **Out**. To bring these items into your reports, count them and have a manager verify the count.
:::

**Counted recently** shows how many active items have a current verified count, for example "38 of 52". Verified counts expire after a set number of days, after which the item returns to Not counted until it is counted again.

**Purchasing spend** includes only deliveries that were received with a cost. "No deliveries with a cost in this period" means nothing costed was received in the period. It does not mean you spent nothing: deliveries recorded without a cost are simply not in the figure.

**Waste** shows only waste that someone recorded in Inventory. "None" means no waste was recorded in the period. When some entries have no cost, the value line says so.

**Recipe margin** is theoretical: it comes from recipe costs and menu prices. The line under it shows how many recipes are fully costed.

**Labour** shows scheduled hours only. Atlas does not store pay rates, so labour cost is not shown. **Not published** counts shifts that are still drafts.

**Sales** show as "Not connected". No point-of-sale system sends sales to Atlas, so revenue, popularity and realised margin are never shown or estimated.

:::figure{src="assets/screenshots/reports-stock.png" device=desktop caption="The Stock tab: stock value now, items below par or out of stock, and how many items have a recent verified count."}
- [83%, 35%] **Counted recently**: items with a current verified count, out of all active items.
:::

A dash (—) in a table cell means the value was not recorded. It is not a zero.

If stock data could not load, Reports shows "Stock figures are incomplete" and hides inventory value, suggested orders and count coverage until everything loads. Press :ui[Try again]. Nothing was changed.

## Data completeness {#reports-completeness}

At the bottom of the Overview, **Data completeness** shows how complete your records are: **Items with a cost**, **Items with a par level**, **Items with a supplier**, **Items counted recently** and **Recipes fully costed**, each as a percentage. Anything under 100 % has a :ui[Fix] link that takes you to the right place, usually :path[Data > Issues] or :path[Data > Par levels].

Next to it, each data source shows its state: **Connected**, **Partly complete**, **Not connected**, **No records yet** or **Nothing this period**.

:::tip Better records, better reports
Most gaps in Reports are closed by three habits: count regularly, receive deliveries with their cost, and give every item a supplier and par level.
:::

## Exporting {#reports-export}

- :ui[Download CSV] saves the current report and period as a spreadsheet file. Atlas confirms "CSV downloaded."
- :ui[Print or save as PDF] opens your browser's print dialog.
- :ui[Copy summary] copies a short text summary you can paste into a message or email. Atlas confirms "Summary copied."

:::chapter{number=16 icon=megaphone}
# Marketing {#marketing}
Plan posts and campaigns, send them for approval, and keep track of what was published.
:::

::roles{roles="admin manager" label="Who uses it"}

Marketing helps managers plan social media and campaign work in one calendar, agree it through an approval step, and keep a history of what went out. In this release, Atlas does not post anything itself: you publish on the social network as you do today, then mark the post as published in Atlas.

Marketing is for managers and administrators. Bartenders and viewers who open a Marketing link see "Marketing is for managers". Staff can still share ideas in the **Marketing** channel in Messages.

## Available now {#marketing-now}

:::figure{src="assets/screenshots/marketing-overview.png" device=desktop caption="The Marketing overview: what is coming up in the next 14 days, what is waiting for approval, and suggestions from your venue's routines."}
- [35.5%, 18%] Publishing is manual. Atlas records what went out; it does not post.
- [93.8%, 63.4%] **Review** opens a post waiting for your approval.
- [93.5%, 78.7%] **Plan this** turns a suggestion into a draft.
:::

Under the page title a line explains how publishing works: "Publishing is manual until a social account is connected." A link, :ui[Connections in Settings], opens :path[Settings > Integrations].

### The Marketing tabs

- **Overview**: **Coming up** (the next 14 days), **Waiting for approval**, and **Suggestions** from your venue's routines. Suggestions are only ideas: nothing is posted automatically. When one is due today, :ui[Plan this] turns it into a draft.
- **Calendar**: a month view of everything planned, with :ui[Previous month], :ui[This month] and next.
- **Posts**: your posts, filtered as Active, Drafts, Waiting or Approved.
- **Campaigns**: groups of posts and tasks around one goal, such as a menu launch or an event.
- **History**: **Published and done**, and an **Activity** log of every step.

Post types are Post, Story, Reel, Campaign task, Event promotion, Idea and Google post. Channels are Instagram, Facebook, TikTok and Google Business Profile.

### Plan a post

1. Press :ui[New post draft]{icon=plus}. The sheet reminds you: "Nothing is posted automatically."
2. Enter a **Title**, choose the **Type**, an optional **Campaign** and the **Channels**.
3. Write the **Text**. The **Preview** updates as you type.
4. Under **Photos or video needed**, describe the media, for example "Close-up of the new espresso martini". Atlas doesn't store post media yet, so keep the photo or video yourself and attach it when you post.
5. Set **Post on** (venue time) and, if you like, **Remind me**.
6. Press :ui[Save draft] to keep working on it, or :ui[Submit for approval].

:::figure{src="assets/screenshots/marketing-editor.png" device=desktop caption="A new post draft with channels, text, the media you will need and a preview."}
:::

### Approve a post

1. Open the post from **Waiting for approval** (:ui[Review]).
2. Read it through. If you want changes, write a **Note for the team**. A note is needed to request changes or reject.
3. Press :ui[Approve], :ui[Request changes] or :ui[Reject].

### Publish and mark as published

1. Post the approved content yourself on the social network or Google profile.
2. Open the post in Atlas and press :ui[Mark as published].
3. Atlas confirms: "Marked as published. Nothing was posted by Atlas."

The post moves to **History**, so everyone can see what went out and when.

### Campaigns

Press :ui[New campaign], give it a **Name**, a **Type** (Promotion, Event, Seasonal, Always on, Brand or Other), **Starts** and **Ends** dates and an optional **Goal**, then :ui[Create campaign]. Choose the campaign when you plan each post.

:::note Post statuses
Idea, Draft, Waiting for approval, Changes requested, Approved, Scheduled, Published, Done, Rejected and Cancelled. "Scheduled" means a time is planned; it does not mean Atlas will post it.
:::

## Coming in a later release {#marketing-later}

:::coming-later Marketing publishing
A later release is planned to add a media library for storing photos and videos, publishing through connected social accounts, and a scheduler. None of this is live today. Atlas does not post automatically, and connecting an account in Settings does not make Atlas publish anything. This guide will be updated when these features are released.
:::

:::chapter{number=17 icon=database}
# Data and imports {#data}
Bring outside files in safely, fix incomplete records, set par levels and approve catalogue changes.
:::

::roles{roles="admin manager" label="Who uses it"}

Data is the manager's workshop for the quality of your records. Here you upload files from outside Atlas, see which items and recipes are missing information, set par levels in bulk, and decide on catalogue changes that staff scans, imports and Atlas AI propose.

The golden rule is simple: nothing in Data changes your live records until a manager has reviewed it.

Data is for managers and administrators. The sidebar badge on **Data** shows how many catalogue changes are waiting for approval.

## The Data tabs {#data-tabs}

| Tab | Use it to |
| --- | --- |
| Imports | Upload a file and follow what happens to it |
| Issues | Find items and recipes with missing information, and fix them |
| Par levels | Set or change par levels for many items at once |
| Import review | Approve or reject records from earlier imports, one by one |
| Waiting for approval | Decide on new items, names, barcodes and duplicates proposed by the team |

## Uploading a file {#data-import}

1. In :path[Data], press :ui[Import a file]{icon=upload}.
2. Under **What does this file contain?**, choose Inventory and stock counts, Recipes, Suppliers, Menus, Invoices, Purchases or Photos.
3. Choose the file or drop it on **Choose a file or drop it here**. CSV, Excel, PDF, JSON, text or a photo, up to 50 MB.
4. Press :ui[Upload]. Atlas confirms "File uploaded." and opens the import.

:::figure{src="assets/screenshots/data-imports.png" device=desktop caption="The Imports list: each file with what it contains, its status, how many records it holds and when it was uploaded. This example includes files from earlier imports in other statuses."}
- [92.7%, 14%] **Import a file** uploads a new file.
- [60%, 36.6%] The status of each file.
:::

### What you see after uploading

The import page shows three steps, **Upload**, **Review** and **Import**, and the facts about your file: what it contains, its size, how many records it holds ("Not read yet" until it has been read), and when it was uploaded.

In this release, Atlas does not read uploaded files automatically. Your file is stored privately, visible to managers only, and stays in the **Uploaded** status. From the import page you can:

- :ui[Download file]{icon=download} to get the original back.
- :ui[Cancel import]. Atlas stops working on the file but keeps it, so you can delete it or try again later.
- :ui[Delete import]. The uploaded file and its import record are removed. Live records are not changed. This can't be undone.

Imports can show these statuses: Uploaded, Uploading, Reading, Needs review, Imported, Failed and Cancelled. If a file could not be read, you see "Atlas couldn't read this file." Your live records were not changed; upload a corrected file. Spreadsheets work best as CSV with one product per row.

:::important Imported quantities are evidence, not automatically your current stock
A stock figure in a file tells you what someone counted at some point in the past. Atlas never turns it into the stock it shows. Only a verified stock count, plus the deliveries, waste and other movements recorded since, becomes the **On hand** figure in Inventory.
:::

## Import review {#data-import-review}

:ui[Import review] lists records from earlier imports that are waiting for a decision: "Nothing here changes live records until you approve it." Filter by type (for example Inventory, Recipes, Suppliers or Invoices) and status (Waiting, Held, Source checked, Approved, Rejected or Excluded).

1. Open a record. You see **What the file says**, the **Original row** and any issues.
2. Choose an **Action**: Needs review, Create new item, Merge into an existing item, or Skip. For a merge, choose the **Existing record**.
3. Add **Notes** if useful, then press :ui[Approve] or :ui[Reject] (or :ui[Back to waiting]).

Approving a record here does not change live records by itself. Atlas confirms: "Approved. Live records change only when the import runs."

## Issues {#data-issues}

:ui[Issues] lists active items and recipes that are missing something Atlas needs, such as:

- "No supplier", "No unit or case cost", "No package size", "No par level"
- "No SKU, barcode or supplier reference"
- "No menu price", "No ingredients", or an ingredient that "isn't linked to an item"
- a possible duplicate ("Looks like … (N % match)") or a code shared by several items

Each row has a button that takes you to the fix: :ui[Set par], :ui[Edit recipe], :ui[Open item], :ui[Review] or :ui[Resolve]. When everything is in place, the tab says "No record issues". Counts refresh when you come back after fixing a record.

For a possible duplicate, choose what the pair really is: the same product (keep one, retire the other; stock is never moved), different products (stop suggesting this pair), or the same product in a different pack size. Press :ui[Save decision].

## Par levels {#data-par-levels}

A par level is the quantity you want on hand after a delivery. Atlas uses it to show what is **Below par** and to suggest orders. Par levels are changed here, in bulk, rather than in the item details.

1. Open :path[Data > Par levels]. Use search, **All categories** and **All suppliers** to narrow the list.
2. Type a value in **New par** for each item you want to change.
3. Optionally enter **Days of cover** and press :ui[Suggest pars]. Where Atlas has enough evidence, a **Suggested par** appears; press :ui[Use] to copy it into New par.
4. The bar at the bottom shows how many changes are not saved. Press :ui[Save N changes], or :ui[Discard].

:::figure{src="assets/screenshots/data-pars.png" device=desktop caption="Par levels: current par, a suggested par where there is enough evidence, and the new value you type."}
:::

Suggestions use only verified counts and recorded deliveries: at least 3 counts over 14 days. When there is not enough evidence, Atlas says why, for example "Needs 3 counts; has 1" or "Counts cover 6 days; needs 14". Nothing is saved until you press Save.

If someone else changed a par while you were editing, Atlas saves nothing and tells you. Press :ui[Load current values] and make your changes again.

## Waiting for approval {#data-approvals}

When a bartender suggests a new product or barcode from a scan, when a scan is reported as the wrong product, or when Atlas AI proposes a new name or item, the request waits here for a manager. Home also shows managers "N catalogue changes are waiting for your approval".

1. Open :path[Data > Waiting for approval]. Each row says what is proposed, for example "Link barcode … to Campari" or "Add a new item: …".
2. Press :ui[Review]. Check the details, who requested it and where it came from (a scan, Atlas AI, an import), and any **Similar items**.
3. Add a **Note** if useful and press :ui[Approve] or :ui[Reject].

Approved changes are applied straight away: "Approved and applied." Approving a catalogue change never changes stock quantities.

:ui[Suggest missing details] asks Atlas to read each active item's category, size and package text and propose the missing product type and unit size. Every suggestion waits here for your approval; no item changes until you approve it.

::figure[Catalogue changes waiting for a manager's decision.]{src="assets/screenshots/data-approvals.png" device=desktop width=85%}

:::chapter{number=18 icon=settings}
# Settings {#settings}
Venue details, opening hours, rules, Atlas AI, outside connections and your own preferences.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

Settings has one section for each area. Managers and administrators see most sections. Bartenders and viewers reach only **Preferences** and **Notifications**, from the account menu (:ui[Preferences] or :ui[Notification settings]) or, on a phone, from :path[More > Preferences].

Each section is a form. When you change something, a bar appears with **Unsaved changes**, :ui[Discard] and a save button. Sections you can see but not change say "Read-only for your role". Every saved change is kept in :path[Settings > Activity].

:::role-matrix Who sees each Settings section
| Section | admin | manager | bartender | viewer |
| --- | --- | --- | --- | --- |
| Venue | yes | yes | no | no |
| Opening hours | yes | yes | no | no |
| Team access | yes | no | no | no |
| Notifications | own | own | own | own |
| Operational rules | yes | yes | no | no |
| Atlas AI | yes | yes | no | no |
| Integrations | yes | yes | no | no |
| Security | view | no | no | no |
| System health | view | no | no | no |
| Preferences | own | own | own | own |
| Activity | view | view | no | no |
:::

## Venue {#settings-venue roles="admin manager"}

The business details Atlas uses on documents, in Atlas AI and for your team: **Business name**, **Legal name**, **Registration number**, **Location name**, **Address**, **City**, **Country code**, **Language**, **Email**, **Phone**, **Website** and **Booking link**. Amounts are always in Icelandic krónur (the page shows **Currency: ISK (fixed)**).

The business name and city appear under the Atlas logo in the sidebar and on the sign-in screen.

## Opening hours {#settings-hours roles="admin manager"}

Opening hours drive "today" everywhere in Atlas: the Home timeline, checklists and what Atlas AI knows about service times. Without saved hours, Atlas says so; it never guesses.

1. Under **Time zone**, check the venue time zone and press :ui[Save time zone] if you change it.
2. Under **Weekly hours**, set for each day whether you are **Open**, and when it **Opens** and **Closes**. Tick **Next day** when you close after midnight. Add **Last orders** and **Kitchen** times if you use them.
3. :ui[Copy Monday to all] fills every day from Monday.
4. Press :ui[Save hours].

A late close still belongs to the day you opened: a Friday that closes at 02:00 is Friday's business day.

**Offers** such as a happy hour appear on the Home timeline on their days. Press :ui[Add offer], fill in the name, times, days and description, and press :ui[Create offer].

:::figure{src="assets/screenshots/settings-hours.png" device=desktop caption="Weekly opening hours. Tick Next day when the venue closes after midnight."}
:::

## Team access {#settings-team-access roles="admin"}

What each role may do. Administrators see one form per role with its permissions and :ui[Save permissions]. The Administrator role is protected.

A person's role, and whether they can sign in at all, are changed on their profile in :path[Team], not here. Invitations are also sent from Team, with :ui[Invite by email].

## Notifications {#settings-notifications}

Alerts on this device. See the Notifications chapter for how to turn them on and what each status means.

## Operational rules {#settings-rules roles="admin manager"}

Thresholds, reminders and approvals for **Shifts and service**, **Stock**, **Temperature log**, **Cleaning** and **Marketing approvals**. Each form tells you whether it is in use: "Settings marked “in use” change Atlas today; the rest are saved for upcoming features." or "Saved for upcoming features — these don't change Atlas yet."

The **Stock** rules include **Count difference allowed (%)**, which decides which lines a stock count flags as a big difference.

The **Ordering** rules (approval before ordering, receiving more than ordered, closing an order short, delivery date required, staff receiving deliveries) are shown read-only. They explain how Purchasing behaves at your venue.

## Atlas AI {#settings-ai roles="admin manager"}

Whether Atlas AI is on for the venue, and its daily limits. The status pill shows **On**, **On, but not connected yet** or **Off**. When Atlas AI is off, it answers from saved records only and prepares nothing.

Where your venue's setup shows them, you can set limits per person per day, such as questions, voice conversations, voice minutes, files and upload size, and how long photos and files are kept.

Under **Your replies**, anyone who can open this section can choose how Atlas AI answers them personally: **Reply length**, whether to read answers aloud in voice conversations, whether to offer voice, and the reply **Language**.

Under **Suggestions and learning**, choose whether Atlas learns from orders, recipes and waste. Atlas never acts on a suggestion by itself; a person approves every change.

## Integrations {#settings-integrations roles="admin manager"}

Outside accounts Atlas can use: **Google Business Profile**, **Google Drive**, **Facebook Page**, **Instagram**, **TikTok** and **Tripadvisor**. Connecting happens on the provider's own page; Atlas never sees your passwords.

Each provider shows its real state:

| State | What it means |
| --- | --- |
| Not set up yet | This connection has not been prepared for your venue. An administrator can set it up. |
| Not connected | Ready to connect. Press :ui[Connect]. |
| Checking | Atlas is checking the connection. |
| Connected | The account is linked. Use :ui[Test connection] to check it, or :ui[Disconnect]. |
| Needs attention | The connection stopped working. Press :ui[Reconnect]. |
| Waiting for platform review | The provider is still reviewing the connection. |

:::important
Connecting an account does not make Atlas post anything. Marketing is still published by hand and marked as published in Atlas.
:::

:::figure{src="assets/screenshots/settings-integrations.png" device=desktop caption="Integrations: each provider shows its real state. Here nothing is connected yet, and one provider is not set up."}
:::

## Security {#settings-security roles="admin"}

A read-only overview for administrators. **Enforced now**: **Staff sign-in**, **Active profile required**, **Role-based access** and **Keys stay on the server** (connection passwords never reach your browser). **Not available yet**: two-factor authentication, automatic sign-out after inactivity, trusted devices and emergency lockdown. To remove someone's access today, turn off their Atlas access in Team.

## System health {#settings-system roles="admin"}

A read-only technical overview of Atlas's services for administrators. It never reports a service as healthy without a check.

## Preferences {#settings-preferences}

Everyone's own settings, saved to your profile:

- **Start page**: the page Atlas opens after you sign in. Only pages your role may open are offered.
- **Reduce motion**: turns off animations across Atlas.

The section also shows your notification status on this device, the theme (Light is the only theme for now), the language (English) and the venue's time zone. Press :ui[Save preferences].

## Activity {#settings-activity roles="admin manager"}

"Changes to settings, newest first. This history can't be edited." Every saved setting appears with who changed it.

:::chapter{number=19 icon=bell}
# Notifications {#notifications}
What changed and what needs you, in one place, and optional alerts on your device.
:::

::roles{roles="admin manager bartender viewer" label="Who uses it"}

Atlas has two kinds of notifications: the **bell** inside Atlas, which everyone has, and optional **device notifications**, which you turn on per device.

## The bell {#notifications-bell}

The bell :icon[bell] in the top bar opens **Notifications**. A dot on the bell means something is unread.

:::figure{src="assets/screenshots/shell-notifications.png" device=desktop caption="The Notifications panel. Each item has a button that takes you straight to it."}
- [96%, 3%] The bell, with a dot when something is unread.
- [88%, 9%] **All** or **Needs action**.
- [95.3%, 9%] More options: **Mark all as read** and **Notification settings**.
- [94.4%, 17.4%] Each item's button opens it and marks it read.
:::

What you find there:

- Everything in **Needs attention** on your Home that your role can see, such as an out-of-stock item or a checklist that is not done.
- One item for each Messages conversation with unread messages, for example "3 new messages in General".
- Other updates from the parts of Atlas you use.

Use **All** or **Needs action** to filter. Tap an item to open it; it is marked as read. Use the :ui[…] menu for :ui[Mark all as read].

When there is nothing new you see "You're up to date", or with Needs action, "Nothing needs you right now".

:::note Read on one device, unread on another
Read and unread is remembered on each device. If you read a notification on your phone, it can still show as unread on the computer in the office.
:::

On a phone, Notifications opens full screen. Use the back button to close it.

## Notifications on your device {#notifications-device}

You can ask Atlas to send alerts to this phone or computer. It is a separate choice on each device.

1. Open the account menu and choose :ui[Notification settings] (or :path[Settings > Notifications]).
2. Under **This device**, press :ui[Turn notifications on].
3. Your browser asks for permission. Allow it.

:::tip iPhone and iPad
On iPhone and iPad, add Atlas to the Home Screen first (Share, then Add to Home Screen), open it from there, then turn notifications on.
:::

:::coming-later Alerts delivered to your devices
You can already turn notifications on for a device, and Atlas keeps that choice. Sending the alerts to phones and computers is switched on in a later release. Until then nothing arrives on the device, and the status adds "Atlas has not switched on alert delivery yet, so nothing will arrive until it does." Keep using the bell and the unread badges.
:::

To stop alerts on a device, press :ui[Turn notifications off]. This device is unsubscribed; your other devices are not affected.

::figure[Settings › Notifications. Here the browser has blocked notifications, so the status says what to do.]{src="assets/screenshots/settings-notifications.png" device=desktop width=85%}

**Alerts sent today** lists the alerts a device is set to receive: **New messages in Messages** and **Published shift changes**.

The status on **This device** tells you where you stand:

| Status | What to do |
| --- | --- |
| On | Nothing. This device is subscribed. |
| Off | Press :ui[Turn notifications on]. |
| Needs reconnecting | Press :ui[Reconnect this device]. |
| Blocked in browser | Open this site's settings in your browser (the icon next to the address), allow notifications, then reload Atlas. |
| Not set up | Notifications are not set up on the Atlas server yet. Use the bell. |
| Not supported | This browser can't receive notifications. Use the bell. |

:::chapter{number=20 icon=workflow}
# Common workflows {#workflows}
Five everyday routines, step by step, using the parts of Atlas that are live today.
:::

Each card follows a real routine from start to finish. The role line tells you who does it. Steps name the exact buttons you press.

## Opening the venue {#workflow-opening roles="admin manager bartender"}

:::workflow Opening the venue {layout=vertical icon=sun}
1. Open Home — Read the line under the greeting: when you open, how the opening checklist is going and how many are on shift tonight.
2. Check Needs attention — Start at the top: out-of-stock items, deliveries due today and temperatures not logged yet. Each row has a button that takes you there.
3. Open the checklist — Press :ui[Opening checklist] on Home. Tick each item as you do it; Atlas saves your name and the time straight away.
4. Log temperatures — Press :ui[Log temperature] in Operations, choose the point and enter the reading. If it is out of range, say what you did about it.
5. Read the handover — Open :path[Messages > Shift handover] for anything the last shift left for you.
6. Complete the checklist — Press :ui[Complete checklist]. Everyone sees it as done, with your name and the time.
:::

Managers can also press :ui[Add to order] on an out-of-stock row. Viewers can follow along but can't tick checklists.

::figure[The opening checklist after ticking an item: your name and the time are saved straight away.]{src="assets/screenshots/operations-tick-item.png" device=desktop width=80%}

## Receiving a delivery {#workflow-delivery roles="admin manager"}

:::workflow Receiving a delivery {layout=vertical icon=truck}
1. Find the order — On Home, press :ui[Receive] on "Delivery from … is due today", or open :path[Purchasing > Deliveries] and open the order.
2. Start receiving — Press :ui[Receive delivery]. Optionally, under **Check with a photo**, press :ui[Scan delivery] to match a photo of the delivery to the order; you still confirm every line.
3. Check each line — Each line starts at the quantity still expected. Change it to what actually arrived and mark :ui[Short] or :ui[Damaged] where needed.
4. Receive — Press :ui[Receive X of Y lines]. Stock goes up straight away and the order shows Partly received or Received.
5. Deal with the rest — If the remainder will not come and closing short is switched on, press :ui[Close short] and give a reason.
:::

If everything arrived as ordered, :ui[Receive all] receives every remaining line at the ordered cost. For goods that came without an order, press :ui[Receive delivery] at the top of Purchasing and open **No order? Record a delivery without one**.

Receiving is for managers. If you are a bartender and a delivery arrives, let a manager know, for example in :path[Messages > Operations].

::figure[Receiving a delivery: one line arrived short, 12 of 24.]{src="assets/screenshots/purchasing-receive.png" device=desktop width=80%}

## Adding a new cocktail {#workflow-cocktail roles="admin manager"}

:::workflow Adding a new cocktail {layout=vertical icon=martini}
1. Check the ingredients — Search :path[Inventory] for each ingredient. If one is missing, press :ui[Add item]. New items start as Not counted.
2. Create the recipe — In :path[Recipes], press :ui[New recipe]. Add the name, category and a photo if you have one.
3. Link every ingredient — Under Ingredients, use **Find an item**, enter the quantity and unit, and press :ui[Add]. Linked ingredients let Atlas work out availability and cost.
4. Method, service and price — Write one step per line, add glass, garnish and notes, and enter the **Menu price** to see cost per serve and profit.
5. Save — Press :ui[Save recipe]. Make sure **On service** is ticked to put it on service; tick **Show on the public menu** if guests should see it.
6. Check availability — The recipe shows Available, Low, Unavailable or Setup incomplete. Setup incomplete lists what is missing, such as an ingredient that is not counted yet.
7. Tell the team — Post in :path[Messages > General], or write a Knowledge article linked to Recipes. Plan a post in Marketing if you want to promote it.
:::

A new ingredient only shows as available after it has been counted and the count verified.

## Preparing for the weekend {#workflow-weekend roles="admin manager"}

:::workflow Preparing for the weekend {layout=vertical icon=calendar-days}
1. Count the bar — Earlier in the week, press :ui[Start stock count] and count the whole bar or one area. Staff can count and press :ui[Submit for verification].
2. Verify the count — Open the count from Home ("… is waiting for verification"), check the differences and press :ui[Verify count]. Verified counts become the stock Atlas shows.
3. Review the suggested order — In :path[Purchasing > Orders], press :ui[Review suggestions]. Adjust quantities and press :ui[Create N orders]. They are created as drafts.
4. Send and mark the orders — Send each order to the supplier as you usually do, by phone, email or their portal. Then press :ui[Mark as ordered]. Atlas never sends orders for you.
5. Publish the rota — In :path[Shifts], press :ui[Copy last week] or add shifts, then :ui[Publish week] with a note to the team. Staff are asked to confirm their shifts.
6. Brief the team — Post weekend news in :path[Messages > Announcements].
:::

:::ai Let Atlas prepare it
You can ask Atlas AI "What needs ordering for the weekend?" or ask it to prepare a draft order. It prepares a card; nothing is created until a manager taps the button on it.
:::

## Staff handover {#workflow-handover roles="admin manager bartender"}

:::workflow Staff handover {layout=vertical icon=messages-square}
1. Finish the closing checklist — On Home, after last orders, press :ui[Closing checklist], tick each item and press :ui[Complete checklist].
2. Pause any count — If a stock count is still open, press :ui[Pause]. The next person can continue on any device.
3. Write the handover — Open :path[Messages > Shift handover] (or :ui[Handover] in Shifts) and press :ui[Write handover].
4. Fill in what matters — **What happened**, **Stock issues** and **For the next shift**. At least one section is needed.
5. Post it — Press :ui[Post handover]. The next shift sees it in Shift handover, with an unread badge on Messages.
:::

Report waste or breakage to a manager in the handover; recording waste in Inventory is for managers.

::figure[Write handover, opened from the Shift handover channel.]{src="assets/screenshots/messages-handover.png" device=desktop width=80%}

:::chapter{number=21 art="assets/brand/atlas-bot.png" art-crop=right icon=atlas-bot}
# Atlas AI: example questions {#ai-examples}
Questions to try, grouped by what you want to know.
:::

Atlas AI answers from your venue's records, and only from what your role may see. Under each answer, **How Atlas knows** lists the records it used and marks each one as Verified, Calculated, Estimate, Interpretation or Missing.

When Atlas can help with a change, such as a draft order or a count, it prepares a card. Nothing happens until someone with the right role taps the button on the card. Typing or saying "yes" is not an approval.

## Suggested in Atlas {#ai-examples-suggested}

These are the suggestions Atlas shows when you start a new conversation. Which ones you see depends on your role.

:::prompts Start here
- What's low before tonight? — Everyone. Checks verified stock against par levels.
- Who's on tomorrow? — Everyone. Reads the published schedule.
- Does this delivery match our order? — Administrators and managers. Take a photo of the delivery note or boxes.
- Which recipes can't we make tonight? — Bartenders and viewers. Checks recipes against verified stock.
- Count the back bar by voice — Administrators, managers and bartenders. Starts a live voice conversation.
- What's on today's checklist? — Viewers. Reads today's checklists.
:::

With a photo attached, Atlas offers: "Does this match our order?", "Count these bottles" and "What is this?". A count from a photo is an estimate for you to check.

::figure[A new conversation with the suggestions for a manager.]{src="assets/screenshots/ai-empty.png" device=desktop width=80%}

## Stock and recipes {#ai-examples-stock}

:::prompts For everyone
- How many bottles of Campari do we have? — Uses the last verified count plus recorded movements. If the item isn't counted, Atlas says so.
- Which items haven't been counted recently? — Lists items with no current verified count.
- Can we make a Negroni tonight? — Checks every linked ingredient against verified stock.
- What's in our Espresso Martini? — Reads the recipe build and method.
- What waste was recorded this week? — Reads waste recorded in Inventory.
- Is this barcode in our inventory? — Looks up the code you give it.
:::

## Ordering and money {#ai-examples-managers roles="admin manager"}

:::prompts For managers
- What needs ordering from each supplier? — Uses below-par items and skips what is already on an open order.
- Prepare a draft order for our spirits supplier. — Prepares a card; tap Create order to make a Draft.
- Which deliveries are due or overdue? — Reads open orders and their expected dates.
- Have any supplier prices gone up recently? — Compares recent delivery costs.
- What does an Espresso Martini cost us per serve? — Uses ingredient costs and pack sizes.
- Which recipes have the best margin? — Theoretical margin, from recipe costs and menu prices.
- What is our stock worth right now? — Counted stock at unit cost; tells you what is not counted or costed.
- How much did we spend on deliveries this month? — Costed deliveries only.
:::

## Team, shifts and procedures {#ai-examples-team}

:::prompts Running the shift
- Who is working on Friday? — Reads the published schedule.
- What does our closing procedure say about the ice well? — Searches Knowledge articles you may read.
- Is the opening checklist done? — Reads today's checklists.
- Draft a message to the team that we're out of limes. — Prepares a message card; tap Send message to post it.
- Draft a shift for Friday 18:00 to 01:00. — Managers. Saves an unpublished draft shift once you tap the card.
- Write a draft article on how we store garnishes. — Managers. Saves a private Knowledge draft.
:::

## What Atlas AI will not do {#ai-examples-limits}

- It never changes stock, orders, shifts or messages on its own. Every change is a card that a person taps.
- It never invents stock, costs, sales, item names or barcodes. If something is missing, it says so.
- It does not know sales: no point-of-sale system is connected.
- It never sends anything to suppliers or posts to social media.
- It does not change settings, par levels, roles or recipes. For settings and par levels it can only suggest a change and open the right page.

:::note When Atlas AI is off
If Atlas AI isn't switched on for your venue, you still get **Quick answers** from your records for questions like "What is low in stock?", "What needs ordering?", "Can we make a Margarita?" or "Who works tomorrow?". Photos and files need Atlas AI to be switched on.
:::

:::chapter{number=22 icon=circle-alert}
# Troubleshooting {#troubleshooting}
The messages you may see, what they mean and what to do.
:::

Atlas tells you plainly when something did not work, and almost always whether anything was changed. Find the message below, then follow the action.

:::important If the problem continues
If the steps here don't help, contact your venue's Atlas administrator. Tell them what you were doing, the exact message you saw, and the time.
:::

## Signing in and access {#trouble-signin}

| What you see | What to do |
| --- | --- |
| "Email or password is incorrect." | Check both and try again. If you have forgotten your password, press :ui[Forgot your password?] on the sign-in screen. |
| A message that your account is not an active staff profile and to ask an administrator to review access | Your Atlas access is off. This is normal right after you accept an email invitation. Ask a manager to open your profile in Team, set your role, turn **Atlas access** on and save. |
| "This invitation has expired or was already used. Ask your manager for a new one. If you already set a password, sign in instead." | Ask your manager for a new setup link, or sign in if you already chose a password. |
| "This reset link is invalid or has expired. Request a new link below." | Request a new reset link and use the newest email. Each link works once. |
| "Atlas couldn't connect. Check your connection, then try again." | Check Wi-Fi or mobile data, then press :ui[Retry connection]. |
| "Your session ended. Sign in again to continue where you were." | Sign in again. Atlas takes you back to where you were. |
| "Atlas can't check your sign-in right now. You're still signed in; try again in a moment." | Wait a moment and carry on. |

New passwords need at least 10 characters.

## Offline and saving {#trouble-offline}

| What you see | What to do |
| --- | --- |
| "You're offline. Changes can't be saved until you reconnect." | Reconnect, then refresh. Atlas does not queue changes while offline, so redo anything that was not saved. |
| "Not sent" with :ui[Retry] on a message | Press :ui[Retry] when you are back online. |
| "… changed on another device. It's been refreshed; check it and try again." | Someone else changed the same thing. Check the refreshed version, then make your change again. |
| "Someone else saved this after you opened it." (Settings) | Discard your changes to see theirs, then edit again. |

## Permission denied {#trouble-permission}

| What you see | What it means |
| --- | --- |
| "That page is for managers. Ask an administrator if you need access." | The page is for managers and administrators. Atlas takes you to Home. |
| "Purchasing is for managers", "Reports are for managers", "Marketing is for managers", "Data is for managers" | These areas are for managers only. |
| "Your role can't do that in …" or "This isn't available for your role." | Your role can't make this change. Ask a manager. |
| "You can read messages. Ask a manager if you need to post." | Viewers can read Messages but not post. |
| "Only managers can post in Announcements. You can read everything here." | Post in another channel, or ask a manager. |
| "Your role can view checklists but not tick them." | Viewers can follow checklists but not tick them. |
| "Only a manager can approve this." (Atlas AI card) | Ask a manager to tap the card. |

If you think your role is wrong, ask your venue's Atlas administrator. Roles are changed on your profile in Team.

## Stock and counts {#trouble-stock}

| What you see | What to do |
| --- | --- |
| "Not counted" or "Stock hasn't been counted yet." | Atlas has no current verified count for the item. It is not out of stock. Start a stock count and have a manager verify it. |
| "Stock figures are incomplete" | Part of the stock data didn't load, so Atlas hides all stock numbers rather than show wrong ones. Press :ui[Try again]. Nothing was changed. |
| "Count or skip every item first." | Count or skip the remaining items before you submit. |
| "This line changed on another device. It's been refreshed; check it and save again." | Check the quantity and save again. |
| "Stock changed during this count" | Read the list, then press :ui[Verify anyway]. Later changes are added on top; nothing is erased. |
| "Only counted items with stock can be recorded as waste." | Count the item and have the count verified first. |
| "Waste may not have been recorded." | Open Movements to check before trying again, so nothing is recorded twice. |

## Upload failed {#trouble-upload}

| What you see | What to do |
| --- | --- |
| "Atlas couldn't read this file." (Data) | Your records were not changed. Upload a corrected file. Spreadsheets work best as CSV with one product per row. |
| "This file is larger than 25 MB." (Atlas AI) | Use a smaller file. |
| "Photos and PDFs in one message can be up to 20 MB together. Remove one and try again." | Send fewer or smaller files in each message. You can attach up to 4 files per message. |
| "Atlas can read photos, PDFs, text and CSV files." | Save the file in one of these formats. |
| "That photo wasn't accepted. Use a JPEG, PNG or WebP image under 2 MB." (profile photo) | Choose a JPEG, PNG or WebP photo. |
| "Photos and files need Atlas AI to be switched on." | Atlas AI is off for your venue. Ask your administrator. |

## Photo or camera not working {#trouble-photo}

| What you see | What to do |
| --- | --- |
| "Profile photos couldn't be loaded. Initials are shown instead." | Nothing is lost. Try again later. |
| "Camera access is off. Allow the camera in your browser settings, or upload a photo." | Allow the camera for Atlas in your browser's site settings, or use :ui[Upload photo] or :ui[Type code]. |
| "No barcode found. Take a photo of the label." | Take a clear photo of the front label. |
| "Photo recognition isn't set up yet. Scan the barcode or search instead." | Use the barcode or search. |
| "Microphone access is blocked. Allow it in your browser settings to record." | Allow the microphone for Atlas in your browser's site settings. |

## Integration not set up {#trouble-integrations}

| What you see | What to do |
| --- | --- |
| "Not set up yet" in Settings › Integrations | The connection has not been prepared for your venue. An administrator can set it up. |
| "… isn't set up yet. An administrator can set it up." | As above. |
| "You cancelled on … Nothing was connected." | Press :ui[Connect] again and finish the steps on the provider's page. |
| "Needs attention" | Press :ui[Reconnect]. |
| "Not connected — Atlas doesn't sync Drive documents automatically." (Knowledge › Sources) | Expected. Record sources by hand. |
| "Sales … Not connected" (Reports) | Expected. No point-of-sale system is connected, so sales are not shown. |

## Atlas AI limits and what it can't do {#trouble-ai}

| What you see | What to do |
| --- | --- |
| "Atlas AI isn't switched on yet" | Your venue hasn't switched Atlas AI on. Quick answers from your records still work. An administrator can switch it on in Settings › Atlas AI. |
| "You've reached today's limit …" or "You've used today's live voice sessions." | Daily limits reset within 24 hours. Text and voice notes may still work. A manager can review the limits in Settings › Atlas AI. |
| "Atlas is getting a lot of requests from you right now. Wait a minute, then try again." | Wait a minute. |
| "Atlas took too long to answer. Try again, or ask a narrower question." | Ask about one thing at a time. |
| "That message is too long. Shorten it and try again." | Shorten your message. |
| "Live voice is still open on another device or tab." | Press :ui[Continue here] to move it to this device. |
| "This proposal was already handled or has expired." | Cards expire after 24 hours. Ask Atlas to prepare it again. |
| "Something changed since Atlas prepared this. Nothing was changed." | Ask Atlas to prepare it again with the current records. |
| Atlas answers but does not make the change | This is by design. Atlas prepares a card; a person with the right role taps it. Settings, par levels, roles and recipes are changed on their own pages. |

## Other messages {#trouble-other}

| What you see | What to do |
| --- | --- |
| "Checklists aren't available in this environment yet." or checklists "aren't set up on the server yet" | Ask your administrator. Checklist templates are set up for the venue. |
| "This checklist day is closed. Earlier days can't be changed." | Nothing to do. Past days are kept as they were. |
| "Opening hours aren't set" | A manager adds them in Settings › Opening hours. |
| "Your account isn't linked to the shift roster yet. Ask a manager to add you." | A manager adds you in Team. |
| "No published shifts this week" | The manager hasn't published the week yet. |
| "This article isn't available. It may have been retired or isn't shared with your role." | Ask a manager. |
| "Nothing was saved: N par levels were changed by someone else" | Press :ui[Load current values] and make your changes again. |
| "Reports aren't switched on for this venue yet." / "Marketing isn't switched on for this venue yet." | Ask your administrator. |
| "Notifications are blocked for Atlas in this browser." | Allow notifications in the browser's site settings, then reload Atlas. |
| "This page doesn't exist" | The link is old or mistyped. Press :ui[Go to Home]. Nothing was changed. |

:::chapter{number=23 icon=list-checks}
# Quick reference {#quick-reference}
Every part of Atlas on one page: what it is for, who uses it and the one action to know.
:::

:::quick-ref Atlas at a glance {icon=layout-grid}
| Module | Purpose | Who uses it | Key action |
| --- | --- | --- | --- |
| Home | What needs you today | Everyone (viewers see Needs attention only) | Work down **Needs attention** |
| Atlas AI | Ask about the venue; approve prepared changes | Everyone | Ask a question, tap a card to approve |
| Messages | Team channels, handovers, announcements | Everyone (viewers read only) | :ui[Write handover] |
| Operations | Opening and closing checklists, temperature log | Everyone (viewers read only) | Tick items, :ui[Log temperature] |
| Inventory | Items, verified stock, par and status | Everyone | :ui[Start stock count] |
| Stock count | Count, submit, verify | Managers and bartenders | :ui[Save and next], :ui[Verify count] |
| Recipes | Specs and what can be served tonight | Everyone (managers edit) | :ui[New recipe] |
| Purchasing | Orders, deliveries, suppliers | Managers | :ui[Review suggestions], :ui[Receive delivery] |
| Shifts | Rota, confirmations, time off | Everyone (managers plan) | :ui[Publish week], :ui[Confirm] |
| Team | People, profiles, access | Everyone (managers manage) | :ui[Add team member] |
| Knowledge | Procedures, policies, training | Everyone (managers write) | :ui[Mark as read] |
| Reports | Stock value, spend, waste, margins, hours | Managers | Choose a **Period**, :ui[Export] |
| Marketing | Plan, approve and track posts | Managers | :ui[New post draft], :ui[Mark as published] |
| Data | Imports, issues, par levels, approvals | Managers | :ui[Import a file], :ui[Save N changes] |
| Settings | Venue, hours, rules, connections, preferences | Managers; everyone for Preferences | :ui[Save hours], :ui[Save preferences] |
| Notifications | Bell and device alerts | Everyone | :ui[Mark all as read] |
:::

:::quick-ref Shortcuts {icon=zap}
| To do this | Do this |
| --- | --- |
| Search or ask Atlas | :kbd[Ctrl K] (:kbd[⌘K] on a Mac), or :kbd[/] when not typing |
| Ask Atlas with what you typed | :kbd[Ctrl ↵] (:kbd[⌘↵] on a Mac) |
| Close a panel or dialog | :kbd[Esc] |
| Change your start page | :path[Account menu > Preferences] |
| Turn on alerts on this device | :path[Account menu > Notification settings] |
| Sign out of this device only | :path[Account menu > Sign out] |
:::

:::quick-ref Stock words {icon=package}
| You see | It means |
| --- | --- |
| In stock | Verified stock that is not below par |
| Below par | Verified stock under the par level |
| Almost out | At or under a quarter of par (also below par) |
| Out | A verified count of zero |
| Not counted | No current verified count. Not zero, not out of stock |
| Unknown | Stock data didn't load, so no figures are shown |
| Recount due | The count is older than your venue allows |
:::

:::chapter{number=24 icon=book-open}
# Glossary {#glossary}
The words Atlas uses, and what they mean.
:::

:::glossary
Administrator
: The role with full access, including Team access, Security and System health in Settings. Only an administrator can change another administrator.

Almost out
: Verified stock at or under a quarter of the par level. Almost out also counts as below par.

Announcements
: The Messages channel for official notices. Only managers and administrators can post there.

At a glance
: The tiles on Home for stock, recipes and purchasing, or your next shift.

Atlas access
: The switch on a person's profile in Team that lets them sign in. When it is off, they are signed out on their next action.

Bartender
: The role for bar staff: counts stock, ticks checklists, logs temperatures, reads recipes, messages the team and confirms their own shifts. Bartenders don't see costs, orders or most settings.

Below par
: Verified stock under a positive par level.

Business day
: The day Atlas counts as "today". It follows your opening hours: a close after midnight belongs to the day you opened.

Catalogue change
: A proposed new item, name, barcode, detail correction or duplicate decision. It waits in Data › Waiting for approval until a manager decides.

Close short
: Finishing a partly received order when the rest will not arrive. What arrived stays received.

Days of cover
: How many days of use a par level should cover. Used by Suggest pars in Data › Par levels.

Decisions
: The managers' list in Atlas AI of what Atlas suggested, what was decided and what happened next.

Draft
: Something saved but not yet live: a draft order, an unpublished shift, a private Knowledge draft or a Marketing post.

How Atlas knows
: The list of records under an Atlas AI answer, each marked Verified, Calculated, Estimate, Interpretation or Missing.

Import
: A file uploaded in Data. It never changes live records until reviewed and approved.

Inactive
: An item or person kept for history but out of daily use. Items can be reactivated.

Manager
: The role that runs the venue day to day: purchasing, reports, marketing, data, shifts and most settings.

Mark as ordered
: Recording that you sent an order to the supplier yourself. Atlas never sends orders.

Mark as published
: Recording that you posted a Marketing post yourself. Atlas does not post.

Mark as read
: Confirming that you have read the current version of a required Knowledge article.

Movement
: A recorded change to stock: Restock, Waste, Adjustment, Count, Sale or Transfer.

Needs attention
: The list on Home of what needs someone now, also found in Notifications under Needs action.

Not counted
: No current verified count for an item. Atlas shows a dash, never zero, and does not treat the item as out of stock.

On hand
: The last verified count plus every movement recorded since.

Out
: A verified stock level of zero.

Par level
: The quantity you want on hand after a delivery. Set in Data › Par levels, or when adding an item.

Proposal card
: What Atlas AI prepares when it can help with a change, such as a draft order. Nothing happens until a person with the right role taps its button. Cards expire after 24 hours.

Publish
: Making a draft visible to the team: a week or month in Shifts, or a version of a Knowledge article.

Quick answer
: A fixed answer from your records, shown when Atlas AI is off.

Recount due
: Shown when an item's stock figure is older than your venue's count window, so it should be counted again.

Required reading
: A Knowledge article that everyone it is shared with must confirm, for each published version.

Retire
: Removing a Knowledge article from the library. Its versions and confirmations are kept.

Schedule only
: A person on the shift roster without an Atlas login.

Shift handover
: The Messages channel for what the next shift needs to know, written with Write handover.

Suggested order
: Items below par, grouped by supplier, with quantities that restore twice the par level.

Theoretical margin
: Margin worked out from recipe costs and menu prices. Realised margin needs sales, which are not connected.

Today's briefing
: A short summary on Home built from your opening hours, shifts, checklists, stock counts, recipes and orders.

Verified count
: A stock count that a manager has verified. It becomes the stock Atlas shows.

Viewer
: A read-only role. Viewers can follow the pages their role opens, such as checklists, stock, recipes, shifts and messages, but can't tick, count or post.

Waste
: Stock recorded as lost, with a reason: Spoilage, Breakage, Spill, Expired, Preparation waste or Other. Recorded by managers.
:::
