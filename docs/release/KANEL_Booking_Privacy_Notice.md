# KANEL — booking privacy notice (EN / IS) — DRAFT for legal review

**Status: draft. Not published.** The text describes what the Alcedo booking system
actually does as built in PR #135. Items in **[brackets]** are facts the owner must
confirm or decide before publication. Publish it (for example at `/privacy/` and
`/is/personuvernd/`, linked from the booking form) only as part of the approved
website change in Phase B. Have a native speaker and the company's legal adviser
review the Icelandic text.

Facts behind the text (for the reviewer, not for publication):

| Topic | What the system does |
|---|---|
| Fields collected | name (required), email, phone, party size, date/time, optional note (max 500 characters). The website requires email and phone so staff can reply. |
| Where it is stored | Alcedo's database on Supabase **region eu-west-1 (Ireland, EEA)**, confirmed from the Supabase project on 22 Oct 2026. Sent directly from the browser to the booking service over HTTPS. Netlify (website host) does not receive the form contents. |
| IP address | Used only to limit abuse. A salted one-way hash is stored, never the raw IP. Rows are removed automatically by later requests, normally within about an hour. |
| Status token | A random token is created per request. The website discards it; it is never stored in the browser. |
| Guest emails | Not sent. Emails are queued in a sealed outbox inside the database until an email provider is approved. |
| Retention | **90 days after the visit**, enforced by S111 (`atlas_private.booking_purge_personal_data`, nightly pg_cron job `kanel-booking-retention`). Publish the 90-day text below **only after S111 is applied in production** and the cron job is confirmed. |
| Who can see it | Signed-in KANEL staff in Alcedo. The booking inbox is limited to managers and administrators. |
| Analytics | The booking form loads no analytics or trackers. (The site loads Google Fonts and links to Google Maps. The site-wide privacy policy should cover these.) |

---

## English

### Booking requests at KANEL — how we use your information

**Who is responsible.** KANEL **[legal entity name, kennitala]**, Geirsgata 17,
101 Reykjavík, Iceland, is the controller of the personal data you give us when you
request a table. Contact: kanel@kanel.is · +354 692 0528.

**What we collect.** Your name, email address, phone number, the number of guests,
the date and time you request, and any note you add. Please don't include health or
other sensitive information in the note. For allergies, tell your server on the day.

**Why we use it.** Only to handle your booking request: to check availability, to
hold your request while our team reviews it, to contact you with the answer, and to
prepare for your visit. The legal basis is taking steps at your request before
entering into an agreement with you (GDPR Art. 6(1)(b); Icelandic Act No. 90/2018).

**A request is not a confirmed booking.** Your table is confirmed only when a member
of our team contacts you to confirm it.

**Abuse protection.** To stop automated misuse we use a one-way, salted code derived
from your IP address. We do not store the IP address itself. The code is deleted
automatically, normally within about an hour.

**Who processes it for us.** Our booking system, Alcedo, runs on Supabase, which
stores the data for us under a data processing agreement **[confirm DPA in place;
hosting region: Ireland (EEA)]**. We do not sell your data or use it for marketing, and the booking form
uses no analytics or advertising trackers.

**How long we keep it.** We keep your booking details for 90 days after your visit.
After that they are deleted automatically: your name, phone number, email and any
requests or notes are removed, and only an anonymous record (date, party size) remains.

**Your rights.** You can ask for access to your data, for correction or deletion,
for restriction, or object to its use. Email kanel@kanel.is. If you think we have not
handled your data properly, you can complain to the Icelandic Data Protection
Authority (Persónuvernd), www.personuvernd.is.

---

## Íslenska

### Borðapantanir hjá KANEL — hvernig við notum upplýsingarnar þínar

**Ábyrgðaraðili.** KANEL **[nafn lögaðila, kennitala]**, Geirsgötu 17,
101 Reykjavík, er ábyrgðaraðili þeirra persónuupplýsinga sem þú veitir okkur þegar
þú óskar eftir borði. Netfang: kanel@kanel.is · sími +354 692 0528.

**Hvað við skráum.** Nafn, netfang, símanúmer, fjölda gesta, dagsetningu og tíma
sem þú óskar eftir og athugasemd ef þú bætir henni við. Vinsamlegast skráðu ekki
heilsufarsupplýsingar eða aðrar viðkvæmar upplýsingar í athugasemdina. Láttu
þjóninn vita af ofnæmi á staðnum.

**Til hvers.** Eingöngu til að afgreiða bókunarbeiðnina þína: til að kanna laus
sæti, taka beiðnina frá á meðan starfsfólk fer yfir hana, hafa samband við þig með
svar og undirbúa komu þína. Heimildin er ráðstafanir sem gerðar eru að þinni beiðni
áður en samningur er gerður (b-liður 1. mgr. 6. gr. GDPR; lög nr. 90/2018).

**Beiðni er ekki staðfest bókun.** Borðið er aðeins staðfest þegar starfsmaður
okkar hefur samband við þig og staðfestir það.

**Vörn gegn misnotkun.** Til að hindra sjálfvirka misnotkun notum við einstefnukóða
með salti sem leiddur er af IP-tölu þinni. Við vistum ekki IP-töluna sjálfa. Kóðanum
er eytt sjálfkrafa, að jafnaði innan um klukkustundar.

**Vinnsluaðilar.** Bókunarkerfið okkar, Alcedo, keyrir á Supabase, sem geymir
gögnin fyrir okkur samkvæmt vinnslusamningi **[staðfesta vinnslusamning;
hýsingarsvæði: Írland (EES)]**. Við seljum ekki
upplýsingarnar þínar né notum þær í markaðsskyni og bókunarformið notar engar
vefmælingar eða auglýsingarakningu.

**Varðveislutími.** Við geymum bókunarupplýsingarnar þínar í 90 daga eftir heimsókn.
Eftir það er þeim eytt sjálfkrafa: nafn, símanúmer, netfang og óskir eða athugasemdir
eru fjarlægð og aðeins ópersónugreinanleg skráning (dagsetning, fjöldi gesta) stendur eftir.

**Réttindi þín.** Þú getur óskað eftir aðgangi að upplýsingunum, leiðréttingu eða
eyðingu þeirra og takmörkun vinnslu, eða andmælt vinnslu. Sendu póst á
kanel@kanel.is. Ef þú telur að við höfum ekki farið rétt með upplýsingarnar þínar
getur þú kvartað til Persónuverndar, www.personuvernd.is.

---

## Short line under the booking form (both languages)

- EN: *Your details are used only to handle this request. See our
  [booking privacy notice](/privacy/).*
- IS: *Upplýsingarnar eru eingöngu notaðar til að afgreiða þessa beiðni. Sjá
  [persónuverndarstefnu bókana](/is/personuvernd/).*
