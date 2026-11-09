/** Local editorial order, not a universal booru taxonomy.
 * Identity comes from dictionary metadata; general tags use conservative rules.
 * Unknown tags (including custom training triggers) keep their original slots.
 * Classification normalizes spelling, but sorting never rewrites tag contents.
 */
const normalize = (tag: string): string => tag.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ')

// Match more specific categories before broad anatomy/hair words. The numeric
// rank is independent of rule priority (e.g. hair flower is clothing, not hair).
const RULES: readonly (readonly [number, RegExp])[] = [
  [2, /^(?:\d+\+?\s*(?:girls?|boys?|others?|people|persons?|females?|males?)|multiple (?:girls|boys|others|people)|solo|solo focus|no humans|couple|group)$/],
  [8, /^(?:masterpiece|(?:best|high|normal|low|worst|amazing|great) quality|(?:absurd|incredibly absurd|high|low|ultra high)res|[248]k|very aesthetic|aesthetic|detailed|highly detailed|ultra detailed|rating[: ](?:general|sensitive|questionable|explicit))$/],
  [8, /^(?:score \d+(?: up)?|(?:jpeg|compression) artifacts|blurry|pixelated|watermark|signature|artist name|text|english text|chinese text|japanese text)$/],
  [6, /^(?:close up|extreme close up|portrait|cowboy shot|upper body|lower body|full body|wide shot|long shot|facing viewer|profile|side view|back view|from (?:above|below|behind|side)|dutch angle|foreshortening|perspective|pov|cropped|out of frame|depth of field|bokeh|fisheye|symmetrical|centered composition)$/],
  [5, /^(?:looking (?:at|to|away|back|down|up|over|through)|head (?:tilt|turn)|hand(?:s)? (?:on|in|up|behind|between)|arm(?:s)? (?:up|behind|around|at)|leg(?:s)? (?:up|crossed|apart)|holding|reaching|pointing|leaning|sitting|standing|lying|kneeling|crouching|squatting|walking|running|jumping|dancing|hugging|kissing|waving|fighting|sleeping|eating|drinking)(?:\b.*)?$/],
  [5, /^(?:smile|smiling|grin|grinning|smirk|blush|blushing|light blush|laughing|crying|tears|angry|sad|happy|surprised|embarrassed|expressionless|serious|scared|nervous|pout|pouting|wink|winking|one eye closed|closed eyes|half closed eyes|parted lips|open mouth|closed mouth|tongue out|clenched teeth|v|peace sign)$/],
  [3, /^(?:ring light reflection|heart shaped pupils|star shaped pupils|slit pupils)$/],
  [4, /\b(?:hair (?:flower|ornament|ribbon|bow|clip|scrunchie|band)|hairclip|hairband|hairpin|headdress|headband|headwear|hat|cap|beret|crown|tiara|veil|glasses|eyewear|sunglasses|eyepatch|mask|jewelry|earrings?|necklace|choker|bracelet|bangle|ring|brooch|piercing|ribbon|bow|necktie|bowtie|scarf|collar|gloves?|sleeves?|cuffs?|shirt|blouse|t shirt|dress|skirt|pants|shorts|jeans|leggings|thighhighs|kneehighs|socks|stockings|pantyhose|tights|garter|boots?|shoes?|heels|sandals|slippers|uniform|sailor collar|serafuku|school uniform|suit|jacket|coat|cape|cloak|hoodie|sweater|cardigan|vest|apron|kimono|yukata|obi|armor|bodysuit|leotard|swimsuit|bikini|underwear|bra|panties|lingerie|belt|bag|backpack|purse|nude|naked|topless|bottomless|barefoot)\b/],
  [3, /\b(?:hair|bangs|ahoge|ponytail|twintails|braid|braids|bun|buns|eyes|pupils|eyelashes|eyebrows|heterochromia|skin|complexion|freckles|mole|scar|tattoo|facial mark|mark under eye|facepaint|makeup|lipstick|nail polish|nails|horns?|animal ears|cat ears|fox ears|wolf ears|rabbit ears|pointy ears|tail|tails|wings|fangs|breasts|chest|cleavage|nipples|areolae|navel|midriff|stomach|waist|hips|thighs|legs|ass|buttocks|muscles|muscular|slim|plump|petite|tall|short stature|mature female|young|child|elf|dark elf)\b/],
  [7, /\b(?:indoors|outdoors|background|scenery|landscape|sky|clouds|sunset|sunrise|night|day|dusk|dawn|sunlight|moonlight|backlighting|lighting|shadow|shadows|rain|snow|wind|fog|mist|stars|moon|sun|water|ocean|sea|beach|shore|river|lake|pool|underwater|forest|woods|tree|trees|grass|garden|flower|flowers|petals|mountain|mountains|city|street|road|building|buildings|room|bedroom|classroom|bathroom|kitchen|bed|chair|sofa|table|desk|window|door|floor|wall|curtains)\b/],
]

export function semanticTagRank(tag: string, categories: ReadonlyMap<string, number>): number | undefined {
  const key = normalize(tag)
  const category = categories.get(key)
  if (category === 3) return 0 // work / franchise
  if (category === 4) return 1 // character
  return RULES.find(([, pattern]) => pattern.test(key))?.[0]
}

/** Group only inside an existing semantic category. Compound accessory/action
 * tags must never be pulled into appearance just because they mention hair.
 * The broad category rules expose their matched subject (shirt, sky, etc.),
 * allowing modifiers to cluster without enumerating colors or lengths.
 */
function tagTopic(tag: string, rank: number | undefined): string {
  const key = normalize(tag)
  if (rank === 3) {
    if (/\b(?:hair|bangs|ahoge|ponytail|twintails|braids?|buns?)\b/.test(key)) return 'hair'
    if (/\b(?:eyes|pupils|eyelashes|eyebrows|heterochromia)\b/.test(key)
      || key === 'ring light reflection') return 'eyes'
  }
  if (rank === 4 && /\b(?:hair (?:flower|ornament|ribbon|bow|clip|scrunchie|band)|hairclip|hairband|hairpin)\b/.test(key)) {
    return 'hair accessories'
  }
  if (rank === 3 || rank === 4 || rank === 7) {
    const subjectRule = RULES.find(([category, pattern]) => category === rank && pattern.test(key))
    // Prefer the final subject in modifier phrases such as "night sky".
    return subjectRule ? key.match(new RegExp(subjectRule[1].source, 'g'))?.pop() ?? key : key
  }
  return key
}

export function organizeTags(tags: string[], categories: ReadonlyMap<string, number>): string[] {
  const firstInTopic = new Map<string, number>()
  const ranked = tags.map((tag, index) => {
    const rank = semanticTagRank(tag, categories)
    const topic = tagTopic(tag, rank)
    const groupKey = `${rank}:${topic}`
    if (!firstInTopic.has(groupKey)) firstInTopic.set(groupKey, index)
    return {
      tag, index, rank,
      groupIndex: firstInTopic.get(groupKey)!,
      base: normalize(tag) === topic,
    }
  })
  const sorted = ranked.filter((item) => item.rank !== undefined)
    .sort((a, b) => a.rank! - b.rank! || a.groupIndex - b.groupIndex
      || Number(b.base) - Number(a.base) || a.index - b.index)
  let cursor = 0
  const next = ranked.map((item) => item.rank === undefined ? item.tag : sorted[cursor++].tag)
  return next.every((tag, index) => tag === tags[index]) ? tags : next
}
