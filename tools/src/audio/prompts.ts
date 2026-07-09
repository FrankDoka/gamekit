import type { AudioKind, AudioPromptVariant } from "./types.js";

const mossgroveBgmVariants: AudioPromptVariant[] = [
  {
    slug: "cheerful-starter-field",
    label: "Cheerful starter field",
    prompt:
      "Bright anime fantasy MMORPG starter field loop, cheerful and welcoming, clear memorable woodwind and bell melody, warm strings, light hand percussion, soft bass movement, playful outdoor adventure energy, instrumental, loop-friendly, no vocals, no modern EDM drop, no dark cinematic tension.",
  },
  {
    slug: "forest-edge-morning",
    label: "Forest edge morning",
    prompt:
      "Breezy fantasy forest-edge field music for an early online RPG zone, gentle woodwinds, soft bells, warm strings, light natural percussion, green morning atmosphere, melodic and hopeful, instrumental, loop-friendly, no vocals, no modern EDM drop, no dark cinematic tension.",
  },
  {
    slug: "starter-zone-wonder",
    label: "Starter-zone wonder",
    prompt:
      "Hopeful beginner-area fantasy field loop for an anime MMORPG, safe and adventurous, sparkling mallets, flute lead, soft strings, gentle rhythm, light momentum, memorable melody, instrumental, seamless loop feel, no vocals, no modern EDM drop, no dark cinematic tension.",
  },
  {
    slug: "cute-creature-meadow",
    label: "Cute creature meadow",
    prompt:
      "Playful fantasy meadow music for cute early-game creatures, bright bells and pizzicato accents, friendly woodwind melody, warm strings, soft bouncing percussion, cheerful but not silly, instrumental, loop-friendly, no vocals, no modern EDM drop, no dark cinematic tension.",
  },
  {
    slug: "town-to-field-bridge",
    label: "Town-to-field bridge",
    prompt:
      "Cozy town outskirts to field music for a fantasy MMORPG, calm adventure mood, warm strings, gentle flute, bells, light percussion, safe but curious, clear melodic hook, instrumental, loop-friendly, no vocals, no modern EDM drop, no dark cinematic tension.",
  },
];

const crystalBloopSfxVariants: AudioPromptVariant[] = [
  {
    slug: "muted-rubbery-bloop",
    label: "Muted rubbery bloop",
    prompt:
      "Short soft rounded creature movement sound, gentle muted bloop with a warm rubbery pop, cute friendly early-game crystal creature, subtle and repeatable, low-pitched, under one second, no glass chime, no sharp sparkle, no voice, no music, no harsh impact.",
  },
  {
    slug: "soft-squish-hop",
    label: "Soft squish hop",
    prompt:
      "Short cute creature hop sound, soft squishy plop with a tiny rounded pop, warm and gentle, early-game fantasy monster movement, subtle enough to repeat often, under one second, no glass sound, no high-pitched sparkle, no voice, no music.",
  },
  {
    slug: "low-gel-step",
    label: "Low gel step",
    prompt:
      "Tiny low soft gel step for a cute crystal creature, rounded damp plop with a very soft tail, cozy and friendly, not wet or gross, subtle repeatable movement sound, under one second, no chime, no sparkle, no voice, no music.",
  },
  {
    slug: "light-sparkle-bloop",
    label: "Light sparkle bloop",
    prompt:
      "Short light sparkle bloop for a small crystal creature shifting position, soft liquid body with gentle magical twinkle, under one second, no voice, no music, not loud.",
  },
  {
    slug: "friendly-wobble",
    label: "Friendly wobble",
    prompt:
      "Short friendly wobble movement sound for a cute early-game crystal blob, soft squish and tiny chime, under one second, no voice, no music, subtle and repeatable.",
  },
];

const playerEnemyHitRegularVariants: AudioPromptVariant[] = [
  {
    slug: "classic-light-hit",
    label: "Classic light hit",
    prompt:
      "Short classic early online RPG attack hit sound, light weapon or magic impact on a small soft monster, quick punchy pop and thump, simple arcade feedback, clean and satisfying, no heavy bass, no explosion, no metal clang, no voice, no music, under one second.",
  },
  {
    slug: "soft-monster-bonk",
    label: "Soft monster bonk",
    prompt:
      "Short fantasy MMORPG normal hit sound, player attack connects with a small bouncy monster, soft bonk with a tiny slap and rounded pop, cute but clear combat feedback, nostalgic arcade RPG style, no sparkle, no explosion, no voice, no music, under one second.",
  },
  {
    slug: "snappy-arcade-impact",
    label: "Snappy arcade impact",
    prompt:
      "Short snappy RPG attack impact sound, quick dry slap and small thud on a soft creature, readable normal damage feedback, bright but not harsh, old-school online RPG feel, no metal weapon ring, no fire, no voice, no music, under one second.",
  },
  {
    slug: "clean-damage-pop",
    label: "Clean damage pop",
    prompt:
      "Short clean normal damage hit sound for a fantasy MMORPG, compact pop-thump impact, slightly rubbery monster body, simple satisfying feedback for repeated attacks, gentle high click but no harsh clipping, no explosion, no voice, no music, under one second.",
  },
];

const playerEnemyHitCriticalVariants: AudioPromptVariant[] = [
  {
    slug: "bright-clean-crit",
    label: "Bright clean crit",
    prompt:
      "Short fantasy MMORPG critical hit sound, stronger magical impact on a small monster, clean fire burst with a bright sparkle tail, satisfying critical strike, more powerful than normal hit, no harsh clipping, no metal clang, no explosion, no voice, no music, under one second.",
  },
  {
    slug: "sharp-magic-burst",
    label: "Sharp magic burst",
    prompt:
      "Short critical strike impact sound for a fantasy RPG, quick powerful magical burst with warm thump and clean high sparkle, exciting but not painful, stronger than a normal hit, no distortion, no metal, no voice, no music, under one second.",
  },
];

