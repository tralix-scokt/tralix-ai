/**
 * Safety and moderation check for image generation prompts.
 * Flags requests that violate content safety policies with clear refusal messages.
 */

const BLOCKED_PATTERNS: { category: string; regex: RegExp }[] = [
  {
    category: 'child safety',
    regex: /\b(csam|child\s*porn|pedophil|underage\s*(nude|porn|sex)|child\s*(sexual|exploitation))\b/i,
  },
  {
    category: 'explicit sexual content',
    regex: /\b(hardcore\s*porn|explicit\s*nudity|erotic\s*genitals|graphic\s*sexual\s*act|gangbang|bestiality)\b/i,
  },
  {
    category: 'extreme violence and gore',
    regex: /\b(decapitat|mutilat|severed\s*limbs|blood\s*gore|snuff\s*film|gory\s*corpse|torture\s*victim)\b/i,
  },
  {
    category: 'hate speech and harassment',
    regex: /\b(nazi\s*swastika|white\s*supremac|kkk\s*lynch|gas\s*chamber|hate\s*crime)\b/i,
  },
  {
    category: 'dangerous activities and weapons',
    regex: /\b(how\s*to\s*make\s*a\s*bomb|suicide\s*vest|pipe\s*bomb\s*instructions|nerve\s*agent|bioweapon)\b/i,
  },
];

export interface SafetyCheckResult {
  safe: boolean;
  category?: string;
  refusalMessage?: string;
}

export function checkImageSafety(prompt: string): SafetyCheckResult {
  const text = prompt.toLowerCase();
  for (const { category, regex } of BLOCKED_PATTERNS) {
    if (regex.test(text)) {
      return {
        safe: false,
        category,
        refusalMessage: `I cannot generate this image because the prompt violates safety policies regarding ${category}. Please modify your prompt.`,
      };
    }
  }
  return { safe: true };
}
