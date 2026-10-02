#!/usr/bin/env python3
"""Builds is/index.html, the Icelandic homepage, from index.html.

    python3 tools/build_is.py        (then python3 tools/build_netlify_toml.py)

Every piece of visible text and every accessible label in index.html must have an Icelandic
translation in TEXT below, or be listed in KEEP (names that stay the same in both languages).
The build stops and lists the strings when English text would be left untranslated, or when a
translation is no longer used, so a copy change in index.html cannot silently leave the
Icelandic page out of date. Text that the page script writes comes from UI below (a JSON block
the shared script reads), so both pages run the identical script and share one CSP hash.
"""
import json, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent.parent
SRC, OUT = HERE / 'index.html', HERE / 'is' / 'index.html'

# English source text (exactly as in index.html, entities included) -> Icelandic.
TEXT = {
    # header and navigation
    'Skip to content': 'Fara beint í efni',
    'Alcedo — back to top': 'Alcedo — efst á síðu',
    'Primary': 'Aðalvalmynd',
    'Platform': 'Kerfið',
    'Training': 'Þjálfun',
    'Food Intelligence': 'Matvælagreind',
    'Alcedo Training': 'Alcedo-þjálfun',
    'Alcedo Training:': 'Alcedo-þjálfun:',
    'Staff login': 'Innskráning starfsfólks',
    'Request a demo': 'Bóka kynningu',
    'Menu': 'Valmynd',
    # hero
    'Hero visual placeholder': 'Staðgengill forsíðumyndar',
    'final frame unavailable': 'lokamynd ekki tiltæk',
    'Food &amp; beverage industry, all in one place': 'Veitingageirinn, allt á einum stað',
    'Your restaurant or bar.': 'Veitingastaðurinn eða barinn þinn.',
    'One': 'Eitt',
    'shared workspace.': 'sameiginlegt vinnusvæði.',
    'Alcedo brings daily operations, team knowledge, and intelligent assistance into a shared workspace.':
        'Alcedo sameinar daglegan rekstur, þekkingu teymisins og snjalla aðstoð á einu sameiginlegu vinnusvæði.',
    'Explore Alcedo': 'Kynntu þér Alcedo',
    'Alcedo at a glance': 'Alcedo í hnotskurn',
    'Frame': 'Rammi',
    '· Assistance': '· Aðstoð',
    'Meet your team’s assistant.': 'Kynntu þér aðstoðarmann teymisins.',
    'Available': 'Í boði',
    '· Ingredients': '· Hráefni',
    'Explore ingredients, recipes, and connected information.': 'Skoðaðu hráefni, uppskriftir og tengdar upplýsingar.',
    '· Learning': '· Fræðsla',
    'Discover learning and guidance for your team.': 'Fræðsla og leiðsögn fyrir teymið þitt.',
    'Alcedo · Platform preview': 'Alcedo · Kynning á kerfinu',
    'Built for restaurant and bar teams': 'Hannað fyrir teymi veitingastaða og bara',
    'Pause': 'Hlé',
    # discover
    '02 Field notes — Discover Alcedo': '02 Vettvangsnótur — Kynntu þér Alcedo',
    'Clear information.': 'Skýrar upplýsingar.',
    'A more prepared team.': 'Betur undirbúið teymi.',
    'Explore how Alcedo connects restaurant workflows, knowledge, and assistance. Discover the platform: what is available today and what is coming next.':
        'Sjáðu hvernig Alcedo tengir saman verkferla, þekkingu og aðstoð á veitingastaðnum. Kynntu þér kerfið: hvað er í boði í dag og hvað er væntanlegt.',
    'Status labels': 'Skýringar á stöðu',
    'In the Alcedo application today.': 'Í Alcedo-kerfinu í dag.',
    'Coming soon': 'Væntanlegt',
    'In development; not yet available.': 'Í þróun; ekki enn í boði.',
    'Operations': 'Rekstur',
    'Daily Operations': 'Daglegur rekstur',
    'The everyday modules of the current application, shared across the team. What each person sees follows their role.':
        'Dagleg verkfæri kerfisins, sameiginleg öllu teyminu. Það sem hver og einn sér fer eftir hlutverki viðkomandi.',
    'Inventory': 'Birgðir',
    'Items, locations and movements, with stock shown from verified counts.':
        'Vörur, staðsetningar og hreyfingar, þar sem birgðastaða byggir á staðfestum talningum.',
    'Purchasing': 'Innkaup',
    'Draft, approve and receive orders. Nothing is sent to suppliers automatically.':
        'Útbúðu, samþykktu og taktu á móti pöntunum. Ekkert er sent sjálfkrafa til birgja.',
    'Recipes': 'Uppskriftir',
    'A recipe library that shows what can be made from verified stock.':
        'Uppskriftasafn sem sýnir hvað hægt er að útbúa úr staðfestum birgðum.',
    'Stock Count': 'Vörutalning',
    'Phone-first counting, one item at a time. Stock changes after a manager verifies.':
        'Talning í símanum, ein vara í einu. Birgðir breytast þegar stjórnandi hefur staðfest.',
    'Shifts': 'Vaktir',
    'Plan and publish schedules; staff confirm shifts and request time off.':
        'Skipuleggðu og birtu vaktaplön; starfsfólk staðfestir vaktir og sækir um frí.',
    'Reports': 'Skýrslur',
    'Stock, purchasing, recipes, waste and labour. Sales data is not connected.':
        'Birgðir, innkaup, uppskriftir, rýrnun og launakostnaður. Sölugögn eru ekki tengd.',
    'Bookings': 'Borðapantanir',
    'Purchasing and Reports are for managers and administrators.': 'Innkaup og skýrslur eru fyrir stjórnendur og kerfisstjóra.',
    'Try it · tonight’s opening checklist': 'Prófaðu · opnunargátlisti kvöldsins',
    'Fridges checked': 'Kælar yfirfarnir',
    'Ice and garnish ready': 'Klaki og skraut tilbúið',
    'Back bar counted': 'Bakbar talinn',
    'Temperatures logged': 'Hitastig skráð',
    '2 of 4 done · opens at 17:00': '2 af 4 lokið · opnar kl. 17:00',
    'Assistance': 'Aðstoð',
    'Ask by text or voice, or add a photo or document. It answers from your venue’s records and prepares drafts — orders, counts, recipes — for a person to approve.':
        'Spyrðu með texta eða tali, eða bættu við mynd eða skjali. Aðstoðarmaðurinn svarar út frá gögnum staðarins og útbýr drög — pantanir, talningar, uppskriftir — sem manneskja samþykkir.',
    'Ways to ask': 'Leiðir til að spyrja',
    'Text': 'Texti',
    'Voice': 'Tal',
    'Photos &amp; files': 'Myndir og skrár',
    'Mascot demonstration · not connected to the assistant': 'Sýnishorn af lukkudýrinu · ekki tengt aðstoðarmanninum',
    'Say hello to Alcedo AI': 'Heilsaðu Alcedo AI',
    'Preview a mascot state': 'Sjá stöður lukkudýrsins',
    'Idle': 'Bíður',
    'Listening': 'Hlustar',
    'Thinking': 'Hugsar',
    'Ready to help': 'Tilbúinn að aðstoða',
    'Preparing a draft': 'Útbýr drög',
    'Ingredients': 'Hráefni',
    'A Flavor Map of ingredient pairings, each labelled with where it comes from, plus substitutes and ideas based on verified stock. Recipe drafts stay inactive until a manager approves them.':
        'Bragðkortið sýnir hvaða hráefni passa saman og hvaðan hver pörun kemur, auk staðgengla og hugmynda út frá staðfestum birgðum. Drög að uppskriftum eru óvirk þar til stjórnandi samþykkir þau.',
    'Flavor Map · illustration with sample data': 'Bragðkort · skýringarmynd með sýnigögnum',
    'Pairings for London dry gin': 'Paranir við London dry gin',
    'London dry gin and Lemon: culinary pairing, in stock': 'London dry gin og sítróna: þekkt pörun, til á lager',
    'Lemon': 'Sítróna',
    'London dry gin and Tonic water: culinary pairing, in stock': 'London dry gin og tónikvatn: þekkt pörun, til á lager',
    'Tonic': 'Tónik',
    'Tonic water': 'Tónikvatn',
    'London dry gin and Sweet vermouth: learned from your recipes, in stock': 'London dry gin og sætur vermút: lært af uppskriftunum þínum, til á lager',
    'Vermouth': 'Vermút',
    'Sweet vermouth': 'Sætur vermút',
    'London dry gin and Basil: culinary pairing, not in stock': 'London dry gin og basilíka: þekkt pörun, ekki til á lager',
    'Basil': 'Basilíka',
    'London dry gin and Honey: culinary pairing, stock unknown': 'London dry gin og hunang: þekkt pörun, lagerstaða óþekkt',
    'Honey': 'Hunang',
    'London dry gin and Mint: culinary pairing, in stock': 'London dry gin og minta: þekkt pörun, til á lager',
    'Mint': 'Minta',
    'London dry gin + Lemon': 'London dry gin + Sítróna',
    'Culinary pairing · in stock': 'Þekkt pörun · til á lager',
    'Culinary pairing': 'Þekkt pörun',
    'Learned from your recipes': 'Lært af uppskriftunum þínum',
    'in stock': 'til á lager',
    'not in stock': 'ekki til á lager',
    'stock unknown': 'lagerstaða óþekkt',
    'Stock key': 'Skýringar á lagerstöðu',
    'In stock': 'Til á lager',
    'Not in stock': 'Ekki til á lager',
    'Stock unknown': 'Lagerstaða óþekkt',
    'Learning': 'Fræðsla',
    'Training &amp; Knowledge': 'Þjálfun og þekking',
    'managers publish short video lessons with steps, aimed at the right roles; staff watch, resume and mark lessons complete.':
        'stjórnendur birta stutt kennslumyndbönd í skrefum fyrir rétt hlutverk; starfsfólk horfir, heldur áfram þar sem frá var horfið og merkir við þegar því er lokið.',
    'Knowledge:': 'Þekking:',
    'a searchable library with required reading.': 'leitarbært safn með skyldulesefni.',
    'Alcedo Training — available': 'Alcedo-þjálfun — í boði',
    'Knowledge library — available': 'Þekkingarsafn — í boði',
    'Try it · sample lesson': 'Prófaðu · sýniskennslustund',
    'Play the sample lesson': 'Spila sýniskennslustundina',
    'Stirred classics: Negroni': 'Hrærðir klassíkerar: Negroni',
    'Lesson progress': 'Framvinda kennslustundar',
    'Chill the glass': 'Kældu glasið',
    'Measure 30 / 30 / 30 ml': 'Mældu 30 / 30 / 30 ml',
    'Stir for 30 seconds': 'Hrærðu í 30 sekúndur',
    'Express the orange peel': 'Kreistu appelsínubörkinn',
    '4 steps · about 5 minutes': '4 skref · um 5 mínútur',
    # inside the workspace (tour)
    '03 Inside the workspace': '03 Inni í vinnusvæðinu',
    'See the modules': 'Sjáðu einingarnar',
    'as they are today.': 'eins og þær eru í dag.',
    'Screenshots from the Alcedo application running against built-in test data: every name, quantity and price is sample data, not a real venue’s records.':
        'Skjámyndir úr Alcedo-kerfinu með innbyggðum prófunargögnum: öll nöfn, magn og verð eru sýnigögn, ekki raunveruleg gögn neins staðar.',
    'Modules': 'Einingar',
    'Know what is on hand before service.': 'Vittu hvað er til áður en opnað er.',
    'Items by location, category and supplier': 'Vörur eftir staðsetningu, flokki og birgja',
    'Stock taken from the last verified count plus recorded movements': 'Birgðastaða út frá síðustu staðfestu talningu og skráðum hreyfingum',
    'Par levels flag what is low or out': 'Lágmarksbirgðir sýna hvað er að klárast eða búið',
    'Inventory table in the current application with eight sample bar items, their par levels and stock status.':
        'Birgðatafla í kerfinu með átta sýnivörum af bar, lágmarksbirgðum þeirra og lagerstöðu.',
    'Sample data': 'Sýnigögn',
    'Alcedo application · built-in test data': 'Alcedo-kerfið · innbyggð prófunargögn',
    'Orders that a person approves.': 'Pantanir sem manneskja samþykkir.',
    'Suggested orders from items below par': 'Tillögur að pöntunum fyrir vörur undir lágmarki',
    'Approve, mark as ordered and receive deliveries': 'Samþykktu, merktu sem pantað og taktu á móti sendingum',
    'Nothing is sent to a supplier automatically': 'Ekkert er sent sjálfkrafa til birgja',
    'Available · managers and administrators': 'Í boði · stjórnendur og kerfisstjórar',
    'Purchasing view with a suggested order and two sample orders, one waiting for approval.':
        'Innkaupayfirlit með tillögu að pöntun og tveimur sýnipöntunum; önnur bíður samþykkis.',
    'See what you can make tonight.': 'Sjáðu hvað þú getur útbúið í kvöld.',
    'Recipe library by category': 'Uppskriftasafn eftir flokkum',
    'Availability worked out from verified stock': 'Framboð reiknað út frá staðfestum birgðum',
    'Costs visible to managers only': 'Kostnaður aðeins sýnilegur stjórnendum',
    'Recipe cards for four sample drinks, showing which can be served from current stock.':
        'Uppskriftaspjöld fyrir fjóra sýnidrykki sem sýna hverja má bera fram úr núverandi birgðum.',
    'Stock count': 'Vörutalning',
    'Count on a phone, one item at a time.': 'Taldu í símanum, eina vöru í einu.',
    'Guided counts by area': 'Leiðbeind talning eftir svæðum',
    'Quick part-bottle entries': 'Fljótleg skráning á opnum flöskum',
    'Stock changes only after a manager verifies the count': 'Birgðir breytast aðeins þegar stjórnandi hefur staðfest talninguna',
    'A stock count in progress for a sample back bar, counting one item at a time.':
        'Vörutalning í gangi á sýnibar, ein vara talin í einu.',
    'A schedule everyone can see.': 'Vaktaplan sem allir sjá.',
    'Week and month planning, published when ready': 'Skipulag fyrir viku og mánuð, birt þegar það er tilbúið',
    'Staff confirm shifts, share availability and request time off': 'Starfsfólk staðfestir vaktir, gefur upp hvenær það getur unnið og sækir um frí',
    'Changes after publishing are highlighted': 'Breytingar eftir birtingu eru auðkenndar',
    'Weekly shift schedule with four fictional team members.': 'Vikulegt vaktaplan með fjórum skálduðum starfsmönnum.',
    'Sample data · fictional staff': 'Sýnigögn · skáldað starfsfólk',
    'A clear view of stock and spend.': 'Skýr yfirsýn yfir birgðir og útgjöld.',
    'Overview, stock, purchasing, recipes, waste and labour': 'Yfirlit, birgðir, innkaup, uppskriftir, rýrnun og launakostnaður',
    'Items that need attention': 'Atriði sem þarfnast athygli',
    'Sales are not connected (no point-of-sale link)': 'Sala er ekki tengd (engin tenging við afgreiðslukerfi)',
    'Reports overview with sample purchasing spend, recipe margin and items needing attention.':
        'Skýrsluyfirlit með sýnigögnum um innkaupakostnað, framlegð uppskrifta og atriði sem þarfnast athygli.',
    'Ask, check, then approve.': 'Spurðu, athugaðu og samþykktu svo.',
    'Text, voice, photos and documents': 'Texti, tal, myndir og skjöl',
    'Answers show the records they are based on': 'Svörin sýna gögnin sem þau byggja á',
    'Prepares drafts; a person approves every change': 'Útbýr drög; manneskja samþykkir hverja breytingu',
    'Scripted sample conversation in which the assistant checks Campari stock and prepares a draft order for approval.':
        'Sviðsett sýnisamtal þar sem aðstoðarmaðurinn athugar birgðir af Campari og útbýr drög að pöntun til samþykktar.',
    'Scripted demonstration · sample data': 'Sviðsett sýnidæmi · sýnigögn',
    'Pairings grounded in what you stock.': 'Paranir byggðar á því sem þú átt.',
    'Flavor Map of ingredient pairings with their sources': 'Bragðkort með hráefnapörunum og uppruna þeirra',
    'Substitutes and ideas from verified stock': 'Staðgenglar og hugmyndir út frá staðfestum birgðum',
    'Recipe drafts saved inactive until a manager approves': 'Drög að uppskriftum vistuð óvirk þar til stjórnandi samþykkir',
    'Flavor Map showing sample pairings for London dry gin and which ingredients are in stock.':
        'Bragðkort sem sýnir sýnipöranir fyrir London dry gin og hvaða hráefni eru til á lager.',
    'Short lessons for every role.': 'Stuttar kennslustundir fyrir hvert hlutverk.',
    'Video lessons with steps, aimed at roles': 'Kennslumyndbönd í skrefum, ætluð ákveðnum hlutverkum',
    'Staff resume and mark lessons complete': 'Starfsfólk heldur áfram þar sem frá var horfið og merkir við þegar því er lokið',
    'Managers see who has completed each version': 'Stjórnendur sjá hver hefur lokið hverri útgáfu',
    'Training library with four sample lessons.': 'Kennslusafn með fjórum sýniskennslustundum.',
    'Sample lessons': 'Sýniskennslustundir',
    # routes, contact and footer
    'Choose your route': 'Veldu þína leið',
    'For staff': 'Fyrir starfsfólk',
    'Get ready for your next shift.': 'Undirbúðu næstu vakt.',
    'Read how Alcedo supports daily work, training and team knowledge.': 'Lestu hvernig Alcedo styður við dagleg störf, þjálfun og þekkingu teymisins.',
    'Sign in to the existing application with your staff account.': 'Skráðu þig inn í kerfið með starfsmannaaðganginum þínum.',
    'Explore training': 'Skoða þjálfun',
    'Schedules, messages, training progress and manuals stay inside the signed-in application — never on this public site.':
        'Vaktaplön, skilaboð, framvinda í þjálfun og handbækur eru aðeins inni í kerfinu eftir innskráningu — aldrei á þessum opna vef.',
    'For restaurant owners': 'Fyrir eigendur veitingastaða',
    'See what Alcedo could run for you.': 'Sjáðu hvað Alcedo gæti séð um fyrir þig.',
    'Explore the modules and the status of each.': 'Skoðaðu einingarnar og stöðu hverrar þeirra.',
    'Request a demonstration with your team’s questions.': 'Bókaðu kynningu og taktu með spurningar teymisins.',
    'Explore modules': 'Skoða einingar',
    '04 Next step': '04 Næsta skref',
    'Explore what Alcedo could bring to': 'Sjáðu hvað Alcedo gæti gert fyrir',
    'your team.': 'teymið þitt.',
    'Tell us about your venue and we will arrange a walkthrough for your team. Write to':
        'Segðu okkur frá staðnum þínum og við skipuleggjum kynningu fyrir teymið. Skrifaðu á',
    'Staff access': 'Aðgangur starfsfólks',
    'Staff sign in to the Alcedo application with their existing account. This website does not handle accounts or passwords.':
        'Starfsfólk skráir sig inn í Alcedo-kerfið með núverandi aðgangi sínum. Þessi vefur meðhöndlar hvorki aðganga né lykilorð.',
    'Open the staff sign-in': 'Opna innskráningu starfsfólks',
    'Demo &amp; contact': 'Kynning og samband',
    'Email us with your venue and a time that suits you, and we will set up a walkthrough.':
        'Sendu okkur póst með nafni staðarins og tíma sem hentar þér og við setjum upp kynningu.',
    'Copy address': 'Afrita netfang',
    'A shared workspace for restaurant operations, team knowledge and intelligent assistance.':
        'Sameiginlegt vinnusvæði fyrir rekstur veitingastaða, þekkingu teymisins og snjalla aðstoð.',
    'Platform overview': 'Yfirlit yfir kerfið',
    'Inside the workspace': 'Inni í vinnusvæðinu',
    'Access and contact': 'Aðgangur og samband',
    'Access &amp; contact': 'Aðgangur og samband',
    'Privacy': 'Persónuvernd',
}