const crystalBloopAttackVariants: AudioPromptVariant[] = [
  {
    slug: "tiny-lunge-pop",
    label: "Tiny lunge pop",
    prompt:
      "Very short cute crystal creature attack sound, tiny rubbery lunge pop with a soft body snap, friendly early-game monster, quick and playful but clearly an attack, no voice, no music, no harsh chime, under half a second.",
  },
  {
    slug: "soft-bouncy-peck",
    label: "Soft bouncy peck",
    prompt:
      "Short cute monster attack sound, soft bouncy peck and rounded plop from a tiny crystal blob, gentle arcade fantasy feedback, not scary, not sharp, no voice, no music, under half a second.",
  },
];

const crystalBloopDamageVariants: AudioPromptVariant[] = [
  {
    slug: "small-squishy-hurt",
    label: "Small squishy hurt",
    prompt:
      "Short cute crystal creature damage sound, small soft squishy wobble hit with a muted pop, gentle hurt reaction, low and rounded, no voice, no music, no harsh sparkle, under half a second.",
  },
  {
    slug: "gentle-gel-bonk",
    label: "Gentle gel bonk",
    prompt:
      "Short monster damage reaction for a cute crystal blob, gentle gel bonk with a tiny soft bounce tail, clear hit feedback but not gross, no voice, no music, no glass chime, under half a second.",
  },
];

const crystalBloopDieVariants: AudioPromptVariant[] = [
  {
    slug: "soft-defeat-collapse",
    label: "Soft defeat collapse",
    prompt:
      "Short cute crystal creature defeat sound, soft gelatinous collapse with a tiny magical poof, gentle and satisfying, early-game monster disappears, no voice, no music, no harsh shatter, under one second.",
  },
  {
    slug: "bloop-poof-fade",
    label: "Bloop poof fade",
    prompt:
      "Short fantasy monster defeat sound for a cute crystal blob, rounded bloop followed by a soft airy poof and tiny sparkle fade, clean and friendly, no scream, no voice, no music, no glass breaking, under one second.",
  },
];

// Approved 10-item Zone-1 batch (card-audio-z1.md Phase 2, owner cap $0.05,
// 2 candidates per item). One SHARED slime-squish family for all four Bloomvale
// slimes — per-species pitch variation happens in the client audio config, not
// here. Organic cute meadow slimes, NOT the crystal_bloop glass aesthetic.
const slimeSquishAttackVariants: AudioPromptVariant[] = [
  {
    slug: "squish-lunge-splat",
    label: "Squish lunge splat",
    prompt:
      "Short cute slime monster attack sound, quick squishy lunge with a soft rounded splat on impact, playful early-game fantasy creature, bouncy jelly body, clear but gentle, no glass, no chime, no voice, no music, under one second.",
  },
  {
    slug: "bouncy-jelly-strike",
    label: "Bouncy jelly strike",
    prompt:
      "Short bouncy jelly strike for a small friendly meadow slime attacking, soft elastic stretch then a quick plop hit, cute and cartoonish, not gross, no sparkle, no voice, no music, under one second.",
  },
];

const slimeSquishDamageVariants: AudioPromptVariant[] = [
  {
    slug: "dented-jelly-wobble",
    label: "Dented jelly wobble",
    prompt:
      "Short cute slime taking a hit, soft dented squish with a small wobbly jiggle recoil, rounded rubbery body, sympathetic but light, no scream, no voice, no music, no glass, under half a second.",
  },
  {
    slug: "soft-squash-rebound",
    label: "Soft squash rebound",
    prompt:
      "Tiny soft squash impact on a gel creature, quick compressed squish with a muted rebound, cute early-game monster damage feedback, subtle and repeatable, no voice, no music, no sharp crack, under half a second.",
  },
];

const slimeSquishDieVariants: AudioPromptVariant[] = [
  {
    slug: "deflating-squelch-plop",
    label: "Deflating squelch plop",
    prompt:
      "Short cute slime defeat sound, soft deflating squelch losing its bounce then a gentle final plop, friendly cartoon fantasy creature, a little comedic, not gross or violent, no scream, no voice, no music, about one second.",
  },
  {
    slug: "wobble-collapse-poof",
    label: "Wobble collapse poof",
    prompt:
      "Cute jelly monster collapse, brief wobble losing energy, soft squishy slump and a tiny airy poof at the end, gentle and friendly defeat, no glass break, no voice, no music, about one second.",
  },
];

const slimeSquishMoveVariants: AudioPromptVariant[] = [
  {
    slug: "tiny-hop-plop",
    label: "Tiny hop plop",
    prompt:
      "Tiny cute slime hop, single soft squishy plop as a small jelly creature lands, very subtle and repeatable movement sound, warm rounded low tone, no chime, no sparkle, no voice, no music, under half a second.",
  },
  {
    slug: "soft-gel-scoot",
    label: "Soft gel scoot",
    prompt:
      "Very short soft gel scoot for a cute meadow slime shifting forward, gentle squish with no tail, quiet and repeatable, cozy fantasy game, no voice, no music, no wet gross texture, under half a second.",
  },
];

const playerAttackSwingVariants: AudioPromptVariant[] = [
  {
    slug: "light-blade-whoosh",
    label: "Light blade whoosh",
    prompt:
      "Short light sword swing whoosh for an anime fantasy MMORPG player attack, quick clean air cut, no impact, no metal clang, bright and snappy, no voice, no music, under half a second.",
  },
  {
    slug: "swift-arc-swipe",
    label: "Swift arc swipe",
    prompt:
      "Quick swift weapon arc swipe through air, small hero character attack sound, crisp soft whoosh with a slight rising sweep, no hit sound, no voice, no music, under half a second.",
  },
];

