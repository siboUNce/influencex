'use strict';

// Thai text has no required word separators. ASCII names must be whole tokens;
// punctuation (including username underscores) separates tokens. No fuzzy matching.
const BURIRAM_TOKEN = /บุรีรัมย์|(?:^|[^a-z0-9])buriram(?=$|[^a-z0-9])/i;
const hasBuriram = value => typeof value === 'string' && BURIRAM_TOKEN.test(value);

function classifyBuriramRelevance(candidate = {}) {
  const signals = [];
  let score = 0;
  const add = (source, points, snippet) => {
    score += points;
    signals.push({ code: 'BURIRAM_' + source.toUpperCase(), source, snippet: String(snippet).trim().slice(0, 80) });
  };
  if (hasBuriram(candidate?.username)) add('username', 100, candidate.username);
  if (hasBuriram(candidate?.display_name)) add('display_name', 90, candidate.display_name);

  const provenance = Array.isArray(candidate?.discovery_provenance) ? candidate.discovery_provenance : [];
  const refs = new Set(provenance.flatMap(entry => Array.isArray(entry?.local_evidence_refs) ? entry.local_evidence_refs : []));
  for (const [source, points] of [['bio', 80], ['caption', 45], ['hashtag', 35]]) {
    let count = 0;
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ref.startsWith(source + ':') || !hasBuriram(ref.slice(source.length + 1))) continue;
      add(source, points, ref);
      if (++count === 2) break;
    }
  }
  const query = provenance.find(entry => hasBuriram(entry?.query))?.query;
  if (query) add('discovery_query', 20, query);
  const strong = signals.some(signal => ['username', 'display_name', 'bio'].includes(signal.source)) || score >= 70;
  return { buriram_relevance: strong ? 'strong' : score > 0 ? 'related' : 'none', buriram_score: score, buriram_signals: signals };
}

module.exports = { classifyBuriramRelevance };
