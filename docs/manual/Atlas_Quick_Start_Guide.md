---
title: Quick Start Guide
subtitle: Restaurant & Hospitality Operating System
tagline: Everything you need for your first shift with Atlas.
version: Atlas Quick Start Guide · Version 0.8 · September 2026
release: Based on Atlas production release 0.8.0 (main ef7c907, 26 September 2026)
footer: Atlas Quick Start Guide · Version 0.8 · September 2026
doc-title: Atlas Quick Start Guide
cover: light
---

:::chapter{number=1 icon=house}
# Welcome to Atlas {#qs-welcome}
Atlas is where your venue keeps its stock, recipes, checklists, shifts and team messages, and where you can ask Atlas AI about any of it.
:::

This short guide covers what you need on your first shift. The full **Atlas User Guide** explains every page in detail.

What you see in Atlas depends on your role: **Administrator**, **Manager**, **Bartender** or **Viewer**. If a page in this guide is missing for you, it is for another role.

## Signing in {#qs-signin}

1. Open Atlas in your browser, on a phone, tablet or computer.
2. Enter your **Email** and **Password** and press :ui[Sign in].
3. Forgot your password? Press :ui[Forgot your password?] and follow the link sent to your email.

Your manager gives you access in one of two ways:

- **A setup link.** Open it, choose a password of at least 10 characters, and press :ui[Create login].
- **An email invitation.** Set your password from the email. Then your manager turns on your Atlas access. Until they do, sign-in tells you to ask an administrator to review your access.

Signing out with :ui[Sign out] signs you out of this device only.

## Getting around {#qs-navigation}

**On a computer**, the sidebar on the left holds every page you can use, grouped as **Venue** (Operations, Inventory, Recipes, Purchasing), **People** (Shifts, Team, Knowledge) and **Business** (Reports, Marketing, Data). Your name at the bottom opens your account menu.

**On a phone**, the tab bar at the bottom has :ui[Home], :ui[Inventory], :ui[Atlas], :ui[Recipes] and :ui[More]. **More** opens everything else, your preferences and :ui[Sign out].

**Everywhere**, the top bar has:

- **Search or ask Atlas**: type the name of an item, recipe or person, or ask a question. On a computer press :kbd[Ctrl K] (:kbd[⌘K] on a Mac).
- **The bell** :icon[bell]: what changed and what needs you. Tap an item to go straight there.

::::figures
:::figure{src="assets/screenshots/signin-phone.png" device=phone width=34mm caption="Sign in with your email and password."}
:::
:::figure{src="assets/screenshots/phone-more-bartender.png" device=phone width=34mm caption="On a phone, More lists the other pages your role can use."}
:::
::::


## Home {#qs-home}

Home answers one question: is today under control, and what needs me?

- The line under the greeting shows when you open or close, how the opening checklist is going and how many are on shift tonight.
- **Needs attention** lists what to act on first, such as an item out of stock or a temperature not logged. Each row has a button that takes you there.
- **Today's briefing** sums up the day in a sentence or two, from real records only. Press :ui[Ask a follow-up] to ask Atlas AI more.
- **Tonight** shows who is on shift.
- The :ui[Opening checklist] button, or :ui[Closing checklist] after last orders, opens today's checklist.

Tick each checklist item as you do it. Atlas saves your name and the time straight away, and everyone sees the same list.

::include{from="Atlas_User_Guide.md#home-routine" shift=1}


::::keep
## Atlas AI {#qs-atlas-ai}

Ask Atlas about your venue in plain language. It answers from your venue's records, and only from what your role may see. Look for the robot: tap :ui[Atlas]{icon=atlas-bot} on the phone tab bar, or :path[Atlas AI] in the sidebar.

:::prompts Try asking
- What's low before tonight? — Checks verified stock against par levels.
- Who's on tomorrow? — Reads the published schedule.
- Which recipes can't we make tonight? — Checks recipes against stock.
- What does our closing procedure say about the ice well? — Searches Knowledge.
:::
::::

- **Type, talk or add a photo.** The mic records a voice note; :ui[Talk to Atlas] starts a live voice conversation; :ui[+] attaches a photo or file.
- **Check the sources.** Under each answer, **How Atlas knows** lists the records Atlas used.
- **Approve with a tap.** When Atlas can help with a change, such as saving a count or sending a message, it prepares a card. Nothing happens until someone with the right role taps the button on it. Saying or typing "yes" is not an approval.

Atlas never changes stock, orders or shifts on its own, never invents numbers, and never sends anything to suppliers.

::::figures
:::figure{src="assets/screenshots/home-bartender-phone.png" device=phone width=34mm caption="Home on a bartender's phone: what needs doing tonight comes first."}
:::
:::figure{src="assets/screenshots/ai-empty-phone.png" device=phone width=34mm caption="Atlas AI: start with a suggestion or type your own question."}
:::
::::

## Inventory {#qs-inventory}