const itemPickupVariants: AudioPromptVariant[] = [
  {
    slug: "pop-bell-confirm",
    label: "Pop bell confirm",
    prompt:
      "Short cheerful item pickup sound for a cozy fantasy MMORPG, soft pop with a tiny bright bell confirm, satisfying and repeatable, classic RPG loot feedback, no voice, no music, under half a second.",
  },
  {
    slug: "soft-scoop-chime",
    label: "Soft scoop chime",
    prompt:
      "Tiny soft scoop-up sound with a gentle single chime tail, picking up a small item in a cute online RPG, warm and rewarding but subtle, no voice, no music, under half a second.",
  },
];

const portalEnterVariants: AudioPromptVariant[] = [
  {
    slug: "gentle-warp-shimmer",
    label: "Gentle warp shimmer",
    prompt:
      "Fantasy portal entry sound, gentle magical whoosh folding into a soft sparkling shimmer, cozy anime MMORPG zone transition, welcoming not ominous, smooth fade, no voice, no music, about one second.",
  },
  {
    slug: "swirl-step-through",
    label: "Swirl step through",
    prompt:
      "Soft magical swirl as a character steps through a glowing portal, airy rising sweep with light twinkles and a rounded low pulse, friendly fantasy travel sound, no voice, no music, about one second.",
  },
];

const levelUpVariants: AudioPromptVariant[] = [
  {
    slug: "ascending-sparkle-fanfare",
    label: "Ascending sparkle fanfare",
    prompt:
      "Bright level-up jingle for a cheerful anime fantasy MMORPG, quick ascending sparkle arpeggio with bells and a warm final chime, triumphant but cute, short and non-vocal, no drums, no modern EDM, under two seconds.",
  },
  {
    slug: "radiant-chime-rise",
    label: "Radiant chime rise",
    prompt:
      "Short radiant achievement rise, glowing mallet and bell notes climbing to a soft satisfying peak with a light shimmer tail, classic RPG level-up feel, hopeful and clean, no voice, no full song, under two seconds.",
  },
];

const uiClickVariants: AudioPromptVariant[] = [
  {
    slug: "soft-tap-blip",
    label: "Soft tap blip",
    prompt:
      "Very short soft UI click for a cozy fantasy game menu, gentle rounded tap blip, clean and unobtrusive, pleasant to hear repeatedly, no chime tail, no voice, no music, about a quarter second.",
  },
  {
    slug: "muted-wood-tick",
    label: "Muted wood tick",
    prompt:
      "Tiny muted wooden tick click for game interface buttons, warm natural material tap, subtle and satisfying, extremely short, no reverb, no voice, no music, about a quarter second.",
  },
];

const deathStingVariants: AudioPromptVariant[] = [
  {
    slug: "soft-somber-descend",
    label: "Soft somber descend",
    prompt:
      "Short somber player defeat sting for a gentle fantasy MMORPG, soft descending strings and a low warm bell, melancholy but not scary or dramatic, kind-hearted game over feel, no voice, no percussion, about two seconds.",
  },
  {
    slug: "fading-light-motif",
    label: "Fading light motif",
    prompt:
      "Brief fading-light defeat motif, three gentle descending notes on soft flute and bells with a quiet dissolving tail, wistful cozy RPG death sound, hopeful undertone, no voice, no heavy drama, about two seconds.",
  },
];

// card-audio-ui-sfx.md — cozy UI sound pack (owner-driven, 2026-07-05). One
// family: soft wood / parchment / felt / leather materials, warm bells/mallets/
// harp/kalimba for positive moments, nothing harsh or metallic, no glass, no
// digital beep. Loudness scales by role — ticks/hovers whisper-quiet, jingles
// fuller but never loud. `ui/click` is intentionally omitted (already promoted
// as sfx.ui.click from the z1 batch). 3 candidates each (owner cap $0.12).
const uiHoverVariants: AudioPromptVariant[] = [
  {
    slug: "felt-hover-tick",
    label: "Felt hover tick",
    prompt:
      "Extremely quiet soft UI hover tick for a cozy fantasy menu, tiny rounded felt tap, barely-there and airy, pleasant when repeated fast, no chime tail, no metal, no digital beep, no voice, no music, about a fifth of a second.",
  },
  {
    slug: "muted-wood-hover",
    label: "Muted wood hover",
    prompt:
      "Very soft muted hover blip for a wooden game interface, faint warm wood touch, subtle and unobtrusive, gentle enough to hear many times a second, no reverb, no sparkle, no voice, no music, under a quarter second.",
  },
  {
    slug: "paper-brush-hover",
    label: "Paper brush hover",
    prompt:
      "Tiny gentle paper-brush hover tick, soft parchment feather-touch as a cursor passes a button, whisper-quiet and rounded, no click snap, no metal, no voice, no music, about a fifth of a second.",
  },
];

const uiWindowOpenVariants: AudioPromptVariant[] = [
  {
    slug: "wooden-drawer-open",
    label: "Wooden drawer open",
    prompt:
      "Soft cozy panel open sound for a fantasy game menu, gentle wooden slide with a warm low woosh and a soft settle, like a smooth drawer easing open, natural and pleasant, no metal, no glass, no digital sweep, no voice, no music, about half a second.",
  },
  {
    slug: "parchment-unfold-open",
    label: "Parchment unfold open",
    prompt:
      "Warm parchment-and-wood window opening sound, light paper rustle over a soft wooden glide, unfolding a cozy interface panel, gentle upward motion, no harsh swish, no metal, no voice, no music, about half a second.",
  },
  {
    slug: "felt-box-open",
    label: "Felt box open",
    prompt:
      "Gentle felt-lined box opening for a game UI, muffled woody slide with a soft cushioned stop, inviting and quiet, no click, no metal, no glass, no voice, no music, about half a second.",
  },
];