# Names and fixed lines that are the same in both languages.
KEEP = {
    'Alcedo', 'ALCEDO', 'Alcedo AI', 'London dry gin',
    'Alcedo@Alcedo.is', 'app.alcedo.is', 'alcedo.is', 'Persónuverndarstefna',
    'Privacy notice', 'In English',      # the footer link to the English privacy notice (lang="en")
    'EN', 'English',                     # the language switch back to the English page
    'Engar vafrakökur, engin rakning',   # written in Icelandic in RAW below
    '© 2026 Coffee &amp; Cocktails ehf. · kt. 671124-0220 · Geirsgata 17, 101 Reykjavík',
}

# Text the shared page script writes (read from the #ui-text JSON block; see UI_TEXT in index.html).
UI = {
    'pause': 'Hlé', 'play': 'Spila', 'replay': 'Spila aftur',
    'introPauseLabel': 'Gera hlé á upphafsmyndbandinu',
    'introResumeLabel': 'Halda áfram með upphafsmyndbandið',
    'introStartLabel': 'Spila upphafsmyndbandið frá byrjun',
    'introReplayLabel': 'Spila upphafsmyndbandið aftur',
    'mascotIdle': 'Tilbúinn að aðstoða', 'mascotListening': 'Hlustar…',
    'mascotThinking': 'Hugsar — útbýr drög sem þú samþykkir',
    'mascotHello': 'Halló! Ég er Alcedo AI.',
    'tourPlay': 'Spila', 'tourPlayLabel': 'Spila sjálfvirka yfirferð parana',
    'tourPauseLabel': 'Gera hlé á sjálfvirkri yfirferð parana',
    'copied': 'Afritað', 'copyAddress': 'Afrita netfang', 'copyFailed': 'Ekki tókst að afrita',
    'checklistDone': 'Allt klárt · tilbúið að opna',
    'checklistProgress': '{done} af {total} lokið · opnar kl. 17:00',
    'lessonDone': 'Kennslustund lokið · skráð sem lokið', 'lessonPlaying': 'Spilar…',
    'lessonReplayLabel': 'Spila sýniskennslustundina aftur',
    'lessonRestartLabel': 'Byrja sýniskennslustundina upp á nýtt',
}