Inventory lists every item the bar stocks, with its stock and status. Tap an item to see where it is kept, its par level and the recipes that use it.

| Status | What it means |
| --- | --- |
| In stock | Enough on hand |
| Below par | Under the quantity you want after a delivery |
| Almost out | A quarter of par or less |
| Out | A verified count of zero |
| Not counted | No current count. Atlas doesn't know how many there are. It is not out of stock |

Stock figures come from the last **verified** count plus the deliveries, waste and other movements recorded since.

::::figures
:::figure{src="assets/screenshots/inventory-list-phone.png" device=phone width=34mm caption="Inventory on a phone, with stock and status for each item."}
:::
:::figure{src="assets/screenshots/count-counting-phone.png" device=phone width=34mm caption="Counting one item at a time. Save and next moves on."}
:::
::::

### Counting stock

Bartenders and managers can count.

1. In :path[Inventory], press :ui[Start stock count].
2. Choose **Full count**, an area or a category, and press :ui[Start count].
3. For each item, enter what is on the shelf. Use :ui[+ ½] and the other part chips for open bottles. Press :ui[Save and next].
4. Can't reach something? Press :ui[Skip] and give a reason.
5. Need to stop? Press :ui[Pause]. You or a colleague can continue on any device.
6. When every item is counted or skipped, press :ui[Finish count], then :ui[Submit for verification].

A manager then checks the differences and presses :ui[Verify count]. Only then does the count become the stock Atlas shows.


:::tip Identify an item
Not sure what a bottle is? On a phone, tap the scan icon in Inventory's top bar and point the camera at the product or its barcode. Identifying never changes stock or items.
:::

## Purchasing {#qs-purchasing roles="admin manager"}

Purchasing is for managers. It holds orders, deliveries and suppliers.

1. **Order.** On the :ui[Orders] tab, press :ui[Review suggestions] to see items below par grouped by supplier, then :ui[Create N orders]. Or press :ui[New order].
2. **Send it yourself.** Atlas doesn't send orders to suppliers. Send the order as you usually do, then press :ui[Mark as ordered].
3. **Receive.** When the delivery arrives, open the order and press :ui[Receive delivery]. Check each line, mark anything :ui[Short] or :ui[Damaged], and press :ui[Receive X of Y lines]. Stock goes up straight away.

If you are a bartender and a delivery arrives, let a manager know.

## Messages {#qs-messages}

Messages are the team's shared channels: **General**, **Operations**, **Shift handover**, **Announcements** and **Marketing**. Everyone in a channel sees what is posted there.

- Type your message and press Send. Use the paperclip, :ui[Link a record], to attach an item, checklist or shift.
- Your own messages show **Sent**, then **Read by N** once colleagues have read them.
- You can edit or delete your own message within 15 minutes.
- At the end of your shift, open **Shift handover** and press :ui[Write handover]. Fill in **What happened**, **Stock issues** and **For the next shift**, then :ui[Post handover].

Only managers post in Announcements. Viewers can read every channel but can't post.

## Shifts {#qs-shifts}

Shifts shows the published rota. Choose **Mine** for your own shifts or **Team** for everyone.

- When a week is published, press :ui[Confirm] on each of your shifts, or :ui[Request change] with a short note.
- On the :ui[Availability] tab, set the days and times you can usually work, then press :ui[Save].
- On the :ui[Time off] tab, press :ui[Request time off], choose the type and dates, and :ui[Send request]. Your manager approves or declines it.

A week that isn't published yet shows no shifts.


## Where to get help {#qs-help}

- **Ask Atlas AI.** It can explain where to find things and answer questions about stock, recipes, shifts and procedures.
- **Read Knowledge.** Your venue's procedures and training live in :path[Knowledge]. Anything marked **Required · not read** is for you to read and confirm with :ui[Mark as read].
- **Ask your manager** about anything to do with your role, your shifts or your access.

**Your name and photo.** Open the account menu, choose **Your profile** and press :ui[Edit profile] to set the **Name shown in Atlas**, the name your team sees in Messages and Shifts. :ui[Add photo] adds your picture.

:::keep
### When something doesn't work {#qs-trouble}

| What you see | What to do |
| --- | --- |
| "Email or password is incorrect." | Check both, or press :ui[Forgot your password?] |
| A message that your account is not an active staff profile | Ask your manager to turn on your Atlas access. |
| "You're offline. Changes can't be saved until you reconnect." | Reconnect, then refresh. Redo anything that wasn't saved. |
| "That page is for managers." | The page is for another role. Ask a manager if you need it. |
| "Not counted" on an item | Nobody has a verified count yet. It is not out of stock. Count it. |
| "Atlas AI isn't switched on yet" | Quick answers from your records still work. Your administrator can switch Atlas AI on. |
:::

If a message says "Nothing was changed", you can safely try again. If a problem continues, tell your venue's Atlas administrator what you were doing, the exact message and the time.