const uiWindowCloseVariants: AudioPromptVariant[] = [
  {
    slug: "wooden-drawer-close",
    label: "Wooden drawer close",
    prompt:
      "Soft cozy panel close sound for a fantasy game menu, gentle wooden slide easing shut with a soft low thud, warm and rounded, like a drawer pushed closed, no metal, no glass, no voice, no music, about half a second.",
  },
  {
    slug: "parchment-fold-close",
    label: "Parchment fold close",
    prompt:
      "Warm wood-and-parchment window closing sound, light paper settle over a soft wooden glide down, folding a cozy panel away, gentle and final but not harsh, no slam, no metal, no voice, no music, about half a second.",
  },
  {
    slug: "felt-box-close",
    label: "Felt box close",
    prompt:
      "Muffled felt-lined box closing for a game UI, soft cushioned wooden shut with a quiet low tail, calm and tidy, no click snap, no metal, no glass, no voice, no music, about half a second.",
  },
];

const uiTabSwitchVariants: AudioPromptVariant[] = [
  {
    slug: "card-flip-tick",
    label: "Card flip tick",
    prompt:
      "Short soft tab switch tick for a cozy fantasy interface, gentle woody flip with a light paper flick, quick and pleasant, like turning a card, no metal, no digital beep, no voice, no music, under half a second.",
  },
  {
    slug: "parchment-tab-flick",
    label: "Parchment tab flick",
    prompt:
      "Quick warm page-tab change sound, soft parchment flip and a rounded wooden tap, snappy but gentle, cozy game menu feel, no sparkle, no metal, no voice, no music, under half a second.",
  },
  {
    slug: "felt-toggle-tick",
    label: "Felt toggle tick",
    prompt:
      "Tiny soft toggle tick for switching UI tabs, muted felt-and-wood flick, clean and unobtrusive, comfortable when clicked often, no chime, no metal, no voice, no music, about a third of a second.",
  },
];

const uiTooltipVariants: AudioPromptVariant[] = [
  {
    slug: "soft-bubble-pop",
    label: "Soft bubble pop",
    prompt:
      "Barely-there tooltip pop for a cozy fantasy UI, tiny soft rounded blip as a little hint bubble appears, whisper-quiet and warm, no chime tail, no metal, no digital beep, no voice, no music, about a fifth of a second.",
  },
  {
    slug: "parchment-puff",
    label: "Parchment puff",
    prompt:
      "Very soft parchment tooltip appear sound, faint paper puff as a small info note pops up, gentle and subtle, easy to ignore, no click, no sparkle, no voice, no music, under a quarter second.",
  },
  {
    slug: "felt-pop-tiny",
    label: "Tiny felt pop",
    prompt:
      "Tiny warm felt pop for a UI tooltip, soft muffled bubble with no tail, extremely light and pleasant, no metal, no glass, no voice, no music, about a fifth of a second.",
  },
];

const uiEquipVariants: AudioPromptVariant[] = [
  {
    slug: "leather-buckle-thunk",
    label: "Leather buckle thunk",
    prompt:
      "Soft leather equip sound for a fantasy RPG, warm padded thunk of gear settling into place, like a leather strap buckling snugly, satisfying and rounded, no metal clank, no glass, no voice, no music, under half a second.",
  },
  {
    slug: "cloth-leather-thud",
    label: "Cloth leather thud",
    prompt:
      "Cozy gear-equip sound, muffled leather-and-cloth thud with a soft creak, fitting an item onto a character, warm and tactile, no metal ring, no sparkle, no voice, no music, about half a second.",
  },
  {
    slug: "padded-press-settle",
    label: "Padded press settle",
    prompt:
      "Gentle equip thunk for a game inventory, soft padded leather press with a quiet settle, reassuring and warm, not harsh, no metal, no glass, no voice, no music, under half a second.",
  },
];

const uiUnequipVariants: AudioPromptVariant[] = [
  {
    slug: "leather-slip-off",
    label: "Leather slip off",
    prompt:
      "Soft unequip sound for a fantasy RPG, light leather-and-cloth slip as gear comes loose, gentle padded shuffle with a soft release, warm and quiet, no metal clank, no voice, no music, under half a second.",
  },
  {
    slug: "cloth-whisk-remove",
    label: "Cloth whisk remove",
    prompt:
      "Cozy gear-removal sound, muffled leather unbuckle and a soft cloth whisk, taking an item off a character, light and tactile, no metal ring, no sparkle, no voice, no music, about half a second.",
  },
  {
    slug: "padded-lift-off",
    label: "Padded lift off",
    prompt:
      "Gentle unequip shuffle for a game inventory, soft padded leather lift with a quiet slide-off, unobtrusive and warm, no harsh snap, no metal, no voice, no music, under half a second.",
  },
];

const uiCoinVariants: AudioPromptVariant[] = [
  {
    slug: "warm-coin-tumble",
    label: "Warm coin tumble",
    prompt:
      "Cheerful soft coin sound for a cozy fantasy game, a small handful of gold coins tumbling with a warm rounded jingle, satisfying reward for a purchase, muted and pleasant not bright metallic, no voice, no music, about half a second.",
  },
  {
    slug: "coin-bell-confirm",
    label: "Coin bell confirm",
    prompt:
      "Warm gentle gold-gain sound, soft muffled coin clink and a tiny bright bell confirm, cozy RPG purchase or reward, rounded and inviting not harsh, no cash-register, no voice, no music, under one second.",
  },
  {
    slug: "coin-pouch-jingle",
    label: "Coin pouch jingle",
    prompt:
      "Soft pouch-of-coins sound for a game shop, light padded jingle of gold with a mellow settle, comfortable and rewarding, warm not sharp metal, no voice, no music, about half a second.",
  },
];