# Whole-fragment changes made before translation (exact; each must match once).
RAW = [
    ('<html lang="en" class="no-js">', '<html lang="is" class="no-js">'),
    ('<title>Alcedo — Food &amp; beverage operations, all in one place</title>',
     '<title>Alcedo — Rekstur veitingastaða og bara á einum stað</title>'),
    ('<meta name="description" content="Alcedo brings daily operations, team knowledge, and intelligent assistance into a shared workspace for restaurants and bars.">',
     '<meta name="description" content="Alcedo sameinar daglegan rekstur, þekkingu teymisins og snjalla aðstoð á einu sameiginlegu vinnusvæði fyrir veitingastaði og bari.">'),
    ('<link rel="canonical" href="https://www.alcedo.is/">', '<link rel="canonical" href="https://www.alcedo.is/is/">'),
    ('<a class="lang-switch" href="is/" hreflang="is" lang="is" aria-label="Íslenska">IS</a>',
     '<a class="lang-switch" href="../" hreflang="en" lang="en" aria-label="English">EN</a>'),
    ('<li><a href="privacy.html">Privacy notice <small>No cookies, no tracking</small></a></li>\n'
     '          <li><a href="personuvernd.html" hreflang="is" lang="is">Persónuverndarstefna <small>Á íslensku</small></a></li>',
     '<li><a href="../personuvernd.html">Persónuverndarstefna <small>Engar vafrakökur, engin rakning</small></a></li>\n'
     '          <li><a href="../privacy.html" hreflang="en" lang="en">Privacy notice <small>In English</small></a></li>'),
]

