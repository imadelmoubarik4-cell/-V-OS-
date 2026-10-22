# KANEL — guest confirmation procedure (until automated emails exist)

**Status: proposed. Owner to approve before Phase B activation.**

While email delivery is off, **a guest learns the outcome of a web request only when
KANEL staff contact them.** The website tells the guest their request is *not* a
confirmed reservation and shows a `KA-XXXXXX` reference. There is no status page and
no automatic email. (Alcedo queues guest emails in a sealed outbox, but sends none.)

**The one rule:** never tell a guest, in any channel, that a booking is confirmed
until staff have (1) approved it in Alcedo and (2) told the guest. "We've received
your request" is not a confirmation.

## Owner decisions needed

| Decision | Suggestion |
|---|---|
| Who monitors requests, by shift | Manager on duty; owner as backup |
| Response target | Within 2 hours while open; by 12:00 next day for requests that arrive while closed |
| Same-day requests | Phone (not email) if the visit is under 4 hours away |
| Minimum notice for web requests | Not enforced by the system today. Decide whether same-day requests are acceptable. |
| Group requests (5+) | Website sends them to email/phone (online limit 1–4); handle as today |

## Routine

1. **Check.** At opening, every two hours while open, and at closing: open Alcedo →
   Bookings. Web requests show as **Requested**. If the staff inbox is enabled
   (Phase A7), managers also see them in the bell.
2. **Act quickly.** A web request holds its seats for about **15 minutes** only.
   After that the seats can be taken by someone else, so assigning may fail.
3. **Decide in Alcedo first** (open the booking):
   - **Approve:** assign seats. Assigning seats to a web request confirms it, and
     the status becomes **Confirmed**. (Alcedo refuses **Confirm** until seats are
     assigned.) If assignment is refused (seats taken, crossing a Bar section, or
     within 15 minutes of another booking on that stool), pick other stools or
     offer another time.
   - **Decline:** press **Cancel** on the *requested* booking. Alcedo records a
     cancelled request as *declined* (inbox and the queued guest email).
   - **Offer another time:** Alcedo cannot move a booking's time. Contact the guest
     first. If they accept, create a new staff booking at the new time, then
     **Cancel** the original request. If they don't, **Cancel** it.
4. **Contact the guest.** Phone first for same-day requests; otherwise email from
   kanel@kanel.is. Quote the `KA-` reference.
5. **Log it.** Alcedo has no field for adding notes to an existing booking, so keep
   a simple shared contact log: date, `KA-` reference, who, how (phone or email),
   when, and the outcome ("phoned 14:05 — confirmed — JS"). It contains guest
   details, so keep it in a staff-only place and clear it under the same retention
   rule. (A notes field on existing bookings would be a small follow-up change.)
6. **No answer.** Leave a voicemail and send an email. Try once more after 2 hours.
   If there is still no answer, decide as a team (keep or release). Note it.
7. **Guest phones in with a reference.** Look up the `KA-` reference in Alcedo and
   tell them the actual status. "Requested" means *not yet confirmed*.

## Message scripts

**Confirmed — EN**
> Hello {name}, this is KANEL. Your table for {party} on {day} {date} at {time} is
> confirmed (reference {KA-ref}). We keep the table for two hours. If your plans
> change, just reply or call +354 692 0528. See you at Geirsgata 17!

**Staðfest — IS**
> Sæl/l {nafn}, þetta er KANEL. Borðið þitt fyrir {fjöldi} {dagur} {dagsetning} kl.
> {tími} er staðfest (tilvísun {KA-ref}). Borðið er frátekið í tvær klukkustundir.
> Ef áætlanir breytast máttu svara þessum pósti eða hringja í +354 692 0528.
> Hlökkum til að sjá þig á Geirsgötu 17!

**Declined — EN**
> Hello {name}, thank you for your request ({KA-ref}). Unfortunately we can't offer a
> table for {party} on {date} at {time}. You are very welcome to walk in, or to
> request another time at kanel.is.

**Ekki hægt — IS**
> Sæl/l {nafn}, takk fyrir beiðnina ({KA-ref}). Því miður getum við ekki boðið borð
> fyrir {fjöldi} {dagsetning} kl. {tími}. Þú ert hjartanlega velkomin/n án bókunar,
> eða þú getur óskað eftir öðrum tíma á kanel.is.

**Another time — EN**
> Hello {name}, thank you for your request ({KA-ref}). {time} on {date} is full, but
> we can offer {alt-time}. Shall we confirm that for you? Your booking is not
> confirmed until we hear back from you.

**Annar tími — IS**
> Sæl/l {nafn}, takk fyrir beiðnina ({KA-ref}). Kl. {tími} {dagsetning} er fullbókað
> en við getum boðið kl. {annar-tími}. Viltu að við staðfestum það? Bókunin er ekki
> staðfest fyrr en við heyrum frá þér.

(Have a native speaker check the Icelandic before use. Use "Sæl/l" or the guest's
name as appropriate.)

## Privacy reminders for staff

Use guest details only for this booking. Don't copy them into personal phones or
chats. Don't add health details to notes beyond what is needed for service.

## When automated emails arrive (Phase C, separate approval)

This routine stays the fallback. Before any email provider is switched on, the owner
decides whether the **existing queued outbox is sent or discarded**. Sending old
"received" emails days late would confuse guests. The suggestion is to discard
everything older than 24 hours.