const uiBuyFailVariants: AudioPromptVariant[] = [
  {
    slug: "soft-wood-nope",
    label: "Soft wood nope",
    prompt:
      "Soft gentle error thunk for a cozy fantasy UI, a low muted wooden bump with a slightly downward tone, politely says no without scolding, warm and quiet, no harsh buzzer, no metal, no voice, no music, under half a second.",
  },
  {
    slug: "gentle-double-tap-deny",
    label: "Gentle double-tap deny",
    prompt:
      "Kind soft denial sound for a game menu, small muffled double wood-tap descending a touch, gentle can't-afford feedback, not punishing or jarring, no harsh beep, no metal, no voice, no music, under half a second.",
  },
  {
    slug: "felt-falling-wobble",
    label: "Felt falling wobble",
    prompt:
      "Warm low soft nope sound, rounded felt thud with a gentle falling wobble, cozy game error that stays friendly, no buzzer, no metal, no voice, no music, about half a second.",
  },
];

const uiQuestAcceptVariants: AudioPromptVariant[] = [
  {
    slug: "rising-mallet-glow",
    label: "Rising mallet glow",
    prompt:
      "Short warm quest-accepted chime for a cozy fantasy MMORPG, two or three gentle rising mallet notes with a soft bell glow, hopeful and encouraging, brief and clean, no drums, no voice, no full song, about one second.",
  },
  {
    slug: "harp-bell-welcome",
    label: "Harp bell welcome",
    prompt:
      "Soft welcoming quest-start jingle, a small upward harp-and-bell phrase with a warm settle, cozy adventure begins, gentle and bright not loud, no percussion, no voice, no full song, about one second.",
  },
  {
    slug: "kalimba-spark-rise",
    label: "Kalimba spark rise",
    prompt:
      "Gentle affirming chime for accepting a quest, a short rounded kalimba rise with a light shimmer, friendly and warm, gives a little spark of purpose, no drums, no voice, no music bed, about one second.",
  },
];

const uiQuestCompleteVariants: AudioPromptVariant[] = [
  {
    slug: "resolved-chord-close",
    label: "Resolved chord close",
    prompt:
      "Warm satisfying quest-complete jingle for a cozy fantasy RPG, a short resolved phrase of soft bells and mallets landing on a comfortable major chord, a sense of accomplishment and closure, gentle glow tail, no big drums, no voice, under two seconds.",
  },
  {
    slug: "harp-climb-resolve",
    label: "Harp climb resolve",
    prompt:
      "Rewarding quest turn-in resolve, a small climbing harp-and-bell melody arriving on a warm final chime, cozy triumphant but not grand, satisfying completion, light shimmer fade, no percussion, no voice, under two seconds.",
  },
  {
    slug: "mallet-payoff-warm",
    label: "Mallet payoff warm",
    prompt:
      "Gentle fulfilling quest-done fanfare, soft rounded mallet notes resolving with a warm low bell and a mellow sparkle, heartwarming payoff, calm and pleasant, no heavy drums, no voice, under two seconds.",
  },
];

const uiLevelUpVariants: AudioPromptVariant[] = [
  {
    slug: "ascending-sparkle-peak",
    label: "Ascending sparkle peak",
    prompt:
      "Bright joyful level-up jingle for a cheerful anime fantasy MMORPG, a quick ascending sparkle of bells and mallets climbing to a warm triumphant final chime with a glowing shimmer tail, celebratory and cute, clean and non-vocal, no heavy drums, no modern EDM, about two seconds.",
  },
  {
    slug: "radiant-harp-run",
    label: "Radiant harp run",
    prompt:
      "Uplifting radiant level-up fanfare, glowing harp and glockenspiel notes rising in a happy little run to a satisfying resolved peak, hopeful and rewarding, cozy RPG celebration, light airy sparkle at the end, no voice, no full song, about two seconds.",
  },
  {
    slug: "warm-bell-arpeggio",
    label: "Warm bell arpeggio",
    prompt:
      "Celebratory soft-magical level-up phrase, a rounded arpeggio of warm bells lifting up with a gentle whoosh of shimmer and a bright confident finish, cheerful growth moment, not harsh or loud, no drums, no voice, about two seconds.",
  },
];

const uiJobUpVariants: AudioPromptVariant[] = [
  {
    slug: "grand-milestone-chord",
    label: "Grand milestone chord",
    prompt:
      "Grand warm job-advancement jingle for a cozy fantasy MMORPG, a fuller ascending melody of bells, mallets and soft harp resolving on a proud shining chord with a longer glow, a bigger milestone than a normal level-up, dignified but still cheerful, no heavy drums, no voice, about two seconds.",
  },
  {
    slug: "deep-resonant-classup",
    label: "Deep resonant class-up",
    prompt:
      "Prestigious soft-magical class-up fanfare, glowing rising notes with a deeper warm resonance underneath arriving at a triumphant radiant chime, sense of a major career milestone, cozy and hopeful, light shimmer tail, no percussion, no voice, about two seconds.",
  },
  {
    slug: "ceremonial-harp-swell",
    label: "Ceremonial harp swell",
    prompt:
      "Elevated job-up celebration phrase, a rounded climbing run of bells and harp over a gentle warm swell, landing on a bright proud resolve with a soft sparkle, more ceremonial than a level-up, cheerful not loud, no drums, no voice, about two seconds.",
  },
];

const uiToastVariants: AudioPromptVariant[] = [
  {
    slug: "bubble-bell-tick",
    label: "Bubble bell tick",
    prompt:
      "Short soft toast notification pop for a cozy fantasy UI, a gentle rounded bubble-up with a tiny bright bell tick, a little card sliding in with news, pleasant and quick, no harsh beep, no voice, no music, under half a second.",
  },
  {
    slug: "muffled-chime-pop",
    label: "Muffled chime pop",
    prompt:
      "Warm gentle system-toast sound, soft muffled pop and a light single chime as a small notification appears, cozy and friendly, not intrusive, no metal, no voice, no music, about half a second.",
  },
  {
    slug: "paper-bell-loot",
    label: "Paper bell loot",
    prompt:
      "Tiny cheerful loot-toast blip, soft paper-and-bell pop announcing a small reward, rounded and warm, quick and light, no sparkle harshness, no voice, no music, under half a second.",
  },
];