OPAQUE = re.compile(r'(<!--.*?-->|<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>)', re.S)
TAG = re.compile(r'(<[^>]+>)')
ATTR = re.compile(r'\b(alt|aria-label|title|placeholder|data-tab|data-name|data-source|data-stock)="([^"]*)"')
LETTERS = re.compile('[A-Za-zÁÐÉÍÓÚÝÞÆÖáðéíóúýþæö]{2}')


def norm(s):
    return ' '.join(s.split())


def main():
    src = SRC.read_text(encoding='utf-8')
    html = src
    for a, b in RAW:
        if html.count(a) != 1:
            sys.exit(f'build_is: expected exactly one match for raw fragment: {a[:80]!r}')
        html = html.replace(a, b)

    head_end = html.index('<body')
    used, missing = set(), []

    def tr_text(t):
        k = norm(t)
        if not LETTERS.search(k):
            return t
        if k in TEXT:
            used.add(k)
            lead = t[:len(t) - len(t.lstrip())]
            trail = t[len(t.rstrip()):]
            return lead + TEXT[k] + trail
        if k not in KEEP:
            missing.append(k)
        return t

    def tr_attr(m):
        v = m.group(2)
        if not LETTERS.search(v) or v in KEEP:
            return m.group(0)
        if v in TEXT:
            used.add(v)
            return f'{m.group(1)}="{TEXT[v]}"'
        missing.append('@' + v)
        return m.group(0)

    out = []
    for part in OPAQUE.split(html[head_end:]):
        if OPAQUE.fullmatch(part or ''):
            out.append(part)
            continue
        for t in TAG.split(part):
            out.append(ATTR.sub(tr_attr, t) if t.startswith('<') else tr_text(t))
    html = html[:head_end] + ''.join(out)

    unused = sorted(set(TEXT) - used)
    if missing or unused:
        if missing:
            print('build_is: English text without a translation (add it to TEXT or KEEP):', *sorted(set(missing)), sep='\n  ')
        if unused:
            print('build_is: translations no longer used by index.html (remove them from TEXT):', *unused, sep='\n  ')
        sys.exit(1)

    # The page lives one folder down: shared files are one level up.
    html = html.replace('"assets/', '"../assets/')

    # Text the script writes, in a JSON data block just before the main script (not executed, so no CSP hash).
    main_script = '\n<script>\n(function () {'
    if html.count(main_script) != 1:
        sys.exit('build_is: main script not found')
    ui = json.dumps(UI, ensure_ascii=False, indent=1).replace('</', '<\\/')
    html = html.replace(main_script, f'\n<script type="application/json" id="ui-text">\n{ui}\n</script>{main_script}')

    # The shared script must be byte-identical, so both pages need only the one CSP hash.
    scripts = lambda h: re.findall(r'<script>(.*?)</script>', re.sub(r'<!--.*?-->', '', h, flags=re.S), flags=re.S)
    if scripts(html) != scripts(src):
        sys.exit('build_is: the page scripts differ from index.html')

    html = html.replace('<!doctype html>\n<!--', '<!doctype html>\n<!-- GENERATED by tools/build_is.py from index.html: edit index.html and the\n     translations in tools/build_is.py, then rebuild. Do not edit this file by hand. -->\n<!--', 1)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html, encoding='utf-8')
    print(f'{len(used)} translations, {len(UI)} script strings -> {OUT.relative_to(HERE)}')


if __name__ == '__main__':
    main()