const uiHintVariants: AudioPromptVariant[] = [
  {
    slug: "soft-shimmer-rise",
    label: "Soft shimmer rise",
    prompt:
      "Very soft hint appear sound for a cozy fantasy game, a gentle rounded rise with a faint warm shimmer as a tip fades in, quieter and airier than a notification, calm and unobtrusive, no bell tick, no voice, no music, about half a second.",
  },
  {
    slug: "breathy-glow-nudge",
    label: "Breathy glow nudge",
    prompt:
      "Gentle low hint whisper for a UI, a soft breathy swell with a tiny mellow glow, a subtle nudge appearing on screen, warmer and softer than a toast pop, no click, no metal, no voice, no music, about half a second.",
  },
  {
    slug: "kalimba-cushion-fade",
    label: "Kalimba cushion fade",
    prompt:
      "Quiet warm hint fade-in sound, a rounded soft cushion of air with a faint kalimba touch, barely drawing attention, cozy and mellow, no sharp pop, no voice, no music, about half a second.",
  },
];

const uiDragPickVariants: AudioPromptVariant[] = [
  {
    slug: "cloth-wood-lift",
    label: "Cloth wood lift",
    prompt:
      "Short soft pick-up sound for dragging a game inventory item, a gentle padded lift with a tiny cloth-and-wood tick as it detaches, light and tactile, no metal, no sparkle, no voice, no music, under half a second.",
  },
  {
    slug: "felt-pluck-up",
    label: "Felt pluck up",
    prompt:
      "Soft grab-and-lift tick for a UI drag start, muffled felt pluck as an icon comes up off the grid, warm and quick, cozy inventory feel, no click snap, no metal, no voice, no music, about a third of a second.",
  },
  {
    slug: "paper-lift-pop",
    label: "Paper lift pop",
    prompt:
      "Gentle drag-begin sound, a soft rounded pop of an item lifting from a slot with a faint paper rustle, tactile and light, no harsh tick, no metal, no voice, no music, under half a second.",
  },
];

const uiDragDropVariants: AudioPromptVariant[] = [
  {
    slug: "padded-slot-thunk",
    label: "Padded slot thunk",
    prompt:
      "Short satisfying drop-and-set sound for a game inventory, a soft padded thunk as an item settles into a slot with a tiny warm confirm tick, tactile and reassuring, no metal clank, no voice, no music, under half a second.",
  },
  {
    slug: "wood-felt-lock",
    label: "Wood felt lock",
    prompt:
      "Soft bind-confirm drop for a UI, muffled wood-and-felt press as an icon locks into place with a gentle rounded click, cozy and definite, no harsh snap, no metal, no voice, no music, about half a second.",
  },
  {
    slug: "cushion-bell-set",
    label: "Cushion bell set",
    prompt:
      "Gentle place-into-slot sound, a soft cushioned set-down with a light bell-tick confirm, comfortable and clear that it worked, warm not sharp, no metal, no voice, no music, under half a second.",
  },
];

const uiMapOpenVariants: AudioPromptVariant[] = [
  {
    slug: "parchment-spread",
    label: "Parchment spread",
    prompt:
      "Cozy world-map open sound for a fantasy game, a soft parchment unfolding with a warm papery crinkle and a gentle settle, like spreading an old map on a table, natural and pleasant, no metal, no digital sweep, no voice, no music, about one second.",
  },
  {
    slug: "leather-roll-unfurl",
    label: "Leather roll unfurl",
    prompt:
      "Warm map unfurl sound, a soft leathery roll opening into a light paper rustle with a mellow low woosh, cozy adventurer's map reveal, gentle and inviting, no harsh swish, no voice, no music, about one second.",
  },
  {
    slug: "two-stage-paper-open",
    label: "Two-stage paper open",
    prompt:
      "Gentle parchment map-open sound, soft crisp paper unfolding in two light stages with a warm settle, tactile and old-world, no sparkle, no metal, no voice, no music, about one second.",
  },
];

const uiPortalVariants: AudioPromptVariant[] = [
  {
    slug: "airy-shimmer-fold",
    label: "Airy shimmer fold",
    prompt:
      "Soft magical portal transition swoosh for a cozy anime MMORPG, a gentle airy whoosh folding into a light sparkling shimmer, warm and welcoming zone change, smooth fade not ominous, no voice, no music, about one second.",
  },
  {
    slug: "warp-sweep-twinkle",
    label: "Warp sweep twinkle",
    prompt:
      "Gentle warp-travel sound, a soft rising sweep of air with mellow twinkles and a rounded low pulse as a character steps through a glowing gateway, friendly and dreamy, no harsh whoosh, no voice, no music, about one second.",
  },
  {
    slug: "cushiony-portal-bloom",
    label: "Cushiony portal bloom",
    prompt:
      "Warm soft portal shimmer, a light magical woosh blooming into a brief cushiony sparkle and a gentle settle, cozy fantasy transition, smooth and inviting, no metal, no voice, no music, about one second.",
  },
];

// card-audio-z1-expansion.md — Zone-1 expansion SFX. Keep event cues short,
// readable, and conservative; ambience uses the SFX route as loopable beds.
const stageEnterVariants: AudioPromptVariant[] = [
  {
    slug: "ready-bell-rise",
    label: "Ready bell rise",
    prompt:
      "Short cozy fantasy stage-entry cue, soft bell and mallet rise with a gentle breath of air, signals a small combat trial beginning, encouraging but not loud, no voice, no full music, about one second.",
  },
  {
    slug: "soft-trial-open",
    label: "Soft trial open",
    prompt:
      "Brief fantasy trial-start sound, warm wooden thump and upward shimmer opening into action, clean and readable, not dramatic, no metal clash, no voice, no music bed, about one second.",
  },
];

const stageClearVariants: AudioPromptVariant[] = [
  {
    slug: "small-victory-fanfare",
    label: "Small victory fanfare",
    prompt:
      "Short stage-clear fanfare for a cozy anime fantasy MMORPG, bright bells and mallets resolving in a warm little victory phrase, celebratory but compact, no voice, no big drums, about two seconds.",
  },
  {
    slug: "resolved-clear-chime",
    label: "Resolved clear chime",
    prompt:
      "Gentle instance clear jingle, uplifting harp and bell notes landing on a satisfying soft chord, friendly accomplishment feel, no harsh sparkle, no voice, no full song, about two seconds.",
  },
];

const stageFailVariants: AudioPromptVariant[] = [
  {
    slug: "kind-failure-descend",
    label: "Kind failure descend",
    prompt:
      "Short stage-failed cue for a gentle fantasy RPG, soft descending mallet notes and a warm low bell, disappointed but kind, not scary, no buzzer, no voice, about one and a half seconds.",
  },
  {
    slug: "soft-retreat-sting",
    label: "Soft retreat sting",
    prompt:
      "Brief failed-trial sting, muted wood and bell phrase falling softly with a small airy tail, calm retry-friendly tone, no harsh error, no voice, no music bed, about one and a half seconds.",
  },
];

const bossTelegraphVariants: AudioPromptVariant[] = [
  {
    slug: "low-warning-bloom",
    label: "Low warning bloom",
    prompt:
      "Short boss telegraph warning sound, low soft magical pulse blooming into a restrained shimmer, readable danger cue without jump scare, no explosion, no voice, no music, about one second.",
  },
  {
    slug: "ominous-soft-pulse",
    label: "Ominous soft pulse",
    prompt:
      "Compact fantasy boss warning cue, warm low thrum with a gentle rising sparkle tension, clear anticipation, not harsh or cinematic, no voice, no music, about one second.",
  },
];

const bossDeathVariants: AudioPromptVariant[] = [
  {
    slug: "boss-poof-collapse",
    label: "Boss poof collapse",
    prompt:
      "Short cute fantasy boss defeat sound, fuller magical collapse with a soft airy poof and warm sparkle fade, satisfying but not huge, no scream, no glass shatter, no voice, about two seconds.",
  },
  {
    slug: "heavy-slime-dissolve",
    label: "Heavy slime dissolve",
    prompt:
      "Brief boss monster death cue, rounded heavy gel slump dissolving into a clean magical twinkle tail, friendly early-game fantasy, not gross, no voice, no music, about two seconds.",
  },
];

const eventStartVariants: AudioPromptVariant[] = [
  {
    slug: "public-event-rise",
    label: "Public event rise",
    prompt:
      "Short event-start chime for a cozy online RPG, friendly rising bells and soft wooden tick, announces a timed world event without urgency panic, no voice, no full music, about one second.",
  },
  {
    slug: "gentle-gather-call",
    label: "Gentle gather call",
    prompt:
      "Brief warm call-to-event sound, harp pluck and mellow bell lift, inviting players to join something nearby, calm but noticeable, no voice, no music bed, about one second.",
  },
];

const eventEndVariants: AudioPromptVariant[] = [
  {
    slug: "event-settle-chime",
    label: "Event settle chime",
    prompt:
      "Short event-end chime for a cozy fantasy UI, soft resolved bell notes and a tiny parchment settle, says the activity has ended, warm and unobtrusive, no voice, about one second.",
  },
  {
    slug: "closing-mallet-glow",
    label: "Closing mallet glow",
    prompt:
      "Brief closing chime, rounded mallets and low warm bell resolving gently, friendly event complete or expired feedback, not triumphant, no voice, no music bed, about one second.",
  },
];

const enhancementSuccessVariants: AudioPromptVariant[] = [
  {
    slug: "polished-clink-glow",
    label: "Polished clink glow",
    prompt:
      "Short enhancement success sound, polished warm metal clink with a soft magical glow tail, satisfying item upgrade feedback, bright but not sharp, no glass, no voice, about one second.",
  },
  {
    slug: "craft-spark-confirm",
    label: "Craft spark confirm",
    prompt:
      "Brief fantasy upgrade success cue, padded workbench tap, mellow coin-like clink, and gentle sparkle confirm, cozy and rewarding, no harsh metal, no voice, about one second.",
  },
];

const enhancementBreakVariants: AudioPromptVariant[] = [
  {
    slug: "muffled-shatter-drop",
    label: "Muffled shatter drop",
    prompt:
      "Short item enhancement break sound, muffled ceramic and metal crack with a soft downward thud, disappointing but not painful, no glass shards flying, no voice, about one second.",
  },
  {
    slug: "failed-forge-crack",
    label: "Failed forge crack",
    prompt:
      "Brief fantasy crafting failure, warm metal ping collapsing into a muted crack and dusty settle, clear break feedback, not harsh or scary, no voice, no music, about one second.",
  },
];

const ambienceMeadowDayVariants: AudioPromptVariant[] = [
  {
    slug: "sunny-meadow-bed",
    label: "Sunny meadow bed",
    prompt:
      "Loopable cozy meadow daytime ambience bed, soft grass breeze, tiny distant birds, faint warm insects, peaceful starter field, very subtle under music, no melody, no vocals, seamless loop feel, about twenty seconds.",
  },
  {
    slug: "gentle-field-air",
    label: "Gentle field air",
    prompt:
      "Seamless loop-style fantasy meadow day ambience, light wind through grass and leaves, sparse soft birds far away, calm outdoor air, no music, no voice, no sudden sounds, about twenty seconds.",
  },
];

const ambienceDuskVariants: AudioPromptVariant[] = [
  {
    slug: "lantern-dusk-bed",
    label: "Lantern dusk bed",
    prompt:
      "Loopable cozy dusk ambience bed, quiet evening breeze, faint crickets, soft distant water and warm lantern-town air, subtle under music, no melody, no voice, no sudden sounds, about twenty seconds.",
  },
  {
    slug: "evening-field-hush",
    label: "Evening field hush",
    prompt:
      "Seamless loop-style fantasy evening field ambience, gentle night insects, low soft wind, distant peaceful town texture, calm and unobtrusive, no music, no voice, about twenty seconds.",
  },
];

const miningPickVariants: AudioPromptVariant[] = [
  {
    slug: "soft-pick-chip",
    label: "Soft pick chip",
    prompt:
      "Short mining pick strike, small metal pick chipping a stone ore node with a muted rock tick and dust, satisfying but quiet, no heavy clang, no voice, no music, under half a second.",
  },
  {
    slug: "stone-tap-chip",
    label: "Stone tap chip",
    prompt:
      "Brief cozy mining sound, light pickaxe tap on ore with a small crunchy stone chip, clean gathering feedback, not loud, no ringing metal, no voice, under half a second.",
  },
];

const chestOpenVariants: AudioPromptVariant[] = [
  {
    slug: "wooden-chest-lift",
    label: "Wooden chest lift",
    prompt:
      "Short treasure chest open sound, warm wooden lid lift with a soft hinge creak and tiny reward chime, cozy fantasy loot feedback, no harsh metal, no voice, about one second.",
  },
  {
    slug: "latch-pop-treasure",
    label: "Latch pop treasure",
    prompt:
      "Brief chest-opening cue, padded latch pop, wooden lid creak, and mellow bell glint, satisfying but not flashy, no glass sparkle, no voice, about one second.",
  },
];

const genericSfxVariants: AudioPromptVariant[] = [
  {
    slug: "soft-fantasy-ui",
    label: "Soft fantasy UI",
    prompt:
      "Short soft fantasy game sound effect, gentle chime and subtle texture, clean and repeatable, under one second, no voice, no music.",
  },
];

const approvedBatchTargets: Record<string, AudioPromptVariant[]> = {
  "monster/slime_squish/attack": slimeSquishAttackVariants,
  "monster/slime_squish/damage": slimeSquishDamageVariants,
  "monster/slime_squish/die": slimeSquishDieVariants,
  "monster/slime_squish/move": slimeSquishMoveVariants,
  "player/attack_swing": playerAttackSwingVariants,
  "world/item_pickup": itemPickupVariants,
  "world/portal_enter": portalEnterVariants,
  "player/level_up": levelUpVariants,
  "ui/click": uiClickVariants,
  "player/death_sting": deathStingVariants,
  // card-audio-ui-sfx.md — cozy UI sound pack (ui/click reused from z1, omitted).
  "ui/hover": uiHoverVariants,
  "ui/window_open": uiWindowOpenVariants,
  "ui/window_close": uiWindowCloseVariants,
  "ui/tab_switch": uiTabSwitchVariants,
  "ui/tooltip": uiTooltipVariants,
  "ui/equip": uiEquipVariants,
  "ui/unequip": uiUnequipVariants,
  "ui/coin": uiCoinVariants,
  "ui/buy_fail": uiBuyFailVariants,
  "ui/quest_accept": uiQuestAcceptVariants,
  "ui/quest_complete": uiQuestCompleteVariants,
  "ui/levelup": uiLevelUpVariants,
  "ui/jobup": uiJobUpVariants,
  "ui/toast": uiToastVariants,
  "ui/hint": uiHintVariants,
  "ui/drag_pick": uiDragPickVariants,
  "ui/drag_drop": uiDragDropVariants,
  "ui/map_open": uiMapOpenVariants,
  "ui/portal": uiPortalVariants,
  "stage/enter": stageEnterVariants,
  "stage/clear": stageClearVariants,
  "stage/fail": stageFailVariants,
  "boss/telegraph": bossTelegraphVariants,
  "boss/death": bossDeathVariants,
  "event/start": eventStartVariants,
  "event/end": eventEndVariants,
  "enhancement/success": enhancementSuccessVariants,
  "enhancement/break": enhancementBreakVariants,
  "ambience/meadow_day": ambienceMeadowDayVariants,
  "ambience/dusk": ambienceDuskVariants,
  "world/mining_pick": miningPickVariants,
  "world/chest_open": chestOpenVariants,
};

export function getPromptVariants(kind: AudioKind, target: string): AudioPromptVariant[] {
  const normalizedTarget = target.replace(/\\/g, "/").toLowerCase();

  if (kind === "bgm" && target === "mossgrove_edge") {
    return mossgroveBgmVariants;
  }

  if (kind === "sfx" && normalizedTarget === "player/enemy_hit_regular") {
    return playerEnemyHitRegularVariants;
  }

  if (kind === "sfx" && normalizedTarget === "player/enemy_hit_critical") {
    return playerEnemyHitCriticalVariants;
  }

  if (kind === "sfx" && normalizedTarget === "monster/crystal_bloop/move") {
    return crystalBloopSfxVariants;
  }

  if (kind === "sfx" && normalizedTarget === "monster/crystal_bloop/attack") {
    return crystalBloopAttackVariants;
  }

  if (kind === "sfx" && normalizedTarget === "monster/crystal_bloop/damage") {
    return crystalBloopDamageVariants;
  }

  if (kind === "sfx" && normalizedTarget === "monster/crystal_bloop/die") {
    return crystalBloopDieVariants;
  }

  if (kind === "sfx" && normalizedTarget.startsWith("crystal_bloop")) {
    return crystalBloopSfxVariants;
  }

  if (kind === "sfx" && approvedBatchTargets[normalizedTarget]) {
    return approvedBatchTargets[normalizedTarget];
  }

  return genericSfxVariants;
}
